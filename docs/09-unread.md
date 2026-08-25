# Persistent unread state — D12

Defect ids refer to [`../spec/01-triage.md`](../spec/01-triage.md).

## What was wrong

`c.unread` was set from live WebSocket traffic and lived in one browser tab's memory. The API
never returned it, nothing stored it, and a refresh wiped it. So the dot was not really an unread
indicator — it was "a message arrived while this tab was open".

That also meant the multi-instance task had nothing to preserve: making an in-memory,
per-tab flag survive across instances is not a meaningful goal. A read cursor had to exist first.

## What it is now

`conversation_participants.last_read_message_id`, and the sidebar computes the count against it:

```sql
(SELECT COUNT(*) FROM messages m
  WHERE m.conversation_id = c.id
    AND m.id > COALESCE(p.last_read_message_id, 0)
    AND m.sender_id <> p.user_id) AS unreadCount
```

Two details in that predicate. `COALESCE(..., 0)` means a participant who has never read anything
sees everything as unread, rather than nothing. And `sender_id <> p.user_id` excludes the
participant's own messages — otherwise sending something would mark the conversation unread for
its author.

```
user 2, starting point:                        conv1 unread=32
after user 1 sends two:                        conv1 unread=34
after user 2 sends one (own excluded):         conv1 unread=34
user 2 opens the conversation, marking read up to 43
after marking read:                            conv1 unread=0
```

## The cursor only moves forward

`POST /api/conversations/:id/read` uses:

```sql
SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), ?)
```

Without `GREATEST` this is a lost-update bug waiting to happen. Two tabs open, or two requests
arriving out of order, and the lower value wins — resurrecting messages the user has already
read. It is the sort of thing that looks fine in testing with one tab and is baffling in
production.

```
--- monotonicity: replay an OLD cursor, as a stale tab would ---
after posting a stale cursor of 1:             conv1 unread=0
(unread must stay 0 -- the cursor must not move backwards)
```

Because the state is server-side, it is shared between an account's devices and survives a
refresh, and — relevant to the multi-instance task — it is the same on every instance because
it is not on any instance.

## Trade-offs

**A cursor, not per-message read state.** One `BIGINT` per participant instead of a row per
message per reader. It cannot express "read the newest, skipped the middle", which is a shape no
chat client offers anyway, and it makes the unread count a single indexed range scan.

**The count is computed, not maintained.** Same caveat as `messageCount`: it is proportional to
how far behind the reader is, served from the `(conversation_id, id)` index. Someone returning to
a conversation with a million unread messages will feel it. A maintained counter would fix both
counts together, which is why it is one recommendation rather than two.

**Read receipts are not implemented.** The data is now there to show "seen by" — that is a
product decision, not a missing piece of plumbing.
