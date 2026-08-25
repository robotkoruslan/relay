# Plan

Findings this builds on: [`01-triage.md`](01-triage.md). Defect ids (D1…D13) refer to that file.

## Shape of the work

Two observations drive the sequencing.

**Everything needs an error path first.** D6 means any bug I introduce later shows up as a
silent hang rather than a stack trace. Async error handling and typed route boundaries come
before anything else, or the rest of the work is debugged blind.

**Three of the four features are one feature.** `multi-instance`, `rate-limiting` and
`typing-indicator` all reduce to "instances must share state". One Redis layer — a pub/sub bus
and an atomic counter — carries all three. So building all four is not four times the work; it
is one infrastructure piece plus three thin features, plus `search` standing alone.

## Phases

Each phase ends in a working app and its own commit(s), so the history reads as a sequence of
decisions rather than one dump.

### 1. Foundation
- `asyncHandler` wrapper + error middleware; `unhandledRejection` / `uncaughtException` logging;
  JSON 404 for unknown `/api/*`. **(D6)**
- Convert `src/routes/*.js` to `.ts`; type request inputs and DB rows; validate and coerce at
  the boundary — ids are integers, body and title have length caps.
- `GET /healthz` (checks MySQL + Mongo + Redis), graceful SIGTERM shutdown, `npm run typecheck`.

### 2. Data layer
- Idempotent migration runner; add `INDEX (conversation_id, id)` on `messages` and
  `INDEX (user_id, conversation_id)` on `conversation_participants`. **(D4)**
  A migration runner rather than only editing `init.sql`, because `init.sql` runs only on a
  virgin volume — the same trap that produces D3.
- `UNIQUE (conversation_id, client_id)`; on duplicate, return the existing message with `200`
  instead of inserting. NULL `client_id` stays permitted, since MySQL treats NULLs as distinct.
  Disable the send button while a send is in flight. **(D5)**
- Make the seed idempotent — upserts, no `deleteMany`. **(D3)**
- Compensate the dual write: if the Mongo insert fails, delete the MySQL row and return `503`,
  so a failed send fails visibly instead of persisting a permanently blank message. **(D2)**
- One `createdAt`, generated in the app, written to both stores and returned by both endpoints.
  **(D13)**
- Collapse the sidebar's 1+2N queries into one aggregate query. **(D11)**
- Keyset pagination on `GET /api/messages` (`?before=<id>&limit=`). **(D10)**

### 3. The hot path
- Replace `pbkdf2Sync` with a keyed `HMAC-SHA256`, key from env. **(D1)**

  Rejected alternative: keep pbkdf2 but use the async form. It stops blocking the event loop
  but still burns ~85 ms of CPU per message on a 4-thread libuv pool, which caps throughput
  near ~47 msg/s and starves DNS and filesystem work. The real defect is not "sync" — it is
  using a *password-hashing* primitive for message integrity. HMAC is the right tool:
  microseconds, and actually keyed, which the original was not.
- Commit the before/after benchmark rather than asserting the improvement.

### 4. Redis bus and multi-instance — `tasks/multi-instance.md`
- Redis client with two connections (a subscribed connection cannot issue other commands).
- On send: persist, then `PUBLISH` to `relay:events`. Every instance subscribes and fans out to
  its own sockets. The publisher does **not** also broadcast locally — delivery goes through the
  bus on every instance, so there is one code path and no double-delivery to reason about.
- Redis unavailable: do not fail the send, since the message is already durable. Log, degrade to
  local-only fan-out, and let the client's reconnect-refetch close the gap.
- WS liveness: server-side ping/pong with termination on missed pong, plus an `'error'` handler;
  client-side reconnect with exponential backoff that resubscribes *and* refetches, because
  messages missed while disconnected are not replayed by a pub/sub bus. **(D9)**
- No sticky sessions needed: a WebSocket is one long-lived connection that naturally pins to one
  instance, and once fan-out is global it no longer matters which one.
- Deliverable: a repro script that opens N sockets through Envoy, posts M messages through Envoy
  at `--scale api=3`, and asserts every socket saw all M. It must fail before this phase and
  pass after.

### 5. Rate limiting — `tasks/rate-limiting.md`
- Sliding-window log in Redis: one Lua script over a `ZSET` per `rl:{userId}:{conversationId}` —
  `ZREMRANGEBYSCORE` to evict, `ZCARD` to count, `ZADD` + `PEXPIRE` to admit. One round trip,
  executed atomically on a single-threaded server, so it is correct under concurrency and
  identical across instances.
- Rejected: `INCR` + `EXPIRE` fixed window — cheaper, but permits a 2× burst across the boundary
  (5 sends at t=9.9 s, 5 more at t=10.1 s). Rejected: token bucket — also fine, but "5 per 10
  seconds" *is* a sliding window, and the window gives an exact `Retry-After` (time until the
  oldest entry falls out) instead of an estimate.
- Take the timestamp from Redis's own clock inside the script, so instances with skewed clocks
  still agree on the window.
- Response: `429` with `Retry-After` in seconds, plus limit/window in the JSON body. Limits come
  from env, since the brief calls the numbers a ballpark.
- Redis unavailable: **fail open** with a loud log. For a chat app, refusing every send because
  the limiter blinked is a worse outage than a brief unthrottled window. Trade-off recorded
  rather than assumed.
- Surface it in the UI instead of dropping the send silently.
- Tests against the real Redis in compose: 5 admitted / 6th refused, `Retry-After` within
  bounds, two users independent, two conversations independent.

### 6. Identity and access
- Minimal caller identity (the frontend already tracks a user id) enforced on message read,
  message send, and WS subscribe. **(D8)**
  Explicitly a stand-in for authentication, documented as such — not a claim to have built auth.
  It has to land before search, or search becomes a way to read the entire corpus.
- Render the sidebar with `textContent`; validate title length server-side. **(D7)**

### 7. Search — `tasks/search.md`
- Mongo `text` index on `body`; `$text` query ranked by `textScore`, scoped to the caller's
  conversations, limit + snippet around the match. Titles joined from MySQL in one query.
- Response keeps the `{conversationId, conversationTitle, body}` contract the existing UI
  expects, so the frontend needs no changes; extra fields (`messageId`, `createdAt`) ride along
  for the click-through.
- Limits to state plainly: `$text` is stemmed and whole-word — no substring or prefix matching —
  and Mongo allows one text index per collection. Alternatives and why not: MySQL `FULLTEXT`
  (bodies live in Mongo), regex scan (unindexed, O(n)), Atlas Search / Elasticsearch (the real
  production answer, out of scope here).

### 8. Typing indicator — `tasks/typing-indicator.md`
- Rides the phase-4 bus, so it is multi-instance from the start rather than as a follow-up.
- Client throttles to one event per ~2 s (not per keystroke) and sends an explicit stop on
  submit or blur; server checks participation, publishes, fans out excluding the sender.
- Receivers expire each user's indicator after ~3 s, so a dropped stop event cannot leave
  "typing…" stuck on screen forever.
- Per-socket server-side throttle too, so the bus can't be flooded by a hostile client.

### 9. Persistent unread state
- `conversation_participants.last_read_message_id`; the sidebar computes unread server-side and
  opening a conversation advances the cursor. **(D12)**
- This is what makes "the unread dot keeps working across instances" a real property rather than
  an artefact of one tab's memory.

### 10. Write it up
`docs/` gets: a note per fix (what was wrong, how it showed up, what changed), an architecture
review covering the rough-edges list from triage, and a short reviewer's guide — how to run it,
how to reproduce each defect, how to verify each fix.

## Cost, honestly

The brief says a few focused hours is already a solid showing. This plan is well past that —
call it a long day's work. The phases are ordered so that stopping early still leaves something
coherent:

- **Phases 1–3** alone are a defensible submission: every confirmed defect on the critical path
  is fixed, with measurements.
- **Phase 4** adds the first feature and the infrastructure the rest sit on.
- **Phases 5, 7** are then cheap. **Phases 6, 8, 9** are polish that shows range.

## Deliberately not doing

- Real authentication, sessions, or password handling. Out of scope; phase 6 is a stand-in and
  says so.
- Swapping MongoDB out. The two-store split for one logical record is the thing I would most
  want to change — it buys no sharding or size relief here and costs atomicity on every write
  and a cross-engine join on every read. But undoing it is a rewrite, not a fix, so it goes in
  `docs/` as a recommendation with the reasoning, and phase 2 makes the existing shape safe.
- A queue or outbox for the dual write. Phase 2's compensation closes the common failure; the
  residual window is a crash between insert and compensating delete. The correct fix is a
  transactional outbox with a reconciliation sweep — noted, not built, and the residual window
  is stated rather than glossed over.
- Frontend rework. It gets the minimum needed to exercise the backend: escaping, reconnect,
  in-flight send state, the 429 path, and typing indicators.
