import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

type Client = WebSocket & { subs?: Set<number> };

const clients = new Set<Client>();
let wss: WebSocketServer | undefined;

export function attachWs(server: Server): void {
  wss = new WebSocketServer({ server });
  wss.on('connection', (ws: Client) => {
    ws.subs = new Set();
    clients.add(ws);
    ws.on('message', (raw) => {
      try {
        const m: unknown = JSON.parse(raw.toString());
        if (
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: unknown }).type === 'subscribe' &&
          Array.isArray((m as { conversationIds?: unknown }).conversationIds)
        ) {
          const ids = (m as { conversationIds: unknown[] }).conversationIds;
          ws.subs = new Set(ids.map(Number).filter(Number.isInteger));
        }
      } catch {
        /* ignore malformed frames */
      }
    });
    // Without this a socket error propagates as an uncaught exception and kills the process.
    ws.on('error', (err) => console.error('[ws] socket error', err));
    ws.on('close', () => clients.delete(ws));
  });
  wss.on('error', (err) => console.error('[ws] server error', err));
}

export function broadcast(conversationId: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.subs?.has(conversationId) && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

/**
 * Sends every client a Going Away close frame before the HTTP server shuts down. Without this,
 * `server.close()` waits on connections that by design never end.
 */
export async function closeWs(): Promise<void> {
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
