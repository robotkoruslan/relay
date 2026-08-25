# Data layer — stop losing data, stop scanning tables

Defect ids refer to [`../spec/01-triage.md`](../spec/01-triage.md).

## Schema changes now come from code, not `init.sql`

`docker/db/mysql.sql` only runs when MySQL initialises a fresh data directory. Adding an index
there looks like a change but leaves every already-running database exactly as it was — the same
trap that produced D3. So `mysql.sql` is left alone as the deployed baseline, and
`src/db/migrations.ts` owns everything after it, recorded in a `schema_migrations` table.

Two details that matter more than the migrations themselves:

- **Steps are individually idempotent.** DDL in MySQL commits implicitly and cannot be rolled
  back, so a crash part-way through leaves a migration applied but unrecorded. `ensureIndex`
  checks `information_schema.STATISTICS` first, because MySQL 8 has no
  `CREATE INDEX IF NOT EXISTS`.
- **A `GET_LOCK` advisory lock wraps the run.** Under `--scale api=3` three instances boot at
  once; without the lock they race to apply the same DDL and all but one fail.

## D4 — indexes for the queries that actually run

`messages` had only `PRIMARY(id)` while every hot query filters on `conversation_id`, and
`conversation_participants` is keyed `(conversation_id, user_id)`, which cannot serve the
sidebar's `WHERE user_id = ?` because `user_id` is not the leading column.

```
messages                   idx_messages_conversation_id  conversation_id,id
conversation_participants  idx_participants_user         user_id,conversation_id
messages                   uq_messages_client_id         conversation_id,client_id  UNIQUE
```

`(conversation_id, id)` serves all three shapes the app uses: the ascending transcript, the
descending `LIMIT 1` preview, and the count.

## D5 — a retry no longer creates a second message

`client_id` was generated per send by the client and written to the column, and then nothing
read it. Before:

```
same clientId posted twice -> ids 15, 16   (DUPLICATE)
```

The unique index makes the second insert fail with `ER_DUP_ENTRY`, which is not an error but the
answer: the message already exists. `createMessage` catches it, looks the message up and returns
it unchanged.

```
first send : 201 id 4
retry      : 200 id 4 -> SAME MESSAGE (deduped)
```

`200` rather than `201`, and no second WebSocket broadcast — the first send already delivered one.

The migration has to remove pre-existing duplicates before it can add the constraint; it logs
how many it deleted, keeping the earliest of each group. Their bodies stay behind in Mongo as
unreferenced documents, which is harmless but worth knowing.

The client also blocks a second submit while one is in flight. The server-side dedupe only helps
if the retry reuses the same `clientId`, and a fresh click generates a fresh one, so the two
fixes cover different halves of the problem.

## D3 — rebuilding the app no longer wipes the history

The seed opened with `deleteMany({})` on every boot, while MySQL's `init.sql` runs only on a
virgin volume. Upserting with `$setOnInsert` makes it additive, so the two stores cannot diverge.

Before, after a plain `docker compose up -d --force-recreate api`:

```
mysql_messages  16      mongo bodies: 3      -> 13 of 15 messages returned empty
```

After, the same operation:

```
before rebuild:  mysql messages: 124   mongo bodies: 124
seeded message bodies: 0 inserted, 3 already present
after  rebuild:  mysql messages: 124   mongo bodies: 124
conversation 2: 121 messages | empty bodies: 0
```

## D2 — a failed send fails instead of persisting a blank message

Nothing spanned the two stores, so a Mongo failure left a MySQL row with no body, rendered
forever as an empty bubble by `bodyById.get(r.id) ?? ''`.

There is no transaction available across two engines, so the write compensates: if the body
fails to store, the row is deleted and the send is rejected.

```
send with mongo down: 503 -> {"error":{"code":"service_unavailable",
                                       "message":"message could not be stored, please retry"}}
mysql rows before: 124      mysql rows after: 124      orphan row left: 0
[messages] body write failed for 126, send rejected MongoServerSelectionError: ...
```

**Residual window, stated plainly:** if the process dies between the insert and the compensating
delete, the orphan survives. Closing that properly needs a transactional outbox and a
reconciliation sweep; the honest fix is not to split one logical record across two stores at all.
Both are covered in the architecture review that closes this series.

Also note the auto-increment gap — id 126 was consumed by the rejected send. Message ids were
never contiguous (a rollback burns one either way), so nothing should assume they are.

## D13 — one clock

`created_at` was second-precision and filled by MySQL, while the POST response returned the
application's own `new Date()`. The two disagreed, so a message moved in time on reload.

Now one timestamp is generated at the point of the write and used for both stores and the
WebSocket payload, the column is `TIMESTAMP(3)`, and the pool is pinned to `timezone: 'Z'` so a
row does not read back differently depending on where the process runs.

```
POST createdAt : 2026-08-25T14:09:10.945Z
GET  createdAt : 2026-08-25T14:09:10.945Z -> IDENTICAL
```

## D11 — the sidebar is one query

It was `1 + 2N` round trips, each a full scan. Correlated subqueries push the work into the
database, where the new index serves it: a backward seek for the newest id, an index-only scan
for the count.

Measured `Com_select` per sidebar render (the extra one is the measuring connection):

```
2 conversations  -> 2
10 conversations -> 2
```

Constant. The old shape would have been 21 statements at 10 conversations.

**Not fixed, and worth naming:** `COUNT(*)` per conversation is still proportional to that
conversation's length, even served from the index. A conversation with a million messages will
feel it. The real answer is a maintained counter updated on write, which is a schema and
consistency decision rather than a query rewrite, so it stays a recommendation.

## D10 — the transcript is paginated

`GET /api/messages` returned an entire conversation and passed every id it had just fetched into
a Mongo `$in`. It now takes `before` and `limit` and returns `{ messages, nextBefore }`.

Keyset pagination on the primary key rather than `OFFSET`: it stays cheap on deep pages, and it
cannot skip or repeat rows when new messages arrive mid-scroll.

```
page 1: 50 msgs, first "message number 71",  last "message number 120", nextBefore 76
page 2: 50 msgs, first "message number 21",  last "message number 70",  nextBefore 26
page 3: 21 msgs, first "Notes from the design sync…",                   nextBefore null
total unique ids across pages: 121 of 121
limit=9999 -> 121 rows   (clamped at 200)
```

`limit` clamps rather than rejects, so an over-eager client gets a page instead of an error.

The frontend gained a "Load older messages" control and keeps the reader's scroll position when
prepending, instead of snapping to the top.

## Still open

The blocking `pbkdf2Sync` on every send, in-process-only WebSocket fan-out, no rate limiting, no
authorisation, XSS via the conversation title, and no reconnect on the client.
