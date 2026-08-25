# What I would change, and why

The brief asked for this explicitly: *"Anything you'd just do differently — do it (or note it)."*
Everything I could fix inside the scope of the exercise is fixed and documented in the notes
alongside this one. This file is the rest — the things that are a rewrite rather than a fix, or a
decision that is not mine to make.

Ordered by how much I think they matter.

---

## 1. One logical record should not live in two databases

This is the thing I would change first, and it is the root of several separate symptoms.

A message is one fact. Right now its metadata is a MySQL row and its text is a MongoDB document,
joined by using the MySQL `AUTO_INCREMENT` value as the Mongo `_id`.

What that costs:

- **No atomicity.** No transaction can span the two, so every write is two writes that can
  disagree. That was D2: a failed body write left a row that rendered as an empty bubble forever.
  I made it compensate — delete the row, fail the send — which closes the common case but leaves a
  window if the process dies between the two operations.
- **Every read is a cross-engine join.** `GET /api/messages` fetches rows from MySQL, then
  fetches bodies from Mongo by id, then stitches them in application code. Same for search, in
  reverse.
- **Two failure domains for one feature.** Either store being down breaks reading messages.
- **Two backup and restore stories** that have to be consistent with each other to be worth
  anything. Restoring one to a point in time and not the other produces exactly D3, permanently.

What it buys, as far as I can tell: nothing here. There is no sharding, the bodies are not large
enough to pressure row size, and MongoDB's text index is the only genuine advantage — which is a
reason to use a search engine, not a reason to split the record.

**What I would do:** move `body` into MySQL as `TEXT` alongside the rest of the row. One
transactional write, no join, one backup. If full-text search matters, index into a real search
engine (see §5) — which you would want regardless, since Mongo `$text` cannot do prefix matching.

**Why I did not do it here:** it is a data migration plus a rewrite of every read path, and the
two-store shape looked deliberate in an exercise that mentions both databases in its compose file.
Guessing wrong about that is expensive. So the existing shape is made safe instead, and this is
the recommendation.

---

## 2. The dual write needs an outbox, not a compensating delete

Given §1 is not happening immediately, the residual window in the current fix is worth naming
precisely: `createMessage` inserts the row, and if the body write fails it deletes the row. If the
process dies between those two, the orphan survives.

The standard fix is a transactional outbox:

1. In one MySQL transaction, insert the message *and* an outbox row describing the body write.
2. A worker drains the outbox, writing bodies to Mongo, and marks entries done.
3. A reconciliation sweep finds rows whose bodies never landed and either completes or removes
   them.

That makes the write atomic where it matters — the transaction — and eventually consistent where
it does not. It also gives a natural place to put the WebSocket publish, which today happens after
the write and would be lost if the process died at exactly the wrong moment.

I did not build it because a background worker plus a sweep is a lot of machinery for an exercise,
and it would be building infrastructure to support a design I am arguing against in §1.

---

## 3. Counts are computed on every read

`messageCount` and `unreadCount` are both `COUNT(*)` over a range of `(conversation_id, id)`. The
index makes them index-only scans rather than table scans, which is the difference between
unusable and fine — but they are still proportional to conversation length and to how far behind
a reader is. A conversation with a million messages will feel it on every sidebar render.

**What I would do:** maintain counters. A `conversations.message_count` incremented in the same
transaction as the insert, and unread derived from `message_count` minus a per-participant
counter, or a `conversation_participants.unread_count` maintained on write.

**Why not now:** it is a consistency decision, not a query rewrite. Maintained counters can drift,
so they need a periodic reconciliation job, and picking where to put the increment depends on §1
and §2. Doing it before those is building on sand.

---

## 4. `x-user-id` is not authentication

Stated plainly in [`06-access.md`](06-access.md) and at the top of `src/http/identity.ts`, but it
belongs on this list too. The access checks are real; the identity they check is asserted by the
caller.

The consequence worth repeating: rate limiting keys on that identity, so it is advisory rather
than enforced. A client that wanted to evade the limit could vary the header.

**What I would do:** sessions or signed tokens, with `callerId()` reading from that. Nothing
downstream changes — that was the point of putting it behind one function. Then a real `users`
table with credentials handled properly, and authorisation on conversation creation, which
currently lets any caller add any user ids as participants.

---

## 5. Search should not be a database feature

Mongo `$text` is a reasonable fit for the exercise and a poor fit for a chat search box. It is
word-based and stemmed: no substring matching, no prefix matching, so nothing happens as you type
and a partial word finds nothing. One text index per collection means titles and bodies cannot
both be searched. There is no highlighting, no fuzzy matching, no per-language analyzers.

**What I would do:** index messages into OpenSearch, Elasticsearch, or Atlas Search — fed from the
outbox in §2, which is the natural place for it. Prefix and fuzzy matching, real highlighting,
faceting by conversation and sender.

That is another service to run, which is why it is a recommendation and not a commit.

---

## 6. Nothing here can be observed

There are no metrics, no traces, and logging is `console.log` with a hand-rolled incident id.

For an app whose defining problem was "it misbehaves under real traffic", that is the gap that
matters most operationally. Every defect in the triage was found by constructing a load pattern by
hand. In production, the event-loop starvation from D1 would have shown up as a p99 latency graph
that made no sense, with nothing to explain it.

**What I would add, roughly in order:**

- Structured JSON logs with a request id propagated through the request, so the incident id in a
  500 response can be joined to everything else that request did.
- Prometheus metrics: request duration by route and status, WebSocket connection gauge, bus
  publish and receive counters, rate-limit rejections, and event-loop lag — that last one would
  have made D1 obvious without a benchmark.
- OpenTelemetry traces spanning HTTP, MySQL, Mongo and Redis. The cross-engine join in §1 is
  exactly the shape that is hard to reason about without a trace.
- Alerting on the health check already there, plus on `[bus] publish failed` and
  `[rate-limit] limiter unavailable`, since both are silent degradations by design.

---

## 7. Test coverage stops at the unit boundary

43 tests, all unit-level: validation, signing, the snippet builder, and the rate limiter — the last
against a real Redis, because the point of it is atomicity.

What is missing is the layer above. The behaviour I care most about is verified by scripts I ran by
hand and pasted into these notes: `scripts/check-fanout.ts` for cross-instance delivery,
`scripts/bench-send.ts` for the event loop, and ad-hoc probes for access control and read cursors.
That is evidence, but it is not a suite, and nothing stops a regression.

Concretely, and while building this: requiring an identity broke both of those scripts — the
WebSocket handshakes were rejected and every POST returned 400 — and nothing caught it. I only
found out by re-running them before finishing. Adding rate limiting then broke the benchmark a
second time, in a subtler way: the concurrent phase spent its time waiting out a `Retry-After`
and reported 10-second "send latency". Both are exactly the regressions a CI job running these
two scripts would have caught the moment they appeared.

**What I would add:**

- HTTP-level integration tests against the compose stack: the access-control matrix in
  [`06-access.md`](06-access.md) is a table of assertions written in prose that should be a test
  file.
- `check-fanout.ts` turned into a test and run in CI at `--scale api=3`. It already exits
  non-zero.
- A migration test: apply from empty, apply twice, assert idempotence. The advisory lock and the
  `ensureIndex` guards are exactly the code that is never exercised until it fails at 3am.
- Playwright for the flows that only exist in the browser: reconnect-and-resync, the 429
  countdown, jump-to-search-result, the typing indicator expiring.
- CI running `typecheck`, `test` and a lint step. There is no linter configured at all.

---

## 8. Dev and production are the same image, and neither is right

`docker-compose.yml` bind-mounts `./:/app` over the image contents and layers an anonymous volume
on `node_modules`. That is a dev convenience, and it is the reason scaling to three instances
failed with `Cannot find package 'ioredis'` — see
[`04-multi-instance.md`](04-multi-instance.md). The image and a running container drift apart the
moment dependencies change.

**What I would do:** a multi-stage Dockerfile producing a compiled artifact with production
dependencies only, running as a non-root user, and a separate compose override for development
that adds the bind mount. Also: `tsx` transpiles on every boot, which is fine for development and
not what should be shipped.

Adding `package-lock.json` and `npm ci` fixed reproducibility, which was the part actively causing
problems.

---

## 9. Smaller things, worth naming

- **No foreign keys.** `messages.conversation_id`, `messages.sender_id` and
  `conversation_participants` reference nothing. Membership checks now stop most orphans at the
  application boundary, but the database will still happily accept a message for a deleted
  conversation. There is also no defined behaviour for deleting a user or a conversation.
- **Redis is a single node with default persistence.** Pub/sub is at-most-once by design: an event
  published during a blip is simply gone for other instances. The client's reconnect-and-refetch
  covers it, which is a deliberate trade rather than an accident, but it should be a conscious one.
  The rate limiter's state is also purely in Redis, so a flush resets every window.
- **No WebSocket backpressure handling.** `ws.send()` is called without checking `bufferedAmount`.
  A slow consumer subscribed to a busy conversation will grow an unbounded send buffer in the
  server process.
- **No TLS anywhere,** and Envoy has no access logging, so there is no record of what the proxy
  actually did.
- **Secrets come from `.env`.** Fine for local development, wrong past that: `MESSAGE_SIGNING_KEY`
  and the database credentials belong in a secret manager, and the signing key needs a rotation
  path — the `v2:` prefix on signatures is there so that is possible without invalidating existing
  rows.
- **The frontend is a single unbundled script with `const userId = 1`.** It is a harness for
  exercising the API, and I kept it that way deliberately rather than introducing a build step and
  a framework into an exercise that is about the backend. It should not be mistaken for a
  frontend.

---

## What I deliberately left alone

- **The two-database shape** — §1 explains the argument and why making it safe was the better call
  than rewriting it on a guess.
- **The `signature` field.** I could not tell what it was for, and the honest options were to
  delete it or make it correct. Deleting a feature whose purpose I do not know is the more
  arrogant choice, so it became a keyed HMAC that is actually verified, at a cost of microseconds.
- **The UI's visual design.** Changes there are in service of a backend behaviour — reconnect
  state, the 429 countdown, jumping to a search result, the typing line. Nothing cosmetic.
- **`docker/db/mysql.sql`.** Left as the deployed baseline, with all schema evolution in
  migrations, because editing it changes nothing for an existing database while appearing to.
  That mismatch is what caused D3.
