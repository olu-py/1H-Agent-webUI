// DOM view for the full WebUI. This is the replaceable layer of the
// transport -> store -> view split:
//   - it subscribes to the store and renders state/events,
//   - user interactions call semantic actions (actions.js),
//   - it never fetches and never builds an EventSource itself.
// A different UI implementation only needs to replace this file (see
// .agents/guides/ui-contract.md, mount point #app).

import { renderMarkdown } from '../modules/markdown.js';
import { matchCommands } from '../modules/fuzzy.js';
import {
  startEventStream,
  refreshState,
  sendInput,
  sendCommand,
  approve,
  cancelSession,
  activateSession,
  setProvider,
  loadMessages,
} from '../modules/actions.js';
import {
  getState,
  subscribe,
  setStatus,
  forgetLog,
  dismissPendingApproval,
  PROTOCOL_VERSION,
} from '../modules/store.js';

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

// View-local transient/DOM state. The store keeps pure data; anything that is
// a DOM element or purely presentational lives here.
const live = new Map(); // sessionId -> { el, thinking, assistant, tools }
const cluster = new Map(); // childSessionId -> { row, statusEl, detailEl }
const completion = { items: [], selected: 0 };
let todoVisible = false;
let sessionPanelVisible = false;
let stream = null;
let renderedActiveSession = null;
let protocolWarned = false;

// ---------- boot ----------
export function start() {
  populateHomeProvider();
  populateModeSelect();
  bindEvents();
  subscribe(onStoreChange);
  refreshState()
    .then(() => {
      // Keep state fresh on SSE reconnect; every event is reduced into the
      // store, which re-renders through the subscription above.
      stream = startEventStream(() => refreshState().catch(() => {}));
    })
    .catch((err) => {
      console.error('boot failed', err);
      document.body.insertAdjacentHTML(
        'beforeend',
        `<pre style="color:red;padding:20px">${escapeHtml(String(err))}</pre>`
      );
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

// ---------- store subscription ----------
function onStoreChange(state, change) {
  switch (change.kind) {
    case 'status':
      renderStatus();
      break;
    case 'logs':
      if (change.sessionId === state.activeSession) renderMessages();
      break;
    case 'snapshot':
      handleSnapshot();
      break;
    case 'event':
      handleEvent(change.dto);
      break;
    case 'approval':
      renderApproval();
      break;
    default:
      break;
  }
}

// ---------- snapshot rendering ----------
function handleSnapshot() {
  const state = getState();
  const cur = state.activeSession;
  const activeChanged = cur !== renderedActiveSession;
  renderedActiveSession = cur;

  if (
    !protocolWarned &&
    state.protocolVersion != null &&
    state.protocolVersion !== PROTOCOL_VERSION
  ) {
    protocolWarned = true;
    setStatus(`协议版本不匹配：服务端 v${state.protocolVersion}，前端 v${PROTOCOL_VERSION}`);
  }

  renderHomeSessions();
  renderSessionPanel();
  renderMode();
  renderTodos();

  if (cur) {
    showChat();
    updateChatTitle();
    // Reflect the server-side runtime status (e.g. "已撤销上一轮；x 已回滚")
    // instead of a generic placeholder.
    const active = state.sessions.find((s) => s.id === cur);
    if (active && active.status && !state.pendingApproval?.approval_id) {
      setStatus(active.status);
    }
    // Reload the message log only on a session switch (or when it is missing,
    // e.g. after resume). SSE keeps the current conversation live; reloading on
    // every sessions_changed would wipe in-flight streaming and the cluster.
    if (activeChanged || !state.logs.has(cur)) {
      loadMessages(cur).catch(() => {});
    }
  } else {
    showHome();
  }
  renderApproval();
  renderStatus();
}

// ---------- view switching ----------
function showHome() {
  const state = getState();
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
  const state = getState();
  const session = state.sessions.find((s) => s.id === state.activeSession);
  $('chat-session-title').textContent = session?.title || '(新会话)';
  const busy = state.sessions.find((s) => s.id === state.activeSession)?.busy;
  $('chat-session-meta').textContent = `${state.mode.toUpperCase()} · ${state.model}${busy ? ' · 忙碌中' : ''}`;
}

function renderMode() {
  $('chat-mode').value = getState().mode;
}

// ---------- message rendering ----------
function renderMessages() {
  const state = getState();
  const messages = state.logs.get(state.activeSession) || [];
  $('messages').innerHTML = '';
  cluster.clear();
  removeClusterPanel();
  for (const item of messages) {
    appendConversationItem(item);
  }
  scrollMessages();
}

function renderHomeSessions() {
  const list = $('home-sessions');
  list.innerHTML = '';
  const sessions = getState().sessions;
  if (!sessions.length) return;
  for (const s of sessions) {
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
  for (const s of getState().sessions) {
    const li = document.createElement('li');
    li.className = s.id === getState().activeSession ? 'active' : '';
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
  const res = await activateSession(id);
  if (!res.ok) return;
  forgetLog(id);
  await refreshState();
  setStatus('就绪');
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

// ---------- live SSE event rendering ----------
function handleEvent(dto) {
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
      renderApproval();
      break;
    case 'approval_resolved':
      renderApproval();
      break;
    case 'cancelled':
      endLive();
      break;
    case 'completed':
      endLive();
      refreshState().catch(() => {});
      break;
    case 'sessions_changed':
      // A server-side command finished; refresh the snapshot without touching
      // live streaming.
      refreshState().catch(() => {});
      break;
    case 'failed':
      endLive();
      appendError(dto.error);
      break;
    case 'todo_updated':
      renderTodos();
      break;
    case 'local_command_finished':
      if (dto.command === '/diff') {
        appendDiff(dto.result);
      } else {
        finishShell(dto);
      }
      break;
    // web_search_*, provider_retry, model_streaming only update the status bar
    // (handled by the store reducer); nothing to render here.
    default:
      break;
  }
  renderStatus();
}

function liveRoot() {
  const sessionId = getState().activeSession;
  let root = live.get(sessionId);
  if (!root) {
    root = { el: null, thinking: null, assistant: null, tools: [] };
    live.set(sessionId, root);
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
  // Keep the last assistant element, drop the transient thinking block if it
  // never produced text.
  live.delete(getState().activeSession);
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
  let entry = cluster.get(childId);
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
    cluster.set(childId, entry);
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
  if (cluster.size === 0) return false;
  for (const entry of cluster.values()) {
    const cls = entry.statusEl.className;
    if (!/completed|failed/.test(cls)) return false;
  }
  return true;
}

function removeClusterPanel() {
  const panel = document.querySelector('.cluster-panel');
  if (panel) panel.remove();
  cluster.clear();
}

function prettyJson(value) {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

// ---------- approval modal ----------
function renderApproval() {
  const dto = getState().pendingApproval;
  if (dto && dto.approval_id) {
    $('approval-reason').textContent = dto.reason || '允许执行此工具调用？';
    $('approval-call').textContent = prettyJson({
      name: dto.call?.name,
      arguments: dto.call?.arguments,
    });
    $('approval').classList.remove('hidden');
  } else {
    $('approval').classList.add('hidden');
  }
}

async function resolveApproval(accept) {
  await approve(accept);
}

// ---------- todo ----------
function renderTodos() {
  const list = $('todo-list');
  list.innerHTML = '';
  const todos = getState().todos;
  if (!todos.length) {
    list.innerHTML = '<li style="color:var(--fg-dim)">暂无任务</li>';
    return;
  }
  todos.forEach((task, index) => {
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
  todoVisible = force ?? !todoVisible;
  $('todo-window').classList.toggle('hidden', !todoVisible);
}

async function sendTodoAction(action, index) {
  const cmd = action === 'add' ? `/todo add ` : `/todo ${action} ${index}`;
  const res = await sendCommand(cmd);
  if (!res.ok) setStatus(`todo 失败：${res.err?.message}`);
}

// ---------- status ----------
function renderStatus() {
  const { status } = getState();
  const el = $('chat-status');
  el.textContent = status.text;
  el.className = `status${status.busy ? ' busy' : ''}`;
}

// ---------- composer + completion ----------
function updateCompletion() {
  const value = $('composer').value;
  const box = $('completion');
  const isCommand = value.trim().startsWith('/');
  if (!isCommand) {
    box.classList.add('hidden');
    completion.items = [];
    return;
  }
  const query = value.trim().slice(1);
  completion.items = matchCommands(query);
  completion.selected = 0;
  if (!completion.items.length) {
    box.classList.add('hidden');
    return;
  }
  renderCompletion();
  box.classList.remove('hidden');
}

function renderCompletion() {
  const box = $('completion');
  box.innerHTML = '';
  completion.items.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = `completion-item${index === completion.selected ? ' selected' : ''}`;
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
  if (!completion.items.length) return;
  completion.selected =
    (completion.selected + delta + completion.items.length) % completion.items.length;
  renderCompletion();
}

async function sendInputFromComposer() {
  const text = $('composer').value.trim();
  if (!text) return;
  const sid = getState().activeSession;
  $('composer').value = '';
  $('completion').classList.add('hidden');
  if (!(text.startsWith('/') || text.startsWith('!'))) {
    // Regular message: append a user bubble immediately for snappy feedback.
    appendUserBubble(text);
  }
  const res = await sendInput(text);
  if (!res.ok) return;
  // Commands that rewrite the conversation head (undo/redo) need the message
  // log reloaded to reflect the rolled-back file snapshots; `sessions_changed`
  // no longer reloads it (to keep live streaming intact).
  const headRewriter = text.startsWith('/undo') || text.startsWith('/redo');
  if (headRewriter && sid) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await loadMessages(sid);
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
  await setProvider(preset, model || PROVIDERS.find((p) => p.id === preset)?.model || '');
  // First message creates the session ("new" sentinel) and submits.
  $('home-input').value = '';
  await sendInput(text, { create: true, status: '创建会话…' });
  // Wait a moment for the session to be created, then switch to chat.
  await refreshState();
}

// ---------- events ----------
function bindEvents() {
  $('home-form').addEventListener('submit', homeSubmit);
  $('home-resume').addEventListener('click', () => {
    const sessions = getState().sessions;
    if (sessions.length) {
      resumeSession(sessions[0].id);
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

  $('composer-send').addEventListener('click', sendInputFromComposer);
  $('composer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (completion.items.length) {
        applyCompletion(completion.items[completion.selected].cmd);
      } else {
        sendInputFromComposer();
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
      dismissPendingApproval();
      // Esc during an active request cancels it (equivalent to the TUI Esc).
      const state = getState();
      const busy = state.sessions.find((s) => s.id === state.activeSession)?.busy;
      if (busy && state.activeSession) {
        cancelSession();
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
    const res = await sendCommand(`/${mode}`);
    if (!res.ok) {
      setStatus(`切换失败：${res.err?.message}`);
      return;
    }
    setStatus(`模式已切换为 ${mode.toUpperCase()}`);
    // Re-sync the snapshot so mode reflects the server-authoritative value.
    refreshState().catch(() => {});
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
  sessionPanelVisible = force ?? !sessionPanelVisible;
  $('session-panel').classList.toggle('hidden', !sessionPanelVisible);
  if (sessionPanelVisible) renderSessionPanel();
}
