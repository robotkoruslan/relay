import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

type Client = WebSocket & {
  subs?: Set<number>;
  /** Cleared before each ping; a client that never ponged back is dropped on the next sweep. */
  alive?: boolean;
};

/** How often to ping. A dead peer is detected within two intervals. */
const HEARTBEAT_MS = 30_000;

const clients = new Set<Client>();
let wss: WebSocketServer | undefined;
let heartbeat: NodeJS.Timeout | undefined;

export function attachWs(server: Server): void {
  wss = new WebSocketServer({ server });

  wss.on('connection', (ws: Client) => {
    ws.subs = new Set();
    ws.alive = true;
    clients.add(ws);

    ws.on('pong', () => {
      ws.alive = true;
    });

    ws.on('message', (raw) => {
      try {
        const frame: unknown = JSON.parse(raw.toString());
        if (typeof frame !== 'object' || frame === null) return;
        const { type, conversationIds } = frame as { type?: unknown; conversationIds?: unknown };
        if (type === 'subscribe' && Array.isArray(conversationIds)) {
          ws.subs = new Set(conversationIds.map(Number).filter(Number.isInteger));
        }
      } catch {
        /* ignore malformed frames */
      }
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

/**
 * Sends to this process's own sockets only. Cross-instance fan-out is the bus's job; this is
 * what the bus subscription calls once an event arrives.
 */
export function deliverLocal(conversationId: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
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
