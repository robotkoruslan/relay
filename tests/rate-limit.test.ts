import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { busReady, closeBus } from '../src/bus.ts';
import { checkLimit, sendKey } from '../src/rate-limit.ts';

/**
 * Run against the real Redis from docker-compose, not a mock. The whole point of the limiter is
 * that the decision is atomic inside Redis; a mock would only verify the shape of my own
 * assumptions.
 *
 *   docker compose exec api npm test
 */

const WINDOW_MS = 500;

/** Fresh key per test, so a rerun is not throttled by the previous one. */
function key(): string {
  return `test:rl:${crypto.randomUUID()}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ioredis connects asynchronously and enableOfflineQueue is off, so a command issued before
// the connection is up fails immediately and the limiter correctly fails open. Tests must not
// race that.
before(async () => {
  assert.equal(await busReady(), true, 'redis must be reachable to run this suite');
});

after(async () => {
  await closeBus();
});

describe('checkLimit', () => {
  it('admits exactly the limit, then refuses', async () => {
    const k = key();
    for (let i = 1; i <= 3; i++) {
      const decision = await checkLimit(k, 3, WINDOW_MS);
      assert.equal(decision.allowed, true, `attempt ${i} should be allowed`);
      assert.equal(decision.degraded, false, 'redis should be reachable in this suite');
    }
    const refused = await checkLimit(k, 3, WINDOW_MS);
    assert.equal(refused.allowed, false);
  });

  it('counts remaining down to zero', async () => {
    const k = key();
    assert.equal((await checkLimit(k, 3, WINDOW_MS)).remaining, 2);
    assert.equal((await checkLimit(k, 3, WINDOW_MS)).remaining, 1);
    assert.equal((await checkLimit(k, 3, WINDOW_MS)).remaining, 0);
  });

  it('reports a retry delay inside the window, never zero-length', async () => {
    const k = key();
    for (let i = 0; i < 2; i++) await checkLimit(k, 2, WINDOW_MS);
    const refused = await checkLimit(k, 2, WINDOW_MS);
    assert.equal(refused.allowed, false);
    assert.ok(refused.retryAfterMs > 0, `expected a positive delay, got ${refused.retryAfterMs}`);
    assert.ok(
      refused.retryAfterMs <= WINDOW_MS,
      `delay ${refused.retryAfterMs} should not exceed the window`,
    );
  });

  it('lets the window slide rather than resetting on a fixed boundary', async () => {
    const k = key();
    await checkLimit(k, 2, WINDOW_MS);
    await sleep(WINDOW_MS * 0.6);
    await checkLimit(k, 2, WINDOW_MS);

    // Two used, so the next is refused...
    assert.equal((await checkLimit(k, 2, WINDOW_MS)).allowed, false);

    // ...but once the *first* one ages out, a slot frees up without the second having to.
    await sleep(WINDOW_MS * 0.5);
    assert.equal((await checkLimit(k, 2, WINDOW_MS)).allowed, true);
  });

  it('isolates users from each other', async () => {
    const noisy = sendKey(1001, 7);
    const quiet = sendKey(1002, 7);
    for (let i = 0; i < 3; i++) await checkLimit(noisy, 3, WINDOW_MS);

    assert.equal((await checkLimit(noisy, 3, WINDOW_MS)).allowed, false);
    // One person flooding a conversation must not throttle everyone else in it.
    assert.equal((await checkLimit(quiet, 3, WINDOW_MS)).allowed, true);
  });

  it('isolates conversations from each other', async () => {
    const busyRoom = sendKey(1003, 8);
    const otherRoom = sendKey(1003, 9);
    for (let i = 0; i < 3; i++) await checkLimit(busyRoom, 3, WINDOW_MS);

    assert.equal((await checkLimit(busyRoom, 3, WINDOW_MS)).allowed, false);
    // Same user, different conversation: still allowed.
    assert.equal((await checkLimit(otherRoom, 3, WINDOW_MS)).allowed, true);
  });

  it('holds under concurrent attempts, not just sequential ones', async () => {
    // Read-then-write from the application would let several of these all observe "0 used".
    const k = key();
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => checkLimit(k, 5, WINDOW_MS)),
    );
    const allowed = decisions.filter((d) => d.allowed).length;
    assert.equal(allowed, 5, `expected exactly 5 of 20 concurrent attempts to pass, got ${allowed}`);
  });
});

describe('sendKey', () => {
  it('separates user and conversation', () => {
    assert.notEqual(sendKey(1, 2), sendKey(2, 1));
  });
});
