# Foundation — making failures visible

Defect ids refer to [`../spec/01-triage.md`](../spec/01-triage.md).

This step deliberately changes **no API behaviour**. Every endpoint returns the same shape it
returned before. The point was to make the app safe to work on: until a failure produces a stack
trace instead of silence, every later fix is debugged blind.

## D6 — a dependency outage no longer kills the instance

**What was wrong.** No `try/catch`, no error middleware, no `unhandledRejection` handler.
Express 4 does not catch rejections from `async` handlers, so a failing database call ended the
request in silence and then took the process with it.

**How it showed up.** With Mongo stopped, `GET /api/messages`:

```
before:  client err after 30120 ms          <- driver default serverSelectionTimeoutMS
         MongoNetworkError: getaddrinfo ENOTFOUND mongo
         Node.js v22.23.2                   <- process exited
         api  Up Less than a second         <- restarted by `restart: on-failure`
```

30 seconds of nothing, then the whole instance dies — killing every other in-flight request and
every WebSocket connection it held.

**What changed.**

- `asyncHandler` forwards a rejected handler promise to `next(err)`.
- An error middleware answers `HttpError` with its intended status, and anything else with a
  `500` carrying a random `incidentId` — the message and stack stay server-side.
- `serverSelectionTimeoutMS` and `connectTimeoutMS` are set from `DB_TIMEOUT_MS` (default 5s), so
  the failure window is a decision rather than an inherited driver default.
- `unhandledRejection` and `uncaughtException` log with a stack and shut down cleanly instead of
  dying mid-flight.

**After:**

```
messages : 500 in 5075 ms -> {"error":{"code":"internal","message":"internal server error",
                                       "incidentId":"a3b2b596-..."}}
healthz  : 503 -> {"status":"degraded","checks":{"mysql":"ok",
                                                "mongo":"getaddrinfo ENOTFOUND mongo"}}
mysql-only route still served: 200
api Up 16 seconds                            <- survived
```

Server-side, the same request logs one line that ties back to what the client saw:

```
[error] a3b2b596-9af5-4d8e-afbe-03215485bd2a GET /api/messages?conversationId=1
        MongoServerSelectionError: getaddrinfo ENOTFOUND mongo
            at Topology.selectServer (...)
```

Partial degradation instead of a total outage: routes that only need MySQL keep serving.

## The project did not typecheck

`npx tsc --noEmit` failed with 9 errors before any change — every internal import uses an
explicit `.ts` extension while `allowImportingTsExtensions` was off. It ran anyway because `tsx`
strips extensions at load time, so the type checker had simply never been run.

Enabled `allowImportingTsExtensions`, and also `checkJs`, `noUncheckedIndexedAccess` and
`noImplicitOverride`. Added `npm run typecheck` and `npm test` so there is something mechanical
to fail.

## Routes were untyped JavaScript in a `strict` TypeScript project

`src/routes/*.js` with `checkJs: false` meant `req.body`, `req.query` and every database row were
`any`, and validation was a truthiness check. `if (!conversationId)` rejects `0` — but so does it
reject nothing else: `'abc'`, `'1.5'`, `-3`, and `['1','2']` from a repeated query parameter all
sailed through into SQL.

Converted to `.ts` and added a validation layer at the HTTP boundary. The `mysql2` wrappers
(`queryRows`, `queryOne`, `execute`) pin a row type per call site, which also removed the
`[[last]]` double-destructuring the original needed to get at a single row.

19 tests cover the parsing edge cases — `Number('')` being `0`, repeated query parameters
arriving as arrays, length measured after trimming, values longer than their column.

## Graceful shutdown was impossible from inside the app

Found while verifying the SIGTERM path: the handler never ran at all.

```
npm error command failed
npm error signal SIGTERM
npm error command sh -c tsx src/index.ts
```

`command: npm start` makes **npm** PID 1. It does not proxy the signal to its grandchild, so
SIGTERM never reached the application — no amount of handler code could have worked. Changed the
container command to run node directly (`node --import tsx src/index.ts`) and set
`stop_grace_period: 15s` so the app's own 10s drain budget expires first.

Shutdown now closes WebSockets *before* `server.close()` — otherwise it waits forever on
connections designed never to end — then drains HTTP, then the connection pools:

```
[shutdown] SIGTERM: draining
[shutdown] complete
ws got close frame: code 1001 reason: server shutting down
```

The close frame matters beyond tidiness: a client that receives `1001` knows it should
reconnect, where a silently dropped socket leaves it guessing.

## Also in this step

- `GET /healthz` probes MySQL and Mongo with a timeout, and reports `503 draining` from the
  moment SIGTERM arrives, so a proxy can route away before the listener closes.
- Unknown `/api/*` paths return a JSON 404 instead of falling through to the static handler.
- `express.json()` has an explicit size limit; message bodies and titles have length caps
  matching their columns, so MySQL cannot silently truncate.
- Required env vars fail fast at boot with a named error instead of defaulting to hardcoded
  credentials.
- `express.static` resolves relative to the module, not the working directory.
- WebSocket `'error'` handlers on both socket and server — an unhandled socket error was another
  route to killing the process.

## Not addressed here

Still open, in the order the plan takes them: the blocking `pbkdf2Sync` on every send, the
non-atomic dual write, the destructive seed, the missing indexes, unused `client_id`, the N+1
sidebar query, unbounded reads, XSS via conversation title, and the absence of any authorisation.
