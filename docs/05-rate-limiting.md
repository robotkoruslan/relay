# Rate limiting

Task: [`../tasks/rate-limiting.md`](../tasks/rate-limiting.md).

Asked for: about 5 messages per 10 seconds per user per conversation, 429 with `Retry-After`,
per-user so one loud person does not throttle a room, and holding across more than one instance.

## Shape of the counter

A sorted set of send timestamps per `rl:send:{userId}:{conversationId}`, evaluated by one Lua
script: drop entries older than the window, count what is left, and either add an entry or report
how long until the oldest one ages out.

**Why not a fixed window** (`INCR` + `EXPIRE`, the cheapest option): it allows a double burst
across the boundary. Five sends at t=9.9s and five more at t=10.1s satisfies "5 per 10 seconds"
on paper while delivering ten messages in 200ms — which is the exact thing the task is trying to
prevent.

**Why not a token bucket:** it would work, but "5 per 10 seconds" *is* a sliding window, so the
window models the requirement directly. It also makes `Retry-After` exact — the time until the
oldest entry leaves — rather than an estimate derived from a refill rate.

**Why Lua rather than application code:** the decision has to be atomic. Read-then-write from
Node would let several instances all observe "0 used" and all admit a send. One script is one
round trip and runs on Redis's single thread, so concurrency cannot interleave. There is a test
for exactly this — 20 concurrent attempts against a limit of 5 admit exactly 5.

**Why Redis's own clock:** the script takes `now` from `TIME` rather than from the caller.
Instances with drifting clocks would otherwise disagree about where the window starts.

`ZADD` uses a fresh UUID as the member, because re-adding an existing member updates its score
instead of adding an entry — two sends inside the same millisecond would collapse into one and
undercount.

## End to end, across three instances

Through Envoy, so consecutive sends land on different instances:

```
user 1 sends 8 to conversation 1, through the proxy (so across instances):
  #1: 201  remaining: 4
  #2: 201  remaining: 3
  #3: 201  remaining: 2
  #4: 201  remaining: 1
  #5: 201  remaining: 0
  #6: 429  Retry-After: 10s
  #7: 429  Retry-After: 10s
  #8: 429  Retry-After: 10s
user 2, same conversation (must be unaffected): 201
user 1, different conversation (must be unaffected): 201
```

Keying on both user and conversation covers both directions of the requirement: one person
flooding a room cannot throttle the other people in it, and one busy room cannot throttle that
person everywhere else.

`Retry-After` is rounded up to whole seconds and floored at 1 — `Retry-After: 0` invites an
immediate retry that is certain to be refused too.

## When Redis is unavailable: fail open

The limiter allows the request and logs loudly.

This is a judgement call, so here is the reasoning. The limiter is protection against abuse, not
part of what makes the app correct: without it, the app still works. If it fails closed, a Redis
blip stops everyone from sending anything, which is a worse outage than a brief unthrottled
window. The log is deliberately noisy because "silently unlimited" is not a state to discover
later from a bill.

```
[rate-limit] limiter unavailable, allowing request
  Error: Stream isn't writeable and enableOfflineQueue options is false
```

For an endpoint where the limit is the security control rather than a courtesy — login attempts,
password reset — the opposite choice is correct. This is not one.

## A startup bug the tests found

The first test run failed with `degraded: true`, meaning the limiter could not reach Redis at all.
The cause was a race — ioredis connects asynchronously and `enableOfflineQueue` is off, so
commands issued during connect fail immediately — but chasing it surfaced something worse in
`connectBus`:

```js
await subscriber.subscribe(CHANNEL);   // rejects if Redis is not up yet
```

That await was at module scope, so it rejected during startup. With Redis down, verified against
the pre-fix code:

```
3 api  Restarting (1) 4 seconds ago
api-1 | Error: Stream isn't writeable and enableOfflineQueue options is false
api-1 | Node.js v22.23.2
```

All three instances in a crash loop — because an **optional** dependency was unavailable. The
same contradiction as the health-check mistake in the previous step: Redis was documented as
optional and treated as required.

Now the subscribe happens on every `ready` event, which covers the first connection and every
reconnect, and startup waits for readiness with a timeout but never fails on it:

```
[bus] command connection not ready after 5000ms, continuing degraded
[bus] subscriber not ready after 5000ms, continuing degraded
relay listening on :3000

GET  conversations: 200
POST message      : 201 | RateLimit-Remaining: 5
```

## Client

A dropped send with no explanation is worse than a slow one, so the 429 is surfaced: the typed
text is put back in the box rather than discarded, and the send button holds for as long as the
server asked with a visible countdown, instead of letting the user hammer into a wall of 429s.

## Known gaps

**The limit keys on the claimed sender.** `senderId` still comes from the request body, so a
client that wanted to evade the limit could simply vary it. The counter is correct; the identity
it counts is not yet trustworthy. That is the next step, and it is worth being explicit that rate
limiting without authentication is advisory rather than enforced.

**A deduplicated retry spends quota.** The limit is checked before the write, so it cannot yet
know the send will turn out to be a duplicate `clientId`. Checking first would cost a query on
every send to save quota on the rare retry, which is the wrong trade — but it does mean a client
retrying through a flaky network is charged twice.

**Bursts are not smoothed.** Five sends in 50ms are all allowed, then nothing for ten seconds.
That matches what was asked for. A token bucket with a slow refill would spread them out, if that
were ever wanted.

## Configuration

`RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`, since the brief called the numbers a ballpark. The
tests use a 500ms window so they stay fast.
