/**
 * Does a message reach every connected client when the app runs as several instances?
 *
 * Both the WebSocket connections and the POSTs go through Envoy, which round-robins, so the
 * clients end up spread across instances and so do the sends. That is the whole point: a client
 * on instance A has to see a message that was posted to instance C.
 *
 *   docker compose up -d --scale api=3
 *   docker compose exec api npx tsx scripts/check-fanout.ts
 *
 * Exits non-zero if any client missed anything.
 */

import { WebSocket } from 'ws';

const BASE = process.env.CHECK_BASE ?? 'http://envoy:3000';
const CLIENTS = Number(process.env.CHECK_CLIENTS ?? 6);
const MESSAGES = Number(process.env.CHECK_MESSAGES ?? 8);
const CONVERSATION_ID = Number(process.env.CHECK_CONVERSATION ?? 1);
const SETTLE_MS = Number(process.env.CHECK_SETTLE_MS ?? 2000);

interface Client {
  index: number;
  socket: WebSocket;
  received: Set<number>;
}

function open(index: number): Promise<Client> {
  const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/`);
  const client: Client = { index, socket, received: new Set() };

  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString()) as { type?: string; id?: number };
    if (event.type === 'message' && typeof event.id === 'number') client.received.add(event.id);
  });

  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', conversationIds: [CONVERSATION_ID] }));
      resolve(client);
    });
  });
}

const clients = await Promise.all(Array.from({ length: CLIENTS }, (_, i) => open(i)));
// The subscribe frame has no acknowledgement, so give it a moment to be processed.
await new Promise((r) => setTimeout(r, 300));
console.log(`${clients.length} clients connected through ${BASE}`);

const stamp = Date.now();
const sentIds: number[] = [];
const servedBy = new Map<string, number>();

for (let i = 0; i < MESSAGES; i++) {
  const res = await fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: CONVERSATION_ID,
      senderId: 1,
      body: `fan-out probe ${i}`,
      clientId: `fanout-${stamp}-${i}`,
    }),
  });
  const instance = res.headers.get('x-relay-instance') ?? 'unknown';
  servedBy.set(instance, (servedBy.get(instance) ?? 0) + 1);
  const message = (await res.json()) as { id: number };
  sentIds.push(message.id);
}

console.log(
  `${MESSAGES} messages posted, spread over ${servedBy.size} instance(s): ` +
    [...servedBy.entries()].map(([id, n]) => `${id}=${n}`).join(' '),
);

await new Promise((r) => setTimeout(r, SETTLE_MS));

let missing = 0;
for (const client of clients) {
  const absent = sentIds.filter((id) => !client.received.has(id));
  const status = absent.length === 0 ? 'all' : `${client.received.size}/${MESSAGES}  MISSED ${absent.length}`;
  console.log(`  client ${client.index}: ${status}`);
  missing += absent.length;
}

for (const client of clients) client.socket.close();

if (servedBy.size < 2) {
  console.log('\nNOTE: every send landed on one instance, so this run did not exercise fan-out.');
  console.log('      Start the stack with `docker compose up -d --scale api=3` first.');
}

if (missing > 0) {
  console.log(`\nFAIL: ${missing} message deliveries missing across ${CLIENTS} clients`);
  process.exit(1);
}
console.log(`\nPASS: all ${CLIENTS} clients received all ${MESSAGES} messages`);
