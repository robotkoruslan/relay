# The hot path — D1

Defect ids refer to [`../spec/01-triage.md`](../spec/01-triage.md).

## What was wrong

```js
const signature = crypto.pbkdf2Sync(body, 'relay-signing', 200000, 32, 'sha256')
```

200 000 rounds of SHA-256, synchronously, on the event loop, once per message.

Two separate problems live in that line.

**It blocked everything.** Node has one thread for JavaScript. While it derives a key it cannot
accept a connection, parse a request, or answer one. So the cost was never paid by the sender
alone — it was paid by everyone on the instance.

**It proved nothing.** A constant salt, no key, and the output stored next to the data it
supposedly protects. Anyone able to write the record could recompute the value. It was a
password-hashing primitive doing an integrity job, and doing it decoratively: nothing ever read
the field back.

## What changed

`HMAC-SHA256` keyed from `MESSAGE_SIGNING_KEY`. Keyed, so the tag cannot be forged by someone who
can only reach the database; and a single pass over the body, so it costs microseconds.

The key is required rather than defaulted — a signing key with a known fallback is not a signing
key. Signatures carry a `v2:` prefix so the algorithm can be replaced later without every
existing row suddenly failing verification.

The tag is also now *checked*, on read, which it never was before. It stays cheap enough to
afford: verification is a few microseconds per message.

## Rejected: keep pbkdf2, make it async

The obvious minimal fix is `crypto.pbkdf2` instead of `pbkdf2Sync`. It stops blocking the event
loop, and it is the wrong fix.

The work does not disappear, it moves to libuv's thread pool — four threads by default. At ~40ms
per send that caps throughput near 100 sends/second no matter how many cores the box has, and the
same pool serves DNS lookups and filesystem calls, so saturating it slows down work that has
nothing to do with sending messages. Raising `UV_THREADPOOL_SIZE` trades one ceiling for memory
and context switching.

More to the point, it would preserve the actual mistake. The defect is not that a key derivation
was synchronous; it is that a key derivation was there at all. pbkdf2 is deliberately slow
because slowness is the security property when the input is a password. For a message body it is
pure cost.

## Measured

`scripts/bench-send.ts`, same stack, same seed data, before and after. The last row is the one
that matters: it times `GET /api/search?q=` — a route that touches no database — while sends are
in flight. Its latency is pure event-loop availability.

|                                       | before  | after   |
|---------------------------------------|---------|---------|
| sequential send, mean                 | 39.0 ms | 9.8 ms  |
| sequential send, p95                  | 76.9 ms | 58.2 ms |
| 10 concurrent sends, mean             | 340.1 ms| 31.9 ms |
| 10 concurrent sends, p95              | 362.7 ms| 37.3 ms |
| idle route while quiet, mean          | 3.0 ms  | 3.7 ms  |
| **idle route under load, p95**        | **191.8 ms** | **10.1 ms** |

Before, ten concurrent sends served each other in a queue — 340ms mean for work that is a couple
of database round trips — and an unrelated request waited up to 191ms behind key derivations it
had nothing to do with.

After, the idle route under load (4.8ms mean) is indistinguishable from the same route with the
server idle (3.7ms). The event loop is free; sends now wait on the database, which is what they
should be waiting on.

## Tamper detection, end to end

Rewriting a body directly in Mongo, bypassing the application:

```
created message id 187
tampering with body of message 187 directly in mongo...
tampered body is served: "silently rewritten"
[messages] signature mismatch on message 187
```

The body is still returned — it is the only copy there is, and hiding it from the reader helps
nobody — but the mismatch is now recorded instead of passing unnoticed.

Legacy rows written under the old scheme produce no warnings, which is what the version prefix
buys:

```
warnings for seeded legacy row 1: 0
```

## Note on running the tests

The suite reads configuration, and from the next step onwards it will talk to Redis, so it is
meant to run inside the stack:

```
docker compose exec api npm test
docker compose exec api npm run typecheck
docker compose exec api npx tsx scripts/bench-send.ts
```
