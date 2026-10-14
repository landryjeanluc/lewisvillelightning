export {};
type Member = { id: number; display_name: string };
type User = Member & { role: string };
type Room = { id: number; kind: 'team' | 'direct'; name: string; last_message: string | null; last_deleted: boolean; unread: number };
type Message = { id: number; conversation_id: number; sender_id: number | null; sender_name: string; body: string; created_at: string; deleted_at: string | null; revision: number };
type Page = { messages: Message[]; cursor: number; has_more: boolean };
type Thread = { messages: Map<number, Message>; cursor: number; loaded: boolean; more: boolean; draft: string; sending: boolean; pending?: { body: string; client_id: string }; loading?: Promise<void>; read: number; reading: boolean; position?: { top: number; following: boolean } };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const shell = el('chat-app');
const loading = el('chat-loading');
const login = el('chat-login');
const roomsEl = el('chat-rooms');
const messagesEl = el<HTMLOListElement>('chat-messages');
const scroll = el('chat-scroll');
const composer = el<HTMLTextAreaElement>('chat-body');
const send = el<HTMLButtonElement>('chat-send');
const older = el<HTMLButtonElement>('chat-older');
const latest = el<HTMLButtonElement>('chat-latest');
const memberSelect = el<HTMLSelectElement>('chat-member');
const connection = el('chat-connection');
let me: User;
let rooms: Room[] = [];
let active = 0;
let authenticated = true;
let refreshing = false;
const threads = new Map<number, Thread>();
const rendered = new Map<number, { revision: number; node: HTMLLIElement }>();
const mobile = matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1024px)');
document.body.classList.add('chat-page');
const background = Array.from(document.querySelectorAll<HTMLElement>('.site-head, .site-foot, .chat-intro, .skip'));
const originalInert = background.map(node => node.inert);
function threadVisible() { return active !== 0 && authenticated; }
function syncViewport() {
  const viewport = window.visualViewport;
  shell.style.setProperty('--chat-height', `${viewport?.height ?? window.innerHeight}px`);
  shell.style.setProperty('--chat-top', `${viewport?.offsetTop ?? 0}px`);
}
function syncView() {
  const open = mobile.matches && threadVisible();
  shell.classList.toggle('is-thread', open);
  document.body.classList.toggle('chat-thread-open', open);
  document.documentElement.classList.toggle('chat-thread-open', open);
  background.forEach((node, index) => { node.inert = open || originalInert[index]; });
  syncViewport();
}
function rememberPosition() {
  if (active) thread(active).position = { top: scroll.scrollTop, following: nearBottom() };
}
function showConversations() {
  rememberPosition();
  const previous = active;
  active = 0; composer.blur(); error(); syncView(); renderRooms();
  roomsEl.querySelector<HTMLButtonElement>(`[data-id="${previous}"]`)?.focus({preventScroll:true});
}
function resizeComposer() {
  const following = nearBottom();
  composer.style.height = 'auto';
  composer.style.height = `${Math.min(composer.scrollHeight, 140)}px`;
  if (following && threadVisible()) scroll.scrollTop = scroll.scrollHeight;
}
function viewportChanged() {
  const following = nearBottom();
  syncViewport();
  if (following && threadVisible()) requestAnimationFrame(bottom);
}
window.visualViewport?.addEventListener('resize', viewportChanged);
window.visualViewport?.addEventListener('scroll', syncViewport);
window.addEventListener('resize', viewportChanged);
mobile.addEventListener('change', () => {
  syncView();
  if (!mobile.matches && !active && rooms.length) void selectRoom(rooms[0].id, false);
});
el('chat-back').addEventListener('click', () => {
  if (history.state?.chatRoom === active) history.back();
  else { history.replaceState(null, '', location.pathname + location.search); showConversations(); }
});
window.addEventListener('popstate', () => {
  if (!authenticated || !rooms.length) return;
  const id = Number(location.hash.match(/^#conversation-(\d+)$/)?.[1]);
  if (rooms.some(room => room.id === id)) void selectRoom(id, false);
  else if (mobile.matches) showConversations();
  else void selectRoom(rooms.find(room => room.kind === 'team')?.id ?? rooms[0].id, false);
});
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function thread(id: number): Thread {
  if (!threads.has(id)) threads.set(id, { messages: new Map(), cursor: 0, loaded: false, more: false, draft: '', sending: false, read: 0, reading: false });
  return threads.get(id)!;
}
function error(message = '') {
  for (const id of ['chat-error', 'chat-list-error']) {
    const show = id === (mobile.matches && !active ? 'chat-list-error' : 'chat-error');
    el(id).textContent = show ? message : ''; el(id).hidden = !show || !message;
  }
}
function signedOut() {
  authenticated = false;
  active = 0; syncView();
  shell.hidden = true;
  loading.hidden = true;
  login.hidden = false;
  messagesEl.replaceChildren();
  threads.clear();
  rendered.clear();
  rooms = [];
  roomsEl.replaceChildren();
  memberSelect.replaceChildren();
  composer.value = "";
}
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) signedOut();
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not complete that request. Please try again.');
  }
  return response.json();
}
function nearBottom() { return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90; }
function bottom() {
  scroll.scrollTop = scroll.scrollHeight;
  latest.hidden = true;
  void markRead();
}
function updateComposer() {
  const state = thread(active);
  if (composer.value !== state.draft) composer.value = state.draft;
  composer.disabled = !state.loaded;
  send.disabled = !state.loaded || state.sending || !state.draft.trim();
  send.setAttribute('aria-label', state.sending ? 'Sending message' : 'Send message');
  send.setAttribute('aria-busy', String(state.sending));
  resizeComposer();
}
function renderRooms() {
  // Reuse buttons so background updates preserve keyboard focus.
  const existing = new Map(Array.from(roomsEl.children).map(node => [Number((node as HTMLElement).dataset.id), node as HTMLButtonElement]));
  for (const room of rooms) {
    let button = existing.get(room.id);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button'; button.className = 'chat-room'; button.dataset.id = String(room.id);
      button.addEventListener('click', () => void selectRoom(room.id));
      const title = document.createElement('span'); title.className = 'chat-room-title';
      const name = document.createElement('span'); name.className = 'chat-room-name';
      const unread = document.createElement('span'); unread.className = 'chat-unread';
      const preview = document.createElement('span'); preview.className = 'chat-preview';
      title.append(name, unread); button.append(title, preview);
      roomsEl.append(button);
    }
    button.setAttribute('aria-current', String(room.id === active));
    button.querySelector('.chat-room-name')!.textContent = room.name;
    const badge = button.querySelector('.chat-unread') as HTMLElement;
    badge.textContent = String(room.unread); badge.hidden = !room.unread;
    badge.setAttribute('aria-label', `${room.unread} unread messages`);
    button.querySelector('.chat-preview')!.textContent = room.last_deleted ? 'Message removed' : room.last_message || (room.kind === 'team' ? 'The whole Lightning crew' : 'Say hello');
    existing.delete(room.id);
  }
  existing.forEach(node => node.remove());
}
function messageNode(message: Message): HTMLLIElement {
  const own = message.sender_id === me.id;
  const node = document.createElement('li');
  node.className = `chat-message${own ? ' own' : ''}${message.deleted_at ? ' deleted' : ''}`;
  node.dataset.id = String(message.id);
  const meta = document.createElement('div'); meta.className = 'chat-message-meta';
  const name = document.createElement('strong'); name.textContent = own ? 'You' : message.sender_name;
  const time = document.createElement('time'); time.dateTime = message.created_at; time.textContent = dateFormat.format(new Date(message.created_at));
  const bubble = document.createElement('p'); bubble.className = 'chat-bubble'; bubble.textContent = message.deleted_at ? 'Message removed' : message.body;
  meta.append(name, time); node.append(meta, bubble);
  if (!message.deleted_at && (own || (me.role === 'admin' && rooms.find(r => r.id === active)?.kind === 'team'))) {
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'link danger chat-remove'; remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove message from ${message.sender_name} at ${time.textContent}`);
    remove.addEventListener('click', async () => {
      if (!window.confirm('Remove this message for everyone in this conversation?')) return;
      remove.disabled = true;
      try {
        await api(`/chat/conversations/${message.conversation_id}/messages/${message.id}`, 'DELETE');
        await updates(message.conversation_id);
      } catch (e) { error((e as Error).message); }
      finally { remove.disabled = false; }
    });
    node.append(remove);
  }
  if (!message.deleted_at && !own) {
    const report = document.createElement('button');
    report.type = 'button'; report.className = 'link chat-report'; report.textContent = 'Report';
    report.addEventListener('click', async () => {
      if (!window.confirm('Share this message with team admins for review? For urgent help, speak to a trusted adult.')) return;
      report.disabled = true;
      try {
        await api(`/chat/conversations/${message.conversation_id}/messages/${message.id}/report`, 'POST');
        report.textContent = 'Reported';
      } catch (e) { error((e as Error).message); report.disabled = false; }
    });
    node.append(report);
  }
  return node;
}
function renderMessages() {
  const state = thread(active);
  const ordered = [...state.messages.values()].sort((a, b) => a.id - b.id);
  let position = 0;
  for (const message of ordered) {
    let entry = rendered.get(message.id);
    if (!entry || entry.revision !== message.revision) {
      const node = messageNode(message);
      if (entry) entry.node.replaceWith(node);
      entry = { revision: message.revision, node }; rendered.set(message.id, entry);
    }
    if (messagesEl.children[position] !== entry.node) messagesEl.insertBefore(entry.node, messagesEl.children[position] || null);
    position++;
  }
  el('chat-empty').hidden = !state.loaded || ordered.length > 0;
  older.hidden = !state.more;
}
function merge(state: Thread, incoming: Message[]) {
  for (const message of incoming) {
    const old = state.messages.get(message.id);
    if (!old || old.revision < message.revision) state.messages.set(message.id, message);
  }
}
async function load(id: number) {
  const state = thread(id);
  if (state.loaded) return;
  if (!state.loading) state.loading = (async () => {
    const page = await api<Page>(`/chat/conversations/${id}/messages`);
    merge(state, page.messages); state.cursor = page.cursor; state.more = page.has_more; state.loaded = true;
  })().finally(() => { state.loading = undefined; });
  await state.loading;
}
async function selectRoom(id: number, navigate = true) {
  const room = rooms.find(r => r.id === id);
  if (!room) return;
  rememberPosition();
  active = id;
  if (mobile.matches && navigate && history.state?.chatRoom !== id) {
    history.pushState({ chatRoom: id }, '', `#conversation-${id}`);
  }
  syncView();
  if (mobile.matches) el('chat-title').focus({preventScroll:true});
  rendered.clear(); messagesEl.replaceChildren();
  el('chat-title').textContent = room.name;
  el('chat-audience').textContent = room.kind === 'team' ? 'Everyone with a team account can join in.' : 'Private conversation. Flagged or reported messages may be reviewed by team admins.';
  el('chat-empty').textContent = room.kind === 'team' ? 'No messages yet. Say hello to the team!' : 'Start the conversation with a hello.';
  composer.placeholder = room.kind === 'team' ? 'Write to the team…' : `Message ${room.name}…`;
  error(); latest.hidden = true; older.hidden = true;
  renderRooms(); renderMessages(); updateComposer();
  try {
    await load(id);
    if (id !== active) return;
    renderMessages(); updateComposer();
    const position = thread(id).position;
    if (position && !position.following) scroll.scrollTop = position.top;
    else bottom();
    await updates(id);
  } catch (e) { if (id === active) error((e as Error).message); }
}
const updating = new Map<number, Promise<void>>();
async function updates(id: number) {
  if (updating.has(id)) return updating.get(id);
  const work = (async () => {
    const state = thread(id);
    await load(id);
    let more = true;
    while (more && authenticated) {
      const page = await api<Page>(`/chat/conversations/${id}/messages?after=${state.cursor}`);
      const following = id === active && nearBottom();
      const newMessages = page.messages.filter(m => !state.messages.has(m.id) && !m.deleted_at);
      merge(state, page.messages); state.cursor = page.cursor; more = page.has_more;
      if (id === active) {
        renderMessages(); updateComposer();
        if (following) bottom();
        else if (newMessages.length) latest.hidden = false;
        if (newMessages.length) el('chat-announcement').textContent = `${newMessages.length} new message${newMessages.length === 1 ? '' : 's'} in this conversation.`;
      }
    }
  })().finally(() => updating.delete(id));
  updating.set(id, work);
  return work;
}
async function markRead() {
  if (!active || !authenticated || document.hidden || !nearBottom()) return;
  const id = active, state = thread(id);
  const last = Math.max(0, ...state.messages.keys());
  // A just-sent message may be ahead of incoming messages we have yet to fetch.
  if ([...state.messages.values()].some(message => message.revision > state.cursor)) return;
  if (!state.loaded || !last || last <= state.read || state.reading) return;
  state.reading = true;
  try {
    await api(`/chat/conversations/${id}/read`, 'POST', { message_id: last });
    state.read = last;
    // Fetch authoritative counts on the next refresh, including concurrent arrivals.
  } catch { /* A later poll retries; never mark failed requests as read. */ }
  finally { state.reading = false; }
}
async function refresh() {
  if (refreshing || !authenticated || document.hidden) return;
  refreshing = true;
  try {
    rooms = await api<Room[]>('/chat/conversations');
    if (active && !rooms.some(room => room.id === active)) showConversations();
    if (!active && !mobile.matches && rooms.length) await selectRoom(rooms.find(room => room.kind === 'team')?.id ?? rooms[0].id, false);
    renderRooms();
    if (active) await updates(active);
    await markRead();
    connection.textContent = 'Updates automatically';
  } catch {
    connection.textContent = 'Connection lost · Retrying…';
  } finally { refreshing = false; }
}
composer.addEventListener('input', () => {
  const state = thread(active); state.draft = composer.value;
  resizeComposer();
  send.disabled = !state.loaded || state.sending || !state.draft.trim();
});
composer.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) {
    event.preventDefault();
    if (!send.disabled) el<HTMLFormElement>('chat-compose').requestSubmit();
  }
});
send.addEventListener('pointerdown', event => {
  if (document.activeElement === composer) event.preventDefault();
});
el('chat-compose').addEventListener('submit', async event => {
  event.preventDefault();
  const id = active, state = thread(id), draft = state.draft, text = draft.trim();
  if (!state.loaded || state.sending || !text) return;
  if (!state.pending || state.pending.body !== text) state.pending = { body: text, client_id: crypto.randomUUID() };
  state.sending = true; updateComposer(); error();
  try {
    const message = await api<Message>(`/chat/conversations/${id}/messages`, 'POST', state.pending);
    merge(state, [message]); if (state.draft === draft) state.draft = ''; state.pending = undefined;
    if (id === active) { renderMessages(); bottom(); }
    await refresh();
  } catch (e) { if (id === active) error(`Message not sent. ${(e as Error).message} Your draft is saved here; try Send again.`); }
  finally { state.sending = false; if (id === active) updateComposer(); }
});
el('chat-new').addEventListener('submit', async event => {
  event.preventDefault();
  if (!memberSelect.value) return;
  const button = (event.currentTarget as HTMLFormElement).querySelector('button')!;
  button.disabled = true; error();
  try {
    const room = await api<{ id: number }>('/chat/direct', 'POST', { user_id: Number(memberSelect.value) });
    rooms = await api<Room[]>('/chat/conversations');
    await selectRoom(room.id); memberSelect.value = '';
    (document.querySelector('.chat-start') as HTMLDetailsElement).open = false;
  } catch (e) { error((e as Error).message); }
  finally { button.disabled = false; }
});
older.addEventListener('click', async () => {
  const id = active, state = thread(id), first = Math.min(...state.messages.keys());
  older.disabled = true;
  try {
    const page = await api<Page>(`/chat/conversations/${id}/messages?before=${first}`);
    merge(state, page.messages); state.more = page.has_more;
    if (id === active) {
      const height = scroll.scrollHeight, top = scroll.scrollTop;
      renderMessages(); scroll.scrollTop = top + scroll.scrollHeight - height;
    }
  } catch (e) { error((e as Error).message); }
  finally { older.disabled = false; }
});
scroll.addEventListener('scroll', () => { if (nearBottom()) { latest.hidden = true; void markRead(); } });
latest.addEventListener('click', bottom);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
window.addEventListener('online', () => void refresh());

async function init() {
  try {
    const user = await api<User | null>('/auth/me');
    if (!user) { signedOut(); return; }
    me = user;
    const [conversations, members] = await Promise.all([api<Room[]>('/chat/conversations'), api<Member[]>('/chat/members')]);
    rooms = conversations;
    for (const member of members) memberSelect.add(new Option(member.display_name, String(member.id)));
    el('chat-identity').textContent = `Signed in as ${me.display_name}`;
    loading.hidden = true; shell.hidden = false;
    renderRooms(); syncView();
    const requested = Number(location.hash.match(/^#conversation-(\d+)$/)?.[1]);
    if (rooms.some(room => room.id === requested)) await selectRoom(requested, false);
    else if (!mobile.matches && rooms.length) await selectRoom(rooms.find(r => r.kind === 'team')?.id ?? rooms[0].id, false);
    await refresh();
    window.setInterval(() => void refresh(), 4000);
  } catch (e) {
    if (authenticated) {
      loading.textContent = 'Chat could not load. Check your connection and reload to try again.';
      console.error(e);
    }
  }
}
void init();
