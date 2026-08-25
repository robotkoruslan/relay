import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { emit } from '../bus.ts';
import { callerIdFromUrl } from '../http/identity.ts';
import { participantConversationIds } from '../services/conversations.ts';

type Client = WebSocket & {
  userId?: number;
  subs?: Set<number>;
  /** Cleared before each ping; a client that never ponged back is dropped on the next sweep. */
  alive?: boolean;
  /** Last typing notice per conversation, for the server-side throttle. */
  lastTyping?: Map<number, number>;
};

/** How often to ping. A dead peer is detected within two intervals. */
const HEARTBEAT_MS = 30_000;

/**
 * Floor on how often one socket may announce typing. The client throttles too, but a client is
 * not something to rely on: without this, a hostile or buggy one could flood the bus and every
 * other client with one event per keystroke.
 */
const TYPING_MIN_INTERVAL_MS = 1000;

const clients = new Set<Client>();
let wss: WebSocketServer | undefined;
let heartbeat: NodeJS.Timeout | undefined;

export function attachWs(server: Server): void {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws: Client, req: IncomingMessage) => {
    // Browsers cannot set headers on a WebSocket handshake, so identity comes from the query
    // string. Same caveat as the HTTP header: stated, not proven. See http/identity.ts.
    const userId = callerIdFromUrl(req.url);
    if (userId === undefined) {
      ws.close(1008, 'userId is required');
      return;
    }

    ws.userId = userId;
    ws.subs = new Set();
    ws.alive = true;
    ws.lastTyping = new Map();
    clients.add(ws);

    ws.on('pong', () => {
      ws.alive = true;
    });

    ws.on('message', (raw) => {
      void handleFrame(ws, raw.toString());
    });

    // Without this a socket error surfaces as an uncaught exception and kills the process.
    ws.on('error', (err) => console.error('[ws] socket error', err.message));
    ws.on('close', () => clients.delete(ws));
  });

  wss.on('error', (err) => console.error('[ws] server error', err.message));

  // A peer that disappears without closing never fires 'close', so without a heartbeat those
  // entries accumulate for the lifetime of the process and are sent to forever.
  heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (ws.alive === false) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

async function handleFrame(ws: Client, raw: string): Promise<void> {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return; // malformed frames are ignored
  }
  if (typeof frame !== 'object' || frame === null) return;

  const { type } = frame as { type?: unknown };
  if (ws.userId === undefined) return;

  if (type === 'subscribe') {
    const { conversationIds } = frame as { conversationIds?: unknown };
    if (!Array.isArray(conversationIds)) return;
    const requested = new Set(conversationIds.map(Number).filter(Number.isInteger));
    try {
      // A socket used to be able to subscribe to any id and tail conversations it had no part
      // in. Intersecting with real membership makes the subscription list unforgeable.
      const allowed = await participantConversationIds(ws.userId);
      ws.subs = new Set(allowed.filter((id) => requested.has(id)));
    } catch (err) {
      console.error('[ws] could not resolve subscriptions', err);
    }
    return;
  }

  if (type === 'typing') {
    const { conversationId, active } = frame as { conversationId?: unknown; active?: unknown };
    const id = Number(conversationId);
    // Reuses the subscription set as the authorisation check: it was already intersected with
    // real membership, so a socket cannot announce typing into a conversation it is not in.
    if (!Number.isInteger(id) || !ws.subs?.has(id)) return;

    const stopping = active === false;
    if (!stopping) {
      const last = ws.lastTyping?.get(id) ?? 0;
      if (Date.now() - last < TYPING_MIN_INTERVAL_MS) return;
      ws.lastTyping?.set(id, Date.now());
    }

    await emit({ type: 'typing', conversationId: id, userId: ws.userId, active: !stopping });
  }
}

/**
 * Sends to this process's own sockets only. Cross-instance fan-out is the bus's job; this is
 * what the bus subscription calls once an event arrives.
 */
export function deliverLocal(
  conversationId: number,
  payload: unknown,
  options: { exceptUserId?: number } = {},
): void {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (options.exceptUserId !== undefined && ws.userId === options.exceptUserId) continue;
    if (ws.subs?.has(conversationId) && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

export function localClientCount(): number {
  return clients.size;
}

/**
 * Sends every client a Going Away close frame before the HTTP server shuts down. Without this,
 * server.close() waits on connections that by design never end.
 */
export async function closeWs(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  for (const ws of clients) {
    ws.close(1001, 'server shutting down');
  }
  clients.clear();

  const server = wss;
  if (!server) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
