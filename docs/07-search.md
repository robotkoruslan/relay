# Search

Task: [`../tasks/search.md`](../tasks/search.md).

The brief left the definition open and noted the search box and an empty `GET /api/search` were
already wired up, so the frontend need not be touched.

## What it does

MongoDB text search over `message_bodies`, ranked by relevance, scoped to the caller's own
conversations, returned with a snippet around the match.

```
user 1 searches "refund" (member of both conversations):
   conv 2 | "Design sync"           | msg 40 | "Design tokens for the refund screen ... refunds look off"
   conv 1 | "Support — order #1042" | msg 39 | "The refund for order #1042 was processed yesterday"
user 2 searches "refund" (only in conversation 1):
   conv 1 | "Support — order #1042" | msg 39 | "The refund for order #1042 was processed yesterday"
user 3 searches "refund" (only in conversation 2):
   conv 2 | "Design sync"           | msg 40 | "Design tokens for the refund screen ... refunds look off"
stemming: user 3 searches "refunding":
   conv 2 | "Design sync"           | msg 40 | "Design tokens for the refund screen ... refunds look off"
user 99 searches (in nothing):
   (no results)
```

Three things visible in that output. The results are **scoped** — the same query returns different
things to different people, and nothing to someone with no conversations. They are **ranked** —
conversation 2 comes first for user 1 because its message contains both "refund" and "refunds", so
it scores higher. And matching is **stemmed** — "refunding" finds "refund".

## Decisions

**Scoping is not optional.** An unscoped `$text` query over every body in the system would be a
read primitive for the entire corpus — a worse version of the missing read checks it would sit
next to. Membership is resolved from MySQL first, and the Mongo query filters on it. This is why
[`06-access.md`](06-access.md) had to land first.

**Titles are joined once per result set,** not once per result: bodies live in Mongo and titles in
MySQL, so the route collects the distinct conversation ids and does a single `WHERE id IN (...)`.

**Snippets rather than whole bodies.** A result list of full messages does not show *why*
something matched. `snippet()` returns a window around the earliest matching term. Since `$text`
is stemmed, the query term may not literally appear in the body — in that case it falls back to
the head of the message rather than returning nothing useful. That fallback is the case the unit
tests were actually written for.

**The response is a superset of what the UI expects.** `renderResults` reads
`conversationId`, `conversationTitle` and `body`; `messageId`, `senderId` and `createdAt` ride
along, which is what makes the next part possible without changing the contract.

## Clicking a result now goes to the message

Following the existing UI would have opened the newest page of the conversation — which, with the
transcript paginated, is usually not the page containing the hit. Search you cannot follow is half
a feature, so `GET /api/messages` gained an `around` parameter: two index seeks on
`(conversation_id, id)`, one backwards from the target and one forwards, centring the page on it.

```
newest page ids       : 27,28,29,30,31,32,33,35,37,39 | nextBefore 27
around=5 ids          : 1,2,4,5,6,7,8,9,10           | nextBefore null
target included       : true
centred (before/after): 3 older, 5 newer
around=1 (very first) : ids 1,2,4,5,6,7 | nextBefore null   <- nothing older
```

The client scrolls the target into view and highlights it.

## Limits, stated plainly

**`$text` is word-based and stemmed.** It will not do substring or prefix matching, so "refun"
finds nothing and neither does a partial word. For a chat search box, prefix matching as you type
is what people actually expect.

**One text index per collection** is a MongoDB constraint. Searching titles as well as bodies
would need either a separate collection or a different engine.

**No highlighting of the matched term** in the snippet, and no phrase-quoting UI, though `$text`
supports `"quoted phrases"` and `-exclusions` in the query string as-is.

**`COUNT`-style pagination of results** is not implemented; the endpoint returns a ranked top-N
(default 25, max 100).

### Alternatives, and why not

- **MySQL `FULLTEXT`** — the natural choice if bodies lived in MySQL. They do not, and moving them
  there is the larger architectural argument, not a search feature.
- **Regex scan** (`{ body: /term/i }`) — supports substrings, cannot use an index, and is O(n) per
  query. Fine at seed-data scale, useless at real scale.
- **Atlas Search / Elasticsearch / OpenSearch** — the actual production answer: prefix and fuzzy
  matching, real highlighting, faceting, analyzers per language. Out of scope for a take-home, and
  it would mean running another service.

So: `$text` is the right size for this exercise, and the ceiling is worth knowing rather than
discovering.
