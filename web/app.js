import { api, openEventStream } from './modules/api.js';
import { renderMarkdown } from './modules/markdown.js';
import { matchCommands } from './modules/fuzzy.js';

const $ = (id) => document.getElementById(id);

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', model: 'gpt-5-mini' },
  { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-v4-flash' },
  { id: 'qwen', label: 'Qwen / Bailian', model: 'qwen3.8-max' },
  { id: 'volcano', label: 'Volcano Ark', model: 'doubao-seed-2-1-pro-260628' },
  { id: 'custom', label: 'Custom compatible', model: '' },
];

const MODES = [
  { id: 'build', label: '构建' },
  { id: 'plan', label: '计划' },
  { id: 'explore', label: '探索' },
  { id: 'cluster', label: '集群' },
];

const state = {
  activeSession: null,
  sessions: [],
  provider: 'openai',
  model: 'gpt-5-mini',
  mode: 'build',
  // message log keyed by session id -> array of rendered entry objects
  logs: new Map(),
  // live streaming entries keyed by session id
  live: new Map(),
  todoVisible: false,
  todos: [],
  pendingApproval: null,
  stream: null,
  completion: [],
  completionSelected: 0,
  sessionPanelVisible: false,
  // Cluster batch: child session id -> rendered status row element.
  cluster: new Map(),
};

// ---------- boot ----------
async function boot() {
  populateHomeProvider();
  populateModeSelect();
  bindEvents();
  await refreshState();

  // Keep state fresh on SSE reconnect.
  state.stream = openEventStream({
    onOpen: () => refreshState().catch(() => {}),
    onEvent: handleEvent,
  });
}

function populateHomeProvider() {
  const select = $('home-provider');
  select.innerHTML = '';
  for (const p of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    select.appendChild(opt);
  }
}

function populateModeSelect() {
  const select = $('chat-mode');
  select.innerHTML = '';
  for (const m of MODES) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    select.appendChild(opt);
  }
}

// ---------- state refresh ----------
async function refreshState() {
  let data;
  try {
    data = await api.getState();
  } catch (err) {
    setStatus(`连接失败：${err.message}`);
    return;
  }
  const previousActive = state.activeSession;
  state.sessions = data.sessions || [];
  state.activeSession = data.active_session;
  state.provider = data.provider.toLowerCase() === 'openai' ? 'openai'
    : data.provider.toLowerCase() === 'deepseek' ? 'deepseek'
    : data.provider.toLowerCase() === 'qwen / bailian' ? 'qwen'
    : data.provider.toLowerCase() === 'volcano ark' ? 'volcano'
    : 'custom';
  state.model = data.model;
  state.mode = data.mode;
  state.todos = data.todos || [];

  renderHomeSessions();
  renderSessionPanel();
  renderMode();
  renderTodos();

  if (data.active_session) {
    showChat();
    updateChatTitle();
    // Reflect the server-side runtime status (e.g. "已撤销上一轮；x 已回滚")
    // instead of a generic placeholder.
    const active = (data.sessions || []).find((s) => s.id === data.active_session);
    if (active && active.status && !data.pendingApproval?.approval_id) {
      setStatus(active.status);
    }
    // Reload the message log only on a session switch. SSE keeps the current
    // conversation live; reloading on every `sessions_changed` (e.g. when a
    // child agent spawns) would wipe in-flight streaming and the cluster panel.
    if (data.active_session !== previousActive) {
      await loadMessages(data.active_session);
    }
  } else {
    showHome();
  }

  // Surface any existing approval (e.g. restored after reload).
  if (data.approval && data.approval.approval_id) {
    showApproval(data.approval);
  }
}

// ---------- view switching ----------
function showHome() {
  $('home').classList.remove('hidden');
  $('chat').classList.add('hidden');
  $('home-model').value = state.model;
  $('home-provider').value = state.provider;
}

function showChat() {
  $('home').classList.add('hidden');
  $('chat').classList.remove('hidden');
}

function updateChatTitle() {
  const session = state.sessions.find((s) => s.id === state.activeSession);
  $('chat-session-title').textContent = session?.title || '(新会话)';
  const busy = state.sessions.find((s) => s.id === state.activeSession)?.busy;
  $('chat-session-meta').textContent = `${state.mode.toUpperCase()} · ${state.model}${busy ? ' · 忙碌中' : ''}`;
}

function renderMode() {
  $('chat-mode').value = state.mode;
}

// ---------- message rendering ----------
function renderHomeSessions() {
  const list = $('home-sessions');
  list.innerHTML = '';
  if (!state.sessions.length) return;
  for (const s of state.sessions) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="session-title"></span><span class="session-meta"></span>`;
    li.querySelector('.session-title').textContent = s.title || '(无标题)';
    li.querySelector('.session-meta').textContent = s.busy ? '● 忙碌' : (s.phase || '');
    li.addEventListener('click', () => resumeSession(s.id));
    list.appendChild(li);
  }
}

function renderSessionPanel() {
  const list = $('session-list');
  list.innerHTML = '';
  for (const s of state.sessions) {
    const li = document.createElement('li');
    li.className = s.id === state.activeSession ? 'active' : '';
    const title = document.createElement('span');
    title.textContent = s.title || '(无标题)';
    const meta = document.createElement('span');
    meta.className = 's-busy';
    meta.textContent = s.busy ? '●' : '';
    li.append(title, meta);
    li.addEventListener('click', () => {
      resumeSession(s.id);
      toggleSessionPanel(false);
    });
    list.appendChild(li);
  }
}

async function resumeSession(id) {
  setStatus('切换会话…', true);
  // Tell the server which session is active so events route to the right
  // runtime; the UI then reloads its message log for that session.
  try {
    await api.activate(id);
  } catch (err) {
    setStatus(`切换失败：${err.message}`);
    return;
  }
  state.activeSession = id;
  state.logs.delete(id); // force reload below
  showChat();
  updateChatTitle();
  await loadMessages(id);
  setStatus('就绪');
}

async function loadMessages(sessionId) {
  let messages;
  try {
    messages = await api.getMessages(sessionId);
  } catch {
    messages = [];
  }
  state.logs.set(sessionId, []);
  $('messages').innerHTML = '';
  state.cluster.clear();
  for (const item of messages) {
    appendConversationItem(item);
  }
  scrollMessages();
}

function messageContainer() {
  return $('messages');
}

function appendRendered(entry) {
  messageContainer().appendChild(entry.el);
}

// Builds a DOM entry for a conversation item (from GET /messages).
function appendConversationItem(item) {
  const el = document.createElement('div');
  el.className = 'msg';
  switch (item.type) {
    case 'message': {
      if (item.role === 'user') {
        el.classList.add('user');
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = item.content;
        el.append(bubble);
      } else if (item.role === 'assistant') {
        const bubble = document.createElement('div');
        bubble.className = 'bubble markdown';
        bubble.innerHTML = renderMarkdown(item.content);
        el.append(bubble);
      } else {
        el.classList.add('system');
        const bubble = document.createElement('div');
        bubble.className = 'bubble markdown';
        bubble.innerHTML = renderMarkdown(item.content);
        el.append(bubble);
      }
      break;
    }
    case 'thinking_summary': {
      el.classList.add('thinking');
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = `<div class="msg-label">思考</div><div class="think-text"></div>`;
      bubble.querySelector('.think-text').textContent = item.content;
      el.append(bubble);
      break;
    }
    case 'compaction_summary': {
      el.classList.add('system');
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = `（已压缩 ${item.content}）`;
      el.append(bubble);
      break;
    }
    case 'context': {
      el.classList.add('system');
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.innerHTML = `<div class="msg-label">@ ${escapeHtml(item.label)}</div><div class="think-text"></div>`;
      bubble.querySelector('.think-text').textContent = item.content;
      el.append(bubble);
      break;
    }
    default:
      return;
  }
  appendRendered({ el });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function scrollMessages() {
  const m = $('messages');
  m.scrollTop = m.scrollHeight;
}

// ---------- live SSE event handling ----------
function handleEvent(dto) {
  const sid = dto.session_id;
  // Ignore events for non-active sessions (kept minimal; a full multi-session
  // log is future work).
  if (state.activeSession && sid !== state.activeSession) return;

  switch (dto.type) {
    case 'reasoning_delta':
      ensureLiveThinking();
      appendLiveThinking(dto.delta);
      break;
    case 'text_delta':
      ensureLiveAssistant();
      appendLiveText(dto.delta);
      break;
    case 'tool_started':
      startToolCard(dto.call);
      break;
    case 'tool_finished':
      finishToolCard(dto.call, dto.result);
      break;
    case 'child_session_progress':
      upsertClusterRow(dto);
      break;
    case 'approval':
      showApproval(dto);
      break;
    case 'approval_resolved':
      hideApproval();
      setStatus(dto.approved ? '已批准' : '已拒绝');
      break;
    case 'cancelled':
      endLive();
      setStatus(`已取消：${dto.reason}`);
      break;
    case 'completed':
      endLive();
      setStatus('就绪');
      refreshState().catch(() => {});
      break;
    case 'sessions_changed':
      // A server-side command finished; refresh status bar and clear the
      // transient "发送中…" state without disturbing live streaming.
      setStatus('就绪');
      refreshState().catch(() => {});
      break;
    case 'failed':
      endLive();
      setStatus(`失败：${dto.error}`);
      appendError(dto.error);
      break;
    case 'todo_updated':
      state.todos = dto.tasks || [];
      renderTodos();
      break;
    case 'local_command_finished':
      if (dto.command === '/diff') {
        appendDiff(dto.result);
      } else {
        finishShell(dto);
      }
      break;
    case 'web_search_started':
      setStatus(`正在联网搜索：${dto.query}`);
      break;
    case 'web_search_completed':
      setStatus(`联网搜索完成：${dto.count} 条结果`);
      break;
    case 'provider_retry':
      setStatus(`请求失败，${Math.ceil(dto.delay_ms / 1000)} 秒后第 ${dto.attempt} 次重试`);
      break;
    case 'model_streaming':
      setStatus('等待模型响应…');
      break;
    default:
      break;
  }
}

function liveRoot() {
  let root = state.live.get(state.activeSession);
  if (!root) {
    root = { el: null, thinking: null, assistant: null, tools: [] };
    state.live.set(state.activeSession, root);
  }
  return root;
}

function ensureLiveThinking() {
  const root = liveRoot();
  if (root.thinking) return;
  const el = document.createElement('div');
  el.className = 'msg thinking';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = `<div class="msg-label">思考</div><div class="think-text"></div>`;
  el.appendChild(bubble);
  root.thinking = bubble.querySelector('.think-text');
  root.el = el;
  messageContainer().appendChild(el);
  scrollMessages();
}

function appendLiveThinking(delta) {
  ensureLiveThinking();
  const root = liveRoot();
  root.thinking.textContent += delta;
  scrollMessages();
}

function ensureLiveAssistant() {
  const root = liveRoot();
  if (root.assistant) return;
  const el = document.createElement('div');
  el.className = 'msg';
  const bubble = document.createElement('div');
  bubble.className = 'bubble markdown';
  el.appendChild(bubble);
  root.assistant = bubble;
  // If a thinking block is live, insert after it.
  if (root.el) {
    root.el.after(el);
  } else {
    messageContainer().appendChild(el);
  }
  root.el = el;
  scrollMessages();
}

function appendLiveText(delta) {
  ensureLiveAssistant();
  const root = liveRoot();
  root.assistant.innerHTML = renderMarkdown(root.assistant.dataset.text + delta);
  root.assistant.dataset.text = (root.assistant.dataset.text || '') + delta;
  scrollMessages();
}

function startToolCard(call) {
  const root = liveRoot();
  const el = document.createElement('div');
  el.className = 'msg';
  el.innerHTML = `<div class="tool-card">
    <div class="tool-head"><span class="tool-name"></span><span class="tool-status running">运行中</span></div>
    <div class="tool-args"></div>
  </div>`;
  el.querySelector('.tool-name').textContent = call.name;
  el.querySelector('.tool-args').textContent = prettyJson(call.arguments);
  el.dataset.callId = call.id;
  if (root.el) root.el.after(el); else messageContainer().appendChild(el);
  root.el = el;
  root.tools.push({ id: call.id, el, statusEl: el.querySelector('.tool-status') });
  scrollMessages();
}

function finishToolCard(call, result) {
  const root = liveRoot();
  const card = root.tools.find((t) => t.id === call.id);
  if (!card) return;
  const ok = /exit_code: 0/.test(result) || !/error|失败|exit_code: [1-9]/.test(result);
  card.statusEl.textContent = ok ? '完成' : '失败';
  card.statusEl.className = `tool-status ${ok ? 'completed' : 'failed'}`;
  const resultEl = document.createElement('div');
  resultEl.className = 'tool-result';
  resultEl.textContent = result;
  card.el.querySelector('.tool-card').appendChild(resultEl);
  scrollMessages();
}

function finishShell(dto) {
  const root = liveRoot();
  const el = document.createElement('div');
  el.className = 'msg';
  el.innerHTML = `<div class="tool-card">
    <div class="tool-head"><span class="tool-name">terminal_shell</span><span class="tool-status completed">完成</span></div>
    <div class="tool-args"></div><div class="tool-result"></div>
  </div>`;
  el.querySelector('.tool-args').textContent = dto.command;
  el.querySelector('.tool-result').textContent = dto.result;
  if (root.el) root.el.after(el); else messageContainer().appendChild(el);
  root.el = el;
  scrollMessages();
  setStatus('就绪');
}

function appendDiff(text) {
  const root = liveRoot();
  const el = document.createElement('div');
  el.className = 'msg diff';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  el.appendChild(bubble);
  messageContainer().appendChild(el);
  if (root.el) root.el.after(el);
  root.el = el;
  scrollMessages();
  setStatus('Git diff 已准备好');
}

function appendError(text) {
  const el = document.createElement('div');
  el.className = 'msg error';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  el.appendChild(bubble);
  messageContainer().appendChild(el);
  scrollMessages();
}

function endLive() {
  const root = state.live.get(state.activeSession);
  if (root) {
    // Keep the last assistant element, drop the transient thinking block if it
    // never produced text.
    state.live.delete(state.activeSession);
  }
}

// ---------- cluster batch panel ----------
// The wire contract coalesces every non-terminal status into "running";
// turn/tool carry the finer-grained detail, so all running states share one
// label while terminal states keep their specific wording.
const CLUSTER_STATUS_LABEL = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  turn_limit: '达到轮次上限',
  timed_out: '执行超时',
  cancelled: '已取消',
};
const CLUSTER_STATUS_CLASS = {
  completed: 'completed',
  failed: 'failed',
  turn_limit: 'failed',
  timed_out: 'failed',
  cancelled: 'failed',
};

function upsertClusterRow(dto) {
  const childId = dto.child_session_id;
  const label = CLUSTER_STATUS_LABEL[dto.status] || dto.status;
  let entry = state.cluster.get(childId);
  if (!entry) {
    // First event for this child: lazily create the batch panel and a row.
    const panel = ensureClusterPanel();
    const row = document.createElement('div');
    row.className = 'cluster-row';
    row.innerHTML = `
      <span class="cluster-child"></span>
      <span class="cluster-status"></span>
      <span class="cluster-detail"></span>
    `;
    row.querySelector('.cluster-child').textContent = `子会话 ${childId.slice(0, 8)}`;
    row.querySelector('.cluster-child').title = childId;
    panel.appendChild(row);
    entry = { row, statusEl: row.querySelector('.cluster-status'), detailEl: row.querySelector('.cluster-detail') };
    state.cluster.set(childId, entry);
  }
  entry.statusEl.textContent = label;
  entry.statusEl.className = `cluster-status ${CLUSTER_STATUS_CLASS[dto.status] || ''}`;
  const detail = [];
  if (dto.max_turns > 0) {
    detail.push(`${dto.turn}/${dto.max_turns} 轮`);
  } else if (dto.turn > 0) {
    detail.push(`第 ${dto.turn} 轮`);
  }
  if (dto.tool) detail.push(dto.tool);
  entry.detailEl.textContent = detail.join(' · ');
  // A terminal status ends the live batch once every child has finished; drop
  // the panel so the next batch starts fresh.
  if (CLUSTER_STATUS_CLASS[dto.status] && allClusterTerminal()) {
    removeClusterPanel();
  }
  scrollMessages();
}

function ensureClusterPanel() {
  let panel = document.querySelector('.cluster-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'msg cluster-panel';
    panel.innerHTML = `<div class="cluster-head">集群批次</div>`;
    messageContainer().appendChild(panel);
  }
  return panel;
}

function allClusterTerminal() {
  if (state.cluster.size === 0) return false;
  for (const entry of state.cluster.values()) {
    const cls = entry.statusEl.className;
    if (!/completed|failed/.test(cls)) return false;
  }
  return true;
}

function removeClusterPanel() {
  const panel = document.querySelector('.cluster-panel');
  if (panel) panel.remove();
  state.cluster.clear();
}

function prettyJson(value) {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

// ---------- approval modal ----------
function showApproval(dto) {
  state.pendingApproval = dto;
  $('approval-reason').textContent = dto.reason || '允许执行此工具调用？';
  $('approval-call').textContent = prettyJson({
    name: dto.call?.name,
    arguments: dto.call?.arguments,
  });
  $('approval').classList.remove('hidden');
}

function hideApproval() {
  state.pendingApproval = null;
  $('approval').classList.add('hidden');
}

async function resolveApproval(accept) {
  const dto = state.pendingApproval;
  if (!dto) return;
  hideApproval();
  try {
    await api.approve(dto.approval_id, accept);
  } catch (err) {
    setStatus(`审批失败：${err.message}`);
  }
}

// ---------- todo ----------
function renderTodos() {
  const list = $('todo-list');
  list.innerHTML = '';
  if (!state.todos.length) {
    list.innerHTML = '<li style="color:var(--fg-dim)">暂无任务</li>';
    return;
  }
  state.todos.forEach((task, index) => {
    const li = document.createElement('li');
    li.className = task.status === 'done' ? 'done' : '';
    const statusBtn = document.createElement('span');
    statusBtn.className = 'todo-status';
    statusBtn.textContent = task.status === 'done' ? '●' : task.status === 'in_progress' ? '◐' : '○';
    statusBtn.addEventListener('click', async () => {
      const next = task.status === 'pending' ? 'doing'
        : task.status === 'in_progress' ? 'done'
        : 'undo';
      await sendTodoAction(next, index + 1);
    });
    const title = document.createElement('span');
    title.className = 'todo-title';
    title.textContent = task.title;
    li.append(statusBtn, title);
    list.appendChild(li);
  });
}

function toggleTodo(force) {
  state.todoVisible = force ?? !state.todoVisible;
  $('todo-window').classList.toggle('hidden', !state.todoVisible);
}

async function sendTodoAction(action, index) {
  const sid = state.activeSession;
  const cmd = action === 'add' ? `/todo add ` : `/todo ${action} ${index}`;
  try {
    await api.command(sid, cmd);
  } catch (err) {
    setStatus(`todo 失败：${err.message}`);
  }
}

// ---------- status ----------
function setStatus(text, busy = false) {
  const el = $('chat-status');
  el.textContent = text;
  el.className = `status${busy ? ' busy' : ''}`;
}

// ---------- composer + completion ----------
function updateCompletion() {
  const value = $('composer').value;
  const box = $('completion');
  const isCommand = value.trim().startsWith('/');
  if (!isCommand) {
    box.classList.add('hidden');
    state.completion = [];
    return;
  }
  const query = value.trim().slice(1);
  state.completion = matchCommands(query);
  state.completionSelected = 0;
  if (!state.completion.length) {
    box.classList.add('hidden');
    return;
  }
  renderCompletion();
  box.classList.remove('hidden');
}

function renderCompletion() {
  const box = $('completion');
  box.innerHTML = '';
  state.completion.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = `completion-item${index === state.completionSelected ? ' selected' : ''}`;
    div.innerHTML = `<span></span><span class="desc"></span>`;
    div.querySelector('span').textContent = item.cmd;
    div.querySelector('.desc').textContent = item.desc;
    div.addEventListener('click', () => applyCompletion(item.cmd));
    box.appendChild(div);
  });
}

function applyCompletion(cmd) {
  $('composer').value = `${cmd} `;
  $('completion').classList.add('hidden');
  $('composer').focus();
}

function moveCompletion(delta) {
  if (!state.completion.length) return;
  state.completionSelected =
    (state.completionSelected + delta + state.completion.length) % state.completion.length;
  renderCompletion();
}

async function sendInput() {
  const text = $('composer').value.trim();
  if (!text) return;
  const sid = state.activeSession;
  $('composer').value = '';
  $('completion').classList.add('hidden');
  if (text.startsWith('/')) {
    // Slash commands are executed server-side; the response arrives over SSE.
  } else if (text.startsWith('!')) {
    // Shell approval; the modal arrives over SSE.
  } else {
    // Regular message: append a user bubble immediately for snappy feedback.
    appendUserBubble(text);
  }
  setStatus('发送中…', true);
  try {
    await api.input(sid, text);
    // Commands that rewrite the conversation head (undo/redo) need the message
    // log reloaded to reflect the rolled-back file snapshots; `sessions_changed`
    // no longer reloads it (to keep live streaming intact).
    const headRewriter = text.startsWith('/undo') || text.startsWith('/redo');
    if (headRewriter && sid) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await loadMessages(sid);
    }
  } catch (err) {
    setStatus(`发送失败：${err.message}`);
  }
}

function appendUserBubble(text) {
  const el = document.createElement('div');
  el.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  el.appendChild(bubble);
  messageContainer().appendChild(el);
  scrollMessages();
}

// ---------- home actions ----------
async function homeSubmit(e) {
  e.preventDefault();
  const text = $('home-input').value.trim();
  const preset = $('home-provider').value;
  const model = $('home-model').value.trim();
  if (!text) return;
  // Apply provider/model selection first (non-secret fields only).
  try {
    await api.setProvider(preset, model || PROVIDERS.find((p) => p.id === preset)?.model || '');
  } catch {
    // Provider settings failure is not fatal; proceed with the message.
  }
  // First message creates the session ("new" sentinel) and submits.
  $('home-input').value = '';
  setStatus('创建会话…', true);
  try {
    await api.input(null, text);
    // Wait a moment for the session to be created, then switch to chat.
    await refreshState();
  } catch (err) {
    setStatus(`失败：${err.message}`);
  }
}

// ---------- events ----------
function bindEvents() {
  $('home-form').addEventListener('submit', homeSubmit);
  $('home-resume').addEventListener('click', () => {
    if (state.sessions.length) {
      const first = state.sessions[0].id;
      resumeSession(first);
    } else {
      setStatus('暂无历史会话');
    }
  });
  $('home-provider').addEventListener('change', () => {
    const preset = $('home-provider').value;
    const def = PROVIDERS.find((p) => p.id === preset);
    if (def && !$('home-model').value.trim()) {
      $('home-model').value = def.model;
    }
  });

  $('composer-send').addEventListener('click', sendInput);
  $('composer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (state.completion.length) {
        applyCompletion(state.completion[state.completionSelected].cmd);
      } else {
        sendInput();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveCompletion(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveCompletion(-1);
    } else if (e.key === 'Escape') {
      $('completion').classList.add('hidden');
      toggleTodo(false);
      hideApproval();
      // Esc during an active request cancels it (equivalent to the TUI Esc).
      const busy = state.sessions.find((s) => s.id === state.activeSession)?.busy;
      if (busy && state.activeSession) {
        setStatus('正在取消…', true);
        api.cancel(state.activeSession).catch((err) => setStatus(`取消失败：${err.message}`));
      }
    }
  });
  $('composer').addEventListener('input', updateCompletion);
  $('composer').addEventListener('keyup', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
    updateCompletion();
  });

  $('btn-home').addEventListener('click', () => {
    showHome();
    refreshState().catch(() => {});
  });
  $('btn-todo').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTodo();
  });
  $('todo-close').addEventListener('click', () => toggleTodo(false));
  $('todo-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('todo-input').value.trim();
    if (text) {
      sendTodoAction('add', 0).then(() => {
        $('todo-input').value = '';
      });
    }
  });
  $('btn-sessions').addEventListener('click', (e) => {
    // Stop the event from reaching the document-level "click outside" closer
    // (which would immediately undo the toggle).
    e.stopPropagation();
    toggleSessionPanel();
  });

  $('chat-mode').addEventListener('change', async () => {
    const mode = $('chat-mode').value;
    try {
      await api.command(state.activeSession, `/${mode}`);
      setStatus(`模式已切换为 ${mode.toUpperCase()}`);
      state.mode = mode;
    } catch (err) {
      setStatus(`切换失败：${err.message}`);
    }
  });

  $('approval-reject').addEventListener('click', () => resolveApproval(false));
  $('approval-accept').addEventListener('click', () => resolveApproval(true));

  // Click on chat area closes the session panel, unless the click is on the
  // toggle button or inside the panel itself. `closest()` handles any target
  // node (text runs, child elements) rather than requiring an exact id match.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#session-panel, #btn-sessions')) {
      toggleSessionPanel(false);
    }
  });
}

function toggleSessionPanel(force) {
  state.sessionPanelVisible = force ?? !state.sessionPanelVisible;
  $('session-panel').classList.toggle('hidden', !state.sessionPanelVisible);
  if (state.sessionPanelVisible) renderSessionPanel();
}

boot().catch((err) => {
  console.error('boot failed', err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:red;padding:20px">${escapeHtml(String(err))}</pre>`);
});
