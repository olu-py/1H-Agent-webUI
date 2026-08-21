// Minimal alternative UI: a disposable proof that swapping the view layer
// needs no server change and no store/action/transport rewrite. It reuses
// ../modules/{store,actions,api}.js unchanged; only the rendering differs.
// Mount point: web/alt/index.html (see .agents/guides/ui-contract.md).
import { getState, subscribe, setStatus, PROTOCOL_VERSION } from '../modules/store.js';
import {
  refreshState,
  startEventStream,
  sendInput,
  approve,
  cancelSession,
  activateSession,
} from '../modules/actions.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');

// sessionId -> { live: { key: <DOM element> } } for streaming entries.
const currentLog = new Map();
let lastSession = null;
let protocolWarned = false;

function append(el) {
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
}

function msgEl(text, cls) {
  const el = document.createElement('div');
  el.className = `msg ${cls || ''}`;
  el.textContent = text;
  return el;
}

function renderSessions() {
  const { sessions, activeSession } = getState();
  const wrap = $('sessions');
  wrap.innerHTML = '';
  if (!sessions.length) {
    const span = document.createElement('span');
    span.textContent = '（无会话，输入首条消息创建）';
    wrap.appendChild(span);
    return;
  }
  for (const s of sessions) {
    const btn = document.createElement('button');
    btn.textContent = `${s.title || '(无标题)'}${s.id === activeSession ? ' ●' : ''}${s.busy ? ' …' : ''}`;
    btn.addEventListener('click', async () => {
      await activateSession(s.id);
      await refreshState();
    });
    wrap.appendChild(btn);
  }
}

function renderLog() {
  const state = getState();
  const messages = state.logs.get(state.activeSession) || [];
  logEl.innerHTML = '';
  currentLog.clear();
  for (const item of messages) {
    if (item.type === 'message') {
      append(msgEl(item.content, item.role === 'user' ? 'user' : 'assistant'));
    } else if (item.type === 'thinking_summary') {
      append(msgEl(`思考：${item.content}`, 'thinking'));
    } else if (item.type === 'compaction_summary') {
      append(msgEl(`（已压缩 ${item.content}）`, 'tool'));
    } else if (item.type === 'context') {
      append(msgEl(`@ ${item.label}：${item.content}`, 'tool'));
    }
  }
}

function liveEntry(sessionId, key, make) {
  let root = currentLog.get(sessionId);
  if (!root) {
    root = { live: {} };
    currentLog.set(sessionId, root);
  }
  if (!root.live[key]) root.live[key] = make();
  return root.live[key];
}

function handleEvent(dto) {
  switch (dto.type) {
    case 'reasoning_delta': {
      const el = liveEntry(dto.session_id, 'thinking', () => append(msgEl('', 'thinking')));
      el.textContent += dto.delta;
      break;
    }
    case 'text_delta': {
      const el = liveEntry(dto.session_id, 'text', () => append(msgEl('', 'assistant')));
      el.textContent += dto.delta;
      break;
    }
    case 'tool_started': {
      const el = liveEntry(dto.session_id, `tool-${dto.call.id}`, () => append(msgEl('', 'tool')));
      el.textContent = `⚙ ${dto.call.name} …`;
      break;
    }
    case 'tool_finished': {
      const el = liveEntry(dto.session_id, `tool-${dto.call.id}`, () => append(msgEl('', 'tool')));
      el.textContent = `⚙ ${dto.call.name} 完成`;
      break;
    }
    case 'child_session_progress': {
      const el = liveEntry(dto.session_id, `child-${dto.child_session_id}`, () => append(msgEl('', 'tool')));
      el.textContent = `子会话 ${dto.child_session_id.slice(0, 8)}：${dto.status}${dto.turn ? `（${dto.turn}/${dto.max_turns} 轮）` : ''}`;
      break;
    }
    case 'approval':
    case 'approval_resolved':
      renderApproval();
      break;
    case 'completed':
    case 'sessions_changed':
      refreshState().catch(() => {});
      break;
    default:
      break;
  }
  renderStatus();
}

function renderApproval() {
  const dto = getState().pendingApproval;
  const box = $('approval');
  if (dto && dto.approval_id) {
    $('approval-reason').textContent = dto.reason || '允许执行此工具调用？';
    $('approval-call').textContent = JSON.stringify(dto.call, null, 2);
    box.classList.add('open');
  } else {
    box.classList.remove('open');
  }
}

function renderStatus() {
  $('status').textContent = getState().status.text;
}

function onStoreChange(state, change) {
  switch (change.kind) {
    case 'status':
      renderStatus();
      break;
    case 'logs':
      if (change.sessionId === state.activeSession) renderLog();
      break;
    case 'snapshot':
      if (state.activeSession !== lastSession) {
        lastSession = state.activeSession;
        renderLog();
      }
      renderSessions();
      renderApproval();
      if (!protocolWarned && state.protocolVersion != null && state.protocolVersion !== PROTOCOL_VERSION) {
        protocolWarned = true;
        setStatus(`协议版本不匹配：服务端 v${state.protocolVersion} ≠ 前端 v${PROTOCOL_VERSION}`);
      }
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

async function send() {
  const text = $('composer').value.trim();
  if (!text) return;
  $('composer').value = '';
  if (!text.startsWith('/') && !text.startsWith('!')) {
    append(msgEl(text, 'user'));
  }
  await sendInput(text);
}

function boot() {
  subscribe(onStoreChange);
  $('send').addEventListener('click', send);
  $('composer').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $('approval-accept').addEventListener('click', () => approve(true));
  $('approval-reject').addEventListener('click', () => approve(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancelSession();
  });
  refreshState()
    .then(() => startEventStream(() => refreshState().catch(() => {})))
    .catch((err) => {
      $('status').textContent = `启动失败：${err.message}`;
    });
}

boot();
