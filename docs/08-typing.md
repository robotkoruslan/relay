# Typing indicator

Task: [`../tasks/typing-indicator.md`](../tasks/typing-indicator.md).

## Design

Nothing is persisted. "Someone is typing" is worthless a second later, so it lives entirely on the
WebSocket and rides the same Redis bus as messages — which means it worked across instances from
the first commit rather than needing a follow-up.

```
user 1 types in conversation 1:
   user 2 (member)      sees: [{"type":"typing","conversationId":1,"userId":1,"active":true}]
   user 1 (the author)  sees: []          <- own typing excluded
   user 3 (not member)  sees: []
user 2 types in conversation 2 (NOT a member):
   user 3 (member of 2) sees: []          <- rejected at the socket
server throttle: 12 rapid notices -> 1 delivered (limit is 1 per second)
stop event: {"type":"typing","conversationId":1,"userId":1,"active":false}
```

Measured through Envoy at `--scale api=3`, so the typist and the observers were on different
instances.

## Decisions

**Authorisation reuses the subscription set.** A socket's `subs` was already intersected with real
conversation membership when it subscribed, so `subs.has(conversationId)` is a sufficient check —
no extra query per keystroke, and a socket cannot announce typing into a conversation it is not
in. Verified above: user 2 announcing into conversation 2 reaches nobody.

**Two independent throttles, because a client is not something to rely on.** The client sends at
most one notice every 2s while someone keeps typing — per keystroke would be one event per
character for no extra information. The server independently floors it at one per second per
socket per conversation, so a hostile or simply buggy client cannot flood the bus and every other
client. That is the line that turns 12 rapid notices into 1.

**Both a stop event and an expiry.** Sending or leaving the box sends `active: false`, which
clears the indicator immediately. But a stop event can be lost — a closed tab, a dropped socket,
a Redis blip — so each notice also expires on its own after 3s. Without the expiry an indicator
could stick forever; without the stop event it would linger for up to 3s after every send, which
looks broken.

**The author is excluded, including their own other tabs.** You do not need to be told that you
are typing. The exclusion happens at delivery on each instance, keyed on the event's `userId`,
which is why it holds across instances rather than only where the typist happens to be connected.

## Trade-offs

**Identified by id, not by name.** The indicator reads `#1 is typing…`, matching how messages
already render (`#1: hello`). Resolving names would mean a query per event or a user cache; with
the app showing raw ids everywhere else, that would be a cosmetic fix in the wrong place. If the
UI ever shows real names, this and message rendering should be changed together.

**Only for the conversation on screen.** Typing events for other conversations are delivered but
ignored by the client. Showing them in the sidebar is possible and would be a small change;
nothing about it is blocked.

**No debounce on stop.** `blur` fires when the composer loses focus for any reason, including a
click elsewhere in the window, so the indicator can clear a moment before someone resumes. The
alternative — waiting to see whether they come back — makes the indicator lie for longer, which
is the worse failure.
