# Identity and access — D7, D8

Defect ids refer to [`../spec/01-triage.md`](../spec/01-triage.md).

## What was missing

There was no notion of a caller anywhere.

- `GET /api/messages?conversationId=N` — any conversation in the system was readable by guessing
  an integer.
- `POST /api/messages` — `senderId` came from the request body, so anyone could post as anyone,
  into a conversation they had no part in.
- WS `subscribe` accepted arbitrary ids, so one socket could passively tail every conversation in
  the system in real time.
- `GET /api/conversations?userId=N` — anyone's sidebar.

## What this is, and what it is not

**This is not authentication.** The caller states an id — `x-user-id` on HTTP, `?userId=` on the
WebSocket handshake, because browsers cannot set headers there — and the server believes it.
Anyone can claim to be anyone.

Building real auth is out of scope for a take-home, but "no check at all" is not a defensible
place to stop, and it blocks search: an unscoped search endpoint is a read primitive for the
whole corpus.

So the split is deliberate: **identity is stated, but every access check around it is real and in
the right place.** Replacing `callerId()` with a session or token lookup is the whole change
needed to make this genuine — every check downstream of it stays as it is. That is the property
worth having, and `src/http/identity.ts` says so at the top so nobody mistakes it for finished.

## Checks

Membership in `conversation_participants` is now required to read a conversation, to post to one,
and to subscribe to one.

```
no identity header at all:                      400  x-user-id header is required
user 2 lists own conversations:                 200  [conversation 1 only]
user 2 reads conversation 1 (is a member):      200
user 2 reads conversation 2 (NOT a member):     404  conversation not found
user 2 reads conversation 9999 (no such):       404  conversation not found
user 2 posts to conversation 2 (NOT a member):  404  conversation not found
body senderId is ignored, header wins:          201  {"senderId":3,...}
```

**404, not 403, on purpose.** "You are not allowed in here" confirms the conversation exists,
which is information the caller has no right to. A non-participant and a non-existent
conversation are deliberately indistinguishable from outside — note the identical responses to
conversation 2 and conversation 9999 above.

`senderId` no longer exists as an input. The last line shows it: user 3 posts with
`senderId: 1` in the body, and the message is stored as sender 3.

The WebSocket rejects an unidentified handshake outright, and a subscription request is
intersected with real membership rather than trusted:

```
connect without userId  -> closed 1008 userId is required

user 2 subscribes to [1, 2, 9999]
post to conversation 1 (user 2 IS a member): 201
post to conversation 2 (user 3, user 2 NOT a member): 201
events user 2 received: conv1:"visible to user 2"
no leak: only its own conversation
```

`GET /api/conversations` no longer takes a user id at all — it lists the caller's own. And a new
conversation always includes its creator, since otherwise it was possible to create one the
creator could not then read.

## D7 — stored XSS through the conversation title

```js
li.innerHTML = `<span>${c.title} (${c.messageCount})</span>` + ...
```

The title is free text from a `prompt()`, stored server-side and re-rendered as HTML for every
participant, so `<img src=x onerror=...>` as a title executed in each of their sessions. Message
bodies already went through `textContent` and were never affected — the title was the one hole.

Now built as nodes with `textContent`. The remaining `innerHTML` uses in `app.js` are all
`= ''` to clear a container, which cannot inject anything.

Server-side, the title is also length-checked against its column width, so MySQL cannot silently
truncate it.

## What real authentication would need

Not built, but worth being concrete about rather than hand-waving:

- Sessions or signed tokens, with `callerId()` reading from that instead of a header. Nothing
  downstream changes.
- Rate limiting becomes enforcement rather than advice — see the note in
  [`05-rate-limiting.md`](05-rate-limiting.md), where the limiter is correct but keys on an
  identity the client chooses.
- A `users` table that is more than three seeded rows, with credentials handled properly.
- Authorisation on conversation creation: currently any caller can add any user ids as
  participants.
