# Relay

Take-home submission. The original brief is preserved verbatim at the bottom of this file.

Short version: 13 defects found and fixed, all four features in [`tasks/`](tasks/) built, and a
note per step in [`docs/`](docs/) explaining what was wrong, how it showed up and what changed.
Everything in those notes is measured output from the running stack, not description.

## Running it

```
cp .env.example .env
docker compose up --build
```

Then <http://localhost:3000>. To exercise the parts that only exist with more than one instance:

```
docker compose up -d --build --scale api=3
```

Checks and tools, all from inside the stack (they need the databases and Redis):

```
docker compose exec api npm run typecheck
docker compose exec api npm test                          # 43 tests
docker compose exec api npx tsx scripts/check-fanout.ts   # cross-instance delivery, exits non-zero on failure
docker compose exec api npx tsx scripts/bench-send.ts     # send latency and event-loop starvation
```

## Where to start reading

- [`spec/01-triage.md`](spec/01-triage.md) — what I found before writing any code, with the
  commands that reproduce each defect.
- [`spec/02-plan.md`](spec/02-plan.md) — how the work was sequenced and why, including rejected
  approaches.
- [`docs/10-architecture.md`](docs/10-architecture.md) — what I would change but did not, and why.
  The most opinionated file here.

The commit history is meant to be read in order; each commit explains its own reasoning.

## What was broken

| | Defect | Notes |
|---|---|---|
| D1 | `pbkdf2Sync` with 200k rounds on every send blocked the event loop | [03](docs/03-hot-path.md) |
| D2 | Non-atomic dual write persisted messages with no body, forever | [02](docs/02-data-layer.md) |
| D3 | Rebuilding the app blanked the entire message history | [02](docs/02-data-layer.md) |
| D4 | No index supported any query the app actually ran | [02](docs/02-data-layer.md) |
| D5 | `client_id` was plumbed end-to-end and ignored, so retries duplicated | [02](docs/02-data-layer.md) |
| D6 | One failed dependency call killed the whole instance | [01](docs/01-foundation.md) |
| D7 | Stored XSS through the conversation title | [06](docs/06-access.md) |
| D8 | No authorisation anywhere — any conversation readable by id | [06](docs/06-access.md) |
| D9 | The live feed died permanently on the first dropped socket | [04](docs/04-multi-instance.md) |
| D10 | `GET /api/messages` returned entire conversations unbounded | [02](docs/02-data-layer.md) |
| D11 | The sidebar issued 1 + 2N queries to render | [02](docs/02-data-layer.md) |
| D12 | The unread dot was a per-tab fiction, lost on refresh | [09](docs/09-unread.md) |
| D13 | Two clocks disagreed about when a message happened | [02](docs/02-data-layer.md) |

Plus, found while fixing rather than during triage: the project did not typecheck at all;
`npm start` as the container command made graceful shutdown impossible; `/healthz` treating Redis
as required took the whole service out of rotation when Redis blinked; and the app refused to boot
without Redis, an optional dependency.

The headline numbers, from [`docs/03-hot-path.md`](docs/03-hot-path.md) — the last row is a route
that touches no database, timed while sends are in flight, so it measures pure event-loop
availability:

| | before | after |
|---|---|---|
| 6 concurrent sends, mean | 93.1 ms | 20.2 ms |
| idle route under load, p95 | 38.9 ms | 6.6 ms |

## What was built

All four tasks.

- **[Multi-instance](docs/04-multi-instance.md)** — Redis pub/sub fan-out. Before: 33 of 48
  deliveries lost at `--scale api=3`. After: every client receives everything.
  `scripts/check-fanout.ts` demonstrates both.
- **[Rate limiting](docs/05-rate-limiting.md)** — sliding window in one atomic Lua script, 5 per
  10s per user per conversation, 429 with an exact `Retry-After`, correct across instances and
  under concurrency.
- **[Search](docs/07-search.md)** — Mongo text search scoped to the caller's own conversations,
  ranked, with snippets. Clicking a result opens the conversation at that message.
- **[Typing indicator](docs/08-typing.md)** — on the same bus, so multi-instance from the start.
  Authorised, double-throttled, with both a stop event and an expiry.

Beyond the tasks: paginated transcripts, persistent unread state, a migration runner with an
advisory lock, health checks, graceful shutdown, and a caller-identity layer that every access
check hangs off — explicitly not authentication, and
[said so in the code](src/http/identity.ts).

## Honest gaps

Named here rather than left to be discovered. Full detail in
[`docs/10-architecture.md`](docs/10-architecture.md).

- `x-user-id` is asserted, not authenticated, so rate limiting is advisory rather than enforced.
- Tests stop at the unit boundary. The access-control matrix and cross-instance behaviour are
  verified by scripts and pasted output, not by a suite that would catch a regression.
- No metrics, traces, or structured logs — ironic for an app whose defining problem was
  misbehaviour under load.
- Message and unread counts are computed per read, so they scale with conversation length.
- One logical record still lives in two databases. That is the thing I would change first, and
  §1 of the architecture note explains why I made it safe instead of rewriting it on a guess.

---

# Original brief

Hey — thanks for taking a look at this. Quick bit of context, honestly:

> I've been putting together this little chat / inbox app in my spare time. I rushed it, and I'm
> pretty sure I didn't think a bunch of things through — a few bits don't behave right once you
> actually use it. On top of that I never got around to the features I wanted. I could really use
> a second pair of hands.

So, a few things, if you don't mind:

1. **Get it running** and have a play with it.
2. **Something's off.** A few things don't behave the way they should once there's real traffic.
   Track down what you can and fix it — and leave me a short note per fix on what was actually wrong.
3. **Build some features.** I didn't finish the fun part. The things I had in mind are written up in
   [`tasks/`](tasks/) — pick whichever appeal to you and build **as many as you like** (or your own
   idea). No need to do them all; do good work on the ones you take.
4. **Anything you'd just do differently — do it (or note it).** I rushed this, so the structure, the
   types, bits of plumbing that aren't there... some of it probably makes you wince. If you'd change
   something, improve what bugs you most, or drop a note in [`docs/`](docs/) on what you'd change and
   why. I won't be offended — I'd rather see how you think about it.

## Running it

```
cp .env.example .env
docker compose up --build
```

Then open <http://localhost:3000>. It seeds a couple of demo users and conversations on first boot.

## Ground rules

- **Work in your own copy.** Clone this repo, push it to a fresh repo of your own, and send us the
  link when you're done. Public is fine.
- **Leave your working *in* the repo.** Notes, plans, decisions, dead ends — whatever you scribbled
  while figuring it out, commit it. There's a [`docs/`](docs/) and a [`spec/`](spec/) folder for
  exactly that. We care as much about *how* you worked as the final result, so please don't tidy it
  away before you send it.
- **No hard time limit.** A few focused hours is already a solid showing; if you're enjoying it, go
  further.
- Use whatever tools and setup you normally work with.
- Send us **just the link to your repo**, plus a short note on what you changed and why — what was
  broken, what you fixed, what you built.
