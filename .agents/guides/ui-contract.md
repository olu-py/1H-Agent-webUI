# UI 与主进程通用接口契约

## 适用范围

- 浏览器 UI <-> Rust 主进程稳定边界：换 UI（换 DOM/框架/精简版/未来 TUI）不动服务端。
- 线协议（REST 端点、EventDto 类型集、AppStateDto 快照、protocol_version）+ 前端四层
  transport -> store -> actions -> view；适用于任何消费端（含未来进程内 TUI）。

## 入口

- 服务端：`src/server/dto.rs`（DTO/PROTOCOL_VERSION）、`mod.rs`（ServerCommand/REST 端点）、`events.rs`（EventBridge/seq/replay）。
- 前端：`web/modules/{api,store,actions}.js` 与 `web/views/dom-view.js`。

## 契约

- 线协议：REST 端点（state/messages/input/commands/cancel/activate/approvals/provider/events）语义见 build_router；快照必含 protocol_version、active_session、sessions、provider/model/mode、approval、todos。
- EventDto 22 种（type snake_case、恒带 session_id；字段以 dto.rs 为准，穷尽 tag 测试锁定）。必处理：text/reasoning_delta、tool_*、approval(_resolved)、completed/failed/cancelled、todo_updated、local_command_finished、sessions_changed、child_session_progress；其余可降级，未知 type 静默忽略。
- 前端分层：transport 唯一 fetch/EventSource、错误只走 onError；store 纯状态（getState/subscribe/reduce/applySnapshot + PROTOCOL_VERSION，未知 type 归档）；actions 提供语义 action 集（见 actions.js）；view 只调 actions、禁止直连 transport；挂载点 #app（web/index.html）。
- 任何消费端（含未来 TUI）：命令 = ServerCommand（command_tx，与 HTTP 同通道，禁止第二套命令语义）、事件 = EventBridge::subscribe()/replay()/next_seq()（消费 EventDto，禁止解析 AgentEvent）、快照 = GetState/GetMessages；接入点 run()（command_tx、bridge 均 Clone）。TUI 未实现，仅契约在此。

## 不变量

- 线协议只做加法演进：新增类型/字段须旧 UI 可忽略；禁止改语义/改名/复用旧 type；破坏性变更升 protocol_version（dto.rs 与 store.js 同步）。
- 新增 AgentEvent 变体一次接通：forward -> session.rs handle_event -> DTO -> store/view，漏一处静默丢事件。
- 只有 transport 触网络、view 触 DOM；任何消费端不得另起事件/命令通路。
- Approval oneshot sender 不可序列化：DTO 只带 approval_id；超时按拒绝并发终态。

## 诊断

| 症状 | 检查顺序 |
| --- | --- |
| 前端无事件 / 断线丢流 | SSE 连接 -> 事件桥 -> DTO 分支 -> seq/环形缓冲 |
| 协议版本不匹配 / 新事件静默丢弃 | 服务端 vs store.js 版本；forward -> DTO -> store/view |

## 验证

- `cargo test --lib --all-features --locked dto`（穷尽 22 变体 snake_case tag）。
- 分层：rg 查 store/actions/api 无 DOM、view/alt 无 fetch(/EventSource。
- 文档：`bash scripts/check-agent-docs.sh`、`git diff --check`；冒烟 curl /api/state（含 protocol_version）+ 浏览器流程；换 UI 验收见 webui.md。
