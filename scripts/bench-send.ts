/**
 * Measures send latency and, more importantly, whether sending starves everything else.
 *
 * The second number is the interesting one: it times a route that touches no database while
 * sends are in flight. If that number is not close to zero, the process is not waiting on I/O,
 * it is burning CPU on the event loop, and every other user on the instance pays for it.
 *
 *   docker compose exec api npx tsx scripts/bench-send.ts
 */

export {};

const BASE = process.env.BENCH_BASE ?? 'http://127.0.0.1:3000';
const CONVERSATION_ID = Number(process.env.BENCH_CONVERSATION ?? 1);
const SEQUENTIAL = Number(process.env.BENCH_SEQUENTIAL ?? 20);
const CONCURRENT = Number(process.env.BENCH_CONCURRENT ?? 10);

async function timed(run: () => Promise<Response>): Promise<number> {
  const started = performance.now();
  const res = await run();
  await res.arrayBuffer();
  if (!res.ok && res.status !== 200 && res.status !== 201) {
    throw new Error(`unexpected ${res.status} from ${res.url}`);
  }
  return performance.now() - started;
}

function send(label: string): Promise<Response> {
  return fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: CONVERSATION_ID,
      senderId: 1,
      body: `bench ${label}`,
      clientId: `bench-${label}`,
    }),
  });
}

/** A route with no database work at all, so its latency is pure event-loop availability. */
function idleRoute(): Promise<Response> {
  return fetch(`${BASE}/api/search?q=`);
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return `mean ${mean.toFixed(1)}ms  p50 ${at(0.5).toFixed(1)}ms  p95 ${at(0.95).toFixed(1)}ms  max ${at(1).toFixed(1)}ms`;
}

const stamp = Date.now();

const sequential: number[] = [];
for (let i = 0; i < SEQUENTIAL; i++) {
  sequential.push(await timed(() => send(`${stamp}-seq-${i}`)));
}
console.log(`sequential send  (n=${SEQUENTIAL})   ${stats(sequential)}`);

// Baseline for the idle route with nothing else happening.
const idleQuiet: number[] = [];
for (let i = 0; i < 5; i++) idleQuiet.push(await timed(idleRoute));
console.log(`idle route, quiet (n=5)         ${stats(idleQuiet)}`);

// Same route, sampled repeatedly while sends are in flight.
const flood = Array.from({ length: CONCURRENT }, (_, i) =>
  timed(() => send(`${stamp}-conc-${i}`)),
);
const idleUnderLoad: number[] = [];
const sampler = (async () => {
  for (let i = 0; i < 10; i++) idleUnderLoad.push(await timed(idleRoute));
})();
const concurrent = await Promise.all(flood);
await sampler;

console.log(`concurrent send  (n=${CONCURRENT})   ${stats(concurrent)}`);
console.log(`idle route, under load (n=10)   ${stats(idleUnderLoad)}   <-- event-loop starvation`);
