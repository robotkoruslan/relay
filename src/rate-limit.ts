import crypto from 'node:crypto';
import { config } from './config.ts';
import { redis } from './bus.ts';

/**
 * Sliding-window rate limiting, shared across instances.
 *
 * A counter in process memory would not survive more than one instance, and a fixed window
 * (INCR + EXPIRE) permits a double burst across the boundary — five sends at t=9.9s and five
 * more at t=10.1s satisfies "5 per 10 seconds" while delivering ten in 200ms. A sorted set of
 * timestamps is the shape the requirement actually describes, and it makes Retry-After exact
 * rather than a guess: it is the time until the oldest entry leaves the window.
 *
 * The whole decision is one Lua script, so it is a single round trip and atomic on Redis's
 * single thread. Read-then-write from the application would race between instances.
 */
const SLIDING_WINDOW = `
local limit  = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]

-- Redis's clock, not the caller's: instances with skewed clocks must agree on the window.
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local used = redis.call('ZCARD', KEYS[1])

if used < limit then
  redis.call('ZADD', KEYS[1], now, member)
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, limit - used - 1, 0}
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local wait = window - (now - tonumber(oldest[2]))
if wait < 0 then wait = 0 end
return {0, 0, wait}
`;

interface RedisWithLimiter {
  slidingWindow(
    key: string,
    limit: number,
    windowMs: number,
    member: string,
  ): Promise<[number, number, number]>;
}

redis.defineCommand('slidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW });
const limiter = redis as unknown as RedisWithLimiter;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  /** The limiter could not be reached, so the request was allowed by default. */
  degraded: boolean;
}

export async function checkLimit(
  key: string,
  limit = config.rateLimitMax,
  windowMs = config.rateLimitWindowMs,
): Promise<RateLimitDecision> {
  try {
    // A unique member per attempt: ZADD with a repeated member updates a score instead of
    // adding an entry, which would undercount two sends inside the same millisecond.
    const [allowed, remaining, retryAfterMs] = await limiter.slidingWindow(
      key,
      limit,
      windowMs,
      crypto.randomUUID(),
    );
    return { allowed: allowed === 1, limit, remaining, retryAfterMs, degraded: false };
  } catch (err) {
    // Fail open. For a chat app, refusing every send because the limiter blinked is a worse
    // outage than a brief unthrottled window — the limiter protects against abuse, it is not
    // what makes the app correct. Loud, because silently unlimited is not something to discover
    // from a bill.
    console.error('[rate-limit] limiter unavailable, allowing request', err);
    return { allowed: true, limit, remaining: limit, retryAfterMs: 0, degraded: true };
  }
}

export function sendKey(userId: number, conversationId: number): string {
  // Per user *and* per conversation, so one noisy person cannot throttle a room, and one busy
  // room cannot throttle that person everywhere else.
  return `rl:send:${userId}:${conversationId}`;
}
