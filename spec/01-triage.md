# Triage — what I found before writing any code

First pass: read every file, boot the stack, then try to *break* it. Everything below is
reproduced against the running app, not inferred from reading. Commands and observed output
are included so they can be re-run.

Environment note: on my machine host port 3000 was already taken by an unrelated container, so
the probes below run inside the compose network (`docker compose exec -T api node -e ...`)
rather than from the host. Nothing about the app needed changing for that.

---

## Confirmed defects

### D1 — Every message send blocks the event loop for ~85ms

`src/services/messages.ts:15`

```js
const signature = crypto.pbkdf2Sync(body, 'relay-signing', 200000, 32, 'sha256')
```

200 000 rounds of SHA-256, synchronously, on the event loop, once per message.

Measured:

| probe | result |
|---|---|
| single `POST /api/messages` | **89 ms** |
| 10 concurrent `POST` | **376–396 ms each** — fully serialised |
| `GET /api/search?q=zzz` (touches no DB) fired during that flood | **163 ms** |

That last row is the tell: a route that does literally nothing takes 163 ms, because the
process is not idle — it is grinding key derivations. One sender degrades latency for every
other user on the instance. This is the "doesn't survive real traffic" symptom.

Second, quieter problem: this is not a signature. Constant salt, no secret key, and the output
is stored next to the data it "protects" — anyone who can write the record can recompute the
value. It buys nothing.

### D2 — Non-atomic dual write loses message bodies

`src/services/messages.ts:19-33` inserts the row into MySQL, then the body into MongoDB, with
no transaction and no compensation. Two stores, no atomicity, no recovery.

If the Mongo write fails or the process dies between the two, MySQL keeps a row whose body does
not exist. `GET /api/messages` papers over it with `bodyById.get(r.id) ?? ''`, so the message
renders forever as an empty bubble. Nothing detects it; nothing repairs it.

### D3 — Rebuilding the app silently blanks the message history

`docker/db/seed.ts:5` runs `deleteMany({})` on every boot. MySQL's `init.sql` only runs on a
fresh data directory. The two seeds have opposite idempotency semantics, so any restart that
re-runs the seed container without recreating MySQL's volume desynchronises the two stores.

Reproduced:

```
$ docker compose up -d --force-recreate api      # i.e. a normal rebuild
mysql_messages  16
mongo bodies :   3
$ GET /api/messages?conversationId=1
messages: 15 | empty bodies: 13
```

13 of 15 messages came back blank. Every message anyone had sent lost its text.

### D4 — No index supports any query the app actually runs

```
$ SHOW INDEX FROM messages
messages  PRIMARY  id        <- that is the entire list
```

Every hot query filters on `conversation_id`:

- `WHERE conversation_id = ? ORDER BY id ASC` — message list
- `WHERE conversation_id = ? ORDER BY id DESC LIMIT 1` — sidebar preview
- `COUNT(*) WHERE conversation_id = ?` — sidebar counter

All three are full table scans. And `conversation_participants` is keyed
`(conversation_id, user_id)`, so the sidebar's `WHERE p.user_id = ?` cannot use the primary key
either — it can't seek on a non-leading column. Fine at 16 rows, quadratic-feeling at 10M.

### D5 — `client_id` is plumbed end-to-end and then ignored, so sends duplicate

The column exists, the frontend generates a fresh UUID for every send, the insert stores it —
and nothing ever reads it. There is no unique constraint and no dedupe.

```
same clientId posted twice -> ids 15, 16   (DUPLICATE)
```

Any retry, double-click, or flaky-network resend creates a second message. D1 makes this much
more likely in practice: sends take 89–390 ms with no in-flight feedback in the UI, which is
exactly the window in which people click again.

### D6 — One failed dependency call takes down the whole instance

No `try/catch` in any route, no error middleware, no `unhandledRejection` handler. Express 4
does not catch rejections from `async` handlers, and nothing else does either.

Reproduced with Mongo stopped, `GET /api/messages?conversationId=1`:

```
client err after 30120 ms: fetch failed
api logs: MongoNetworkError: getaddrinfo ENOTFOUND mongo
          ...
          Node.js v22.23.2            <- process died
api container state: Up Less than a second   <- restarted by `restart: on-failure`
```

The full sequence is worse than a hang:

1. The request stalls for **30 s** — the Mongo driver's default `serverSelectionTimeoutMS` —
   during which the client gets nothing and no timeout of our own applies.
2. The promise then rejects. With no handler anywhere, Node's default behaviour for an unhandled
   rejection applies: **the process exits.**
3. `restart: on-failure` brings the instance back.

So a single request against a blipping dependency does not just fail — it kills every *other*
in-flight request on that instance and drops every WebSocket connection held by it. Combined
with D9 (no client-side reconnect), that means one such request permanently kills the live feed
in every connected browser until each user manually refreshes.

There is also no timeout of our own on either database, so the 30 s window is inherited from a
driver default rather than chosen.

### D7 — Stored XSS through the conversation title

`web/app.js:19`

```js
li.innerHTML = `<span>${c.title} (${c.messageCount})</span>` + ...
```

The title is free text from a `prompt()`, stored server-side unvalidated and re-rendered as HTML
for every participant. A title of `<img src=x onerror=...>` executes in each of their sessions.
Message bodies go through `textContent` and are fine — the title is the one hole.

### D8 — There is no authorisation anywhere

- `GET /api/messages?conversationId=N` — no caller identity, no participation check. Any
  conversation in the system is readable by id.
- `POST /api/messages` — `senderId` comes from the request body. Anyone can post as anyone.
- WS `subscribe` accepts arbitrary conversation ids, so a socket can passively tail every
  conversation in the system.

Real auth is out of scope for a take-home, but "no check at all" is not a defensible resting
point, and search makes it worse: an unscoped search endpoint is a full-corpus read primitive.

### D9 — The live feed dies permanently on the first blip

Client (`web/app.js:26`): no `onclose`, no `onerror`, no reconnect. One dropped socket — an API
restart, a laptop sleep, a proxy timeout — and real-time updates stop forever, with the UI still
looking perfectly healthy. Only a manual refresh recovers it.

Server (`src/ws/hub.ts`): no ping/pong and no `'error'` handler. Sockets leave the `clients` set
only on `'close'`, which never fires for a peer that vanished silently, so dead entries
accumulate for the lifetime of the process.

### D10 — Unbounded reads

`GET /api/messages` returns the entire history of a conversation — no limit, no pagination —
and then issues a Mongo `$in` containing every id it just fetched. The response and the query
both grow without bound.

### D11 — 1 + 2N queries to render the sidebar

`src/routes/conversations.js:20-31` loops over conversations issuing two more queries each.
With D4's missing indexes, each of those is a table scan.

### D12 — The unread dot is a client-side fiction

`c.unread` is set only from live WS traffic and lives in a single tab's memory. The API never
returns it, nothing persists it, and a refresh wipes it. So "keep the unread dot working across
instances" has nothing to keep working yet — a read cursor has to exist first.

### D13 — Two clocks disagree about when a message happened

`POST` returns `new Date()` from the application; `GET` returns MySQL's `created_at` (server
timezone, second precision). The message you just sent shifts in time when you reload, and the
WS payload and a refetch can order concurrent messages differently.

---

## Rough edges — fixing where cheap, documented where not

- **Routes are untyped `.js` inside a `strict: true` TS project**, and `tsconfig` sets
  `checkJs: false`, so they are not checked at all. `req.body` and every DB row are `any`.
  There is no input validation at the HTTP boundary beyond truthiness checks.
- **No typecheck, lint, or test script, and the project does not currently compile.**
  `npx tsc --noEmit` fails with 9 errors before any of my changes — every internal import uses
  an explicit `.ts` extension while `allowImportingTsExtensions` is not enabled:

  ```
  src/index.ts(3,24): error TS5097: An import path can only end with a '.ts' extension
                                    when 'allowImportingTsExtensions' is enabled.
  ```

  It runs anyway because `tsx` strips the extensions at load time, so the type checker has
  simply never been run. Nothing mechanical can fail here — there is no gate to fail.
- **No graceful shutdown.** `restart: on-failure` plus no SIGTERM handling means every deploy
  kills in-flight requests and drops WS clients without close frames — which D9 then makes
  permanent.
- **No healthcheck endpoint**, and Envoy does no health checking, so it will happily round-robin
  into an instance that is still booting or already dead.
- **Envoy's `timeout: 0s`** is set on the route to accommodate WebSockets, but it disables
  request timeouts for plain HTTP too.
- **`Dockerfile` uses `npm install` with no lockfile committed**, so builds are not
  reproducible; `COPY . .` is then shadowed by the `./:/app` bind mount, and the
  `/app/node_modules` anonymous volume goes stale whenever `package.json` changes.
- **Credentials are hardcoded as fallbacks in `src/config.ts`.**
- **No body size limits** on message text or conversation titles.

---

## Reading of the exercise

Redis is in `docker-compose.yml` and `REDIS_URL` is in `.env.example`, and nothing imports it.
Three of the four features in `tasks/` need exactly one thing — shared state between instances —
so the intended shape is fairly clear: put a Redis-backed bus and counter under the app, and
`multi-instance`, `rate-limiting` and `typing-indicator` all fall out of the same foundation.
`search` is independent.
