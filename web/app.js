const userId = 1;
let ws;
let activeConversation;
let conversations = [];
let activeTitle = '';
let loadedMessages = [];   // ascending, the pages fetched for the open conversation
let olderCursor = null;    // id to page backwards from, or null once fully loaded
let sending = false;
let wsRetries = 0;
let lastTypingSent = 0;
const typingUsers = new Map();   // userId -> timeout id, per open conversation

// Every request carries the caller id. A real deployment would send a session cookie or a
// bearer token instead; the server-side checks would not change.
function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { ...(options.headers ?? {}), 'x-user-id': String(userId) },
  });
}

async function refreshConversations() {
  const res = await api('/api/conversations');
  const fresh = await res.json();
  // Unread is tracked client-side, so carry it across a refetch instead of clearing it.
  const unread = new Map(conversations.map((c) => [c.id, c.unread]));
  conversations = fresh.map((c) => ({ ...c, unread: unread.get(c.id) ?? false }));
  renderSidebar();
  subscribe();
}

// Announce at most this often while someone keeps typing. Per keystroke would be one event per
// character, for no extra information.
const TYPING_THROTTLE_MS = 2000;
// How long a notice stands on its own. A stop event clears it immediately, but if that event is
// lost — a closed tab, a dropped socket — the indicator must not stick forever.
const TYPING_EXPIRY_MS = 3000;

function sendTyping(active) {
  if (ws?.readyState !== WebSocket.OPEN || !activeConversation) return;
  if (active) {
    const now = Date.now();
    if (now - lastTypingSent < TYPING_THROTTLE_MS) return;
    lastTypingSent = now;
  } else {
    lastTypingSent = 0;
  }
  ws.send(JSON.stringify({ type: 'typing', conversationId: activeConversation, active }));
}

function renderTyping() {
  const line = document.getElementById('typing');
  const who = [...typingUsers.keys()];
  if (who.length === 0) {
    line.textContent = '';
  } else if (who.length === 1) {
    line.textContent = `#${who[0]} is typing…`;
  } else {
    line.textContent = `${who.length} people are typing…`;
  }
}

function noteTyping(userId, active) {
  clearTimeout(typingUsers.get(userId));
  if (!active) {
    typingUsers.delete(userId);
  } else {
    typingUsers.set(userId, setTimeout(() => { typingUsers.delete(userId); renderTyping(); }, TYPING_EXPIRY_MS));
  }
  renderTyping();
}

function clearTyping() {
  for (const timer of typingUsers.values()) clearTimeout(timer);
  typingUsers.clear();
  renderTyping();
}

function showNotice(text) {
  const notice = document.getElementById('notice');
  notice.textContent = text;
  notice.hidden = false;
}

function hideNotice() {
  document.getElementById('notice').hidden = true;
}

function setConnected(connected) {
  const dot = document.getElementById('wsStatus');
  dot.textContent = connected ? '\u25CF' : '\u25CB';
  dot.title = connected ? 'live' : 'reconnecting…';
  dot.style.color = connected ? '#30a46c' : '#e5484d';
}

function renderSidebar() {
  const list = document.getElementById('conversations');
  list.innerHTML = '';
  for (const c of conversations) {
    const li = document.createElement('li');
    if (c.id === activeConversation) li.className = 'active';

    // Built as text, not interpolated into innerHTML: the title is free text typed by a user
    // and stored, so `<img src=x onerror=...>` as a title used to execute in every
    // participant's session.
    const label = document.createElement('span');
    label.textContent = `${c.title} (${c.messageCount})`;
    li.appendChild(label);
    if (c.unread) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '\u25CF';
      li.appendChild(dot);
    }

    li.onclick = () => openConversation(c.id, c.title);
    list.appendChild(li);
  }
}

function subscribe() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'subscribe', conversationIds: conversations.map((c) => c.id) }));
}

function connectWs() {
  const socket = new WebSocket(
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?userId=${userId}`,
  );
  ws = socket;

  socket.onopen = async () => {
    wsRetries = 0;
    setConnected(true);
    // A pub/sub bus does not replay. Anything sent while this client was disconnected was
    // simply missed, so refetch rather than assume what is on screen is current.
    await refreshConversations();
    if (activeConversation) await openConversation(activeConversation, activeTitle);
  };

  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'typing') {
      if (msg.conversationId === activeConversation) noteTyping(msg.userId, msg.active);
      return;
    }

    if (msg.type !== 'message') return;
    // Someone who just sent a message is no longer typing.
    if (msg.conversationId === activeConversation) noteTyping(msg.senderId, false);
    if (loadedMessages.some((m) => m.id === msg.id)) return;
    const c = conversations.find((x) => x.id === msg.conversationId);
    if (c) c.messageCount += 1;
    if (msg.conversationId === activeConversation) {
      appendMessage(msg);
    } else if (c) {
      c.unread = true;
    }
    renderSidebar();
  };

  // Previously neither of these was handled, so a single dropped socket — an instance restart,
  // a sleeping laptop — ended live updates permanently while the UI still looked healthy.
  socket.onclose = () => {
    if (ws !== socket) return;   // superseded by a newer socket
    setConnected(false);
    const backoff = Math.min(30000, 500 * 2 ** wsRetries++);
    setTimeout(connectWs, backoff + Math.random() * 250);   // jitter, so clients do not sync up
  };
  socket.onerror = () => {
    /* onclose always follows, and reconnecting is handled there */
  };
}

async function fetchMessages(id, { before, around } = {}) {
  const params = new URLSearchParams({ conversationId: id });
  if (before) params.set('before', before);
  if (around) params.set('around', around);
  const res = await api(`/api/messages?${params}`);
  return res.json();
}

async function openConversation(id, title, focusMessageId) {
  if (activeConversation !== id) clearTyping();
  activeConversation = id;
  activeTitle = title;
  const c = conversations.find((x) => x.id === id);
  if (c) c.unread = false;
  renderSidebar();

  document.getElementById('title').textContent = title;
  const page = await fetchMessages(id, focusMessageId ? { around: focusMessageId } : {});
  loadedMessages = page.messages;
  olderCursor = page.nextBefore;
  renderMessages(focusMessageId);

  const pane = document.getElementById('messages');
  if (focusMessageId) {
    // Opened from a search hit: show that message rather than the bottom of the transcript.
    pane.querySelector('.msg.focus')?.scrollIntoView({ block: 'center' });
  } else {
    pane.scrollTop = pane.scrollHeight;
  }
}

async function loadOlder() {
  if (!olderCursor) return;
  const pane = document.getElementById('messages');
  const heightBefore = pane.scrollHeight;
  const topBefore = pane.scrollTop;

  const page = await fetchMessages(activeConversation, { before: olderCursor });
  loadedMessages = page.messages.concat(loadedMessages);
  olderCursor = page.nextBefore;
  renderMessages();

  // Keep the reader where they were rather than snapping to the newly prepended top.
  pane.scrollTop = topBefore + (pane.scrollHeight - heightBefore);
}

function messageNode(m, focusMessageId) {
  const div = document.createElement('div');
  div.className = m.id === focusMessageId ? 'msg focus' : 'msg';
  div.textContent = `#${m.senderId}: ${m.body}`;
  return div;
}

function renderMessages(focusMessageId) {
  const pane = document.getElementById('messages');
  pane.innerHTML = '';
  if (olderCursor) {
    const more = document.createElement('button');
    more.id = 'loadOlder';
    more.textContent = 'Load older messages';
    more.onclick = loadOlder;
    pane.appendChild(more);
  }
  for (const m of loadedMessages) pane.appendChild(messageNode(m, focusMessageId));
}

function appendMessage(m) {
  loadedMessages.push(m);
  const pane = document.getElementById('messages');
  pane.appendChild(messageNode(m));
  pane.scrollTop = pane.scrollHeight;
}

document.getElementById('composer').onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById('text');
  const button = document.querySelector('#composer button');
  const body = input.value.trim();
  if (!body || !activeConversation || sending) return;

  // A send is not instant. Without blocking here, an impatient second click posts the message
  // twice; the server now dedupes on clientId, but the same clientId has to be reused for that
  // to help, so the simplest correct thing is not to fire a second request at all.
  sending = true;
  button.disabled = true;
  input.value = '';
  hideNotice();
  sendTyping(false);
  try {
    const res = await api('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: activeConversation,
        body,
        clientId: crypto.randomUUID(),
      }),
    });

    if (res.status === 429) {
      // Hand the text back rather than discarding it, and hold the button for as long as the
      // server asked instead of letting the user hammer into a wall of 429s.
      input.value = body;
      let seconds = Number(res.headers.get('Retry-After')) || 1;
      showNotice(`Sending too fast — try again in ${seconds}s`);
      await new Promise((resolve) => {
        const tick = setInterval(() => {
          seconds -= 1;
          if (seconds > 0) {
            showNotice(`Sending too fast — try again in ${seconds}s`);
            return;
          }
          clearInterval(tick);
          hideNotice();
          resolve();
        }, 1000);
      });
      return;
    }

    if (!res.ok) {
      input.value = body;
      showNotice('Could not send that message. Try again.');
    }
  } finally {
    sending = false;
    button.disabled = false;
  }
};

const composerInput = document.getElementById('text');
composerInput.addEventListener('input', () => {
  sendTyping(composerInput.value.trim().length > 0);
});
// Leaving the box is as good a signal as sending: clear the indicator rather than let it expire.
composerInput.addEventListener('blur', () => sendTyping(false));

document.getElementById('newConv').onclick = async () => {
  const title = prompt('Conversation title?');
  if (!title) return;
  await api('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, participantIds: [2] }),
  });
  await refreshConversations();
};

document.getElementById('searchForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = document.getElementById('search').value.trim();
  if (!q) return;
  const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
  renderResults(q, await res.json());
};

function renderResults(q, results) {
  activeConversation = null;
  clearTyping();
  loadedMessages = [];
  olderCursor = null;
  document.getElementById('title').textContent = `Search: "${q}"`;
  const pane = document.getElementById('messages');
  pane.innerHTML = '';
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'msg';
    empty.style.color = '#888';
    empty.textContent = 'No results.';
    pane.appendChild(empty);
    return;
  }
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.style.cursor = 'pointer';
    const title = document.createElement('strong');
    title.textContent = r.conversationTitle ?? '#' + r.conversationId;
    div.append(title, ' — ' + (r.body ?? ''));
    div.onclick = () =>
      openConversation(r.conversationId, r.conversationTitle ?? '#' + r.conversationId, r.messageId);
    pane.appendChild(div);
  }
}

// Wrapped: this file is loaded as a classic script, where top-level await is a syntax error.
(async () => {
  await refreshConversations();
  connectWs();
})();
