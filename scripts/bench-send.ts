/**
 * Measures send latency and, more importantly, whether sending starves everything else.
 *
 * The last number is the interesting one: it times a route that touches no database while sends
 * are in flight. If that is not close to its idle value, the process is not waiting on I/O — it
 * is burning CPU on the event loop, and every other user on the instance pays for it.
 *
 *   docker compose exec api npx tsx scripts/bench-send.ts
 *
 * Sends rotate across the seeded users so a burst stays inside the per-user rate limit; a 429 is
 * waited out rather than treated as an error, since the limiter is not what is being measured.
 */

import { BASE, postMessage, withUser } from './probe.ts';

const SEQUENTIAL = Number(process.env.BENCH_SEQUENTIAL ?? 9);
const CONCURRENT = Number(process.env.BENCH_CONCURRENT ?? 6);
/** Seeded users, all made participants of the conversation this script creates. */
const USERS = [1, 2, 3];

async function timed(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

/** A route with no database work at all, so its latency is pure event-loop availability. */
async function idleRoute(): Promise<void> {
  const res = await fetch(`${BASE}/api/search?q=`, withUser(1));
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`idle route returned ${res.status}`);
}

function stats(samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return `mean ${mean.toFixed(1)}ms  p50 ${at(0.5).toFixed(1)}ms  p95 ${at(0.95).toFixed(1)}ms  max ${at(1).toFixed(1)}ms`;
}

const stamp = Date.now();

// Its own conversation, so the benchmark neither depends on nor pollutes the seeded ones.
const created = await fetch(
  `${BASE}/api/conversations`,
  withUser(USERS[0] ?? 1, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `bench ${stamp}`, participantIds: USERS }),
  }),
);
if (!created.ok) throw new Error(`could not create a conversation: ${created.status}`);
const { id: conversationId } = (await created.json()) as { id: number };
console.log(`benchmarking against conversation ${conversationId} as users ${USERS.join(', ')}\n`);

const send = (label: string, i: number) =>
  postMessage(USERS[i % USERS.length] ?? 1, conversationId, `bench ${label}`, `bench-${label}`);

// Baseline for the idle route with nothing else happening.
const idleQuiet: number[] = [];
for (let i = 0; i < 5; i++) idleQuiet.push(await timed(idleRoute));
console.log(`idle route, quiet      (n=5)    ${stats(idleQuiet)}`);

// The concurrent burst runs first, on fresh rate-limit quota. If it ran after the sequential
// phase it would spend its time waiting out a 429, and would measure the limiter rather than
// the send path.
const flood = Array.from({ length: CONCURRENT }, (_, i) =>
  timed(() => send(`${stamp}-conc-${i}`, i)),
);
const idleUnderLoad: number[] = [];
const sampler = (async () => {
  for (let i = 0; i < 10; i++) idleUnderLoad.push(await timed(idleRoute));
})();
const concurrent = await Promise.all(flood);
await sampler;

console.log(`concurrent send  (n=${String(CONCURRENT).padEnd(2)})     ${stats(concurrent)}`);
console.log(`idle route, under load (n=10)   ${stats(idleUnderLoad)}   <-- event-loop starvation`);

// Let the rate-limit window drain before spending more quota, so the sequential figures are
// send latency and not a queue behind Retry-After.
const drainMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10_000) + 500;
console.log(`\n(waiting ${drainMs}ms for the rate-limit window to drain)`);
await new Promise((r) => setTimeout(r, drainMs));

const sequential: number[] = [];
for (let i = 0; i < SEQUENTIAL; i++) {
  sequential.push(await timed(() => send(`${stamp}-seq-${i}`, i)));
}
console.log(`sequential send  (n=${String(SEQUENTIAL).padEnd(2)})     ${stats(sequential)}`);
