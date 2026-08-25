# UI 与主进程通用接口契约（v2）

## 适用范围

- 浏览器 UI <-> Rust 主进程稳定边界：换 UI（换 DOM/框架/精简版/未来 TUI/Desktop）不动核心。
- 线协议（REST 端点、Event 类型集、AppSnapshotV2 快照、protocol_version）+ 前端四层
  transport -> store -> actions -> view；适用于任何消费端（含进程内 TUI 与 Desktop IPC）。

## 入口

- 独立 core 仓库：`src/protocol.rs`（Envelope/Event/MessageDto/PROTOCOL_VERSION）、`service.rs`（AppHandle 语义）、`bridge.rs`（EventBridge/游标/replay/resync）。
- 前端类型：`web/ts/`（从锁定 core checkout 同步，CI 漂移检查）；Web 服务端：`crates/1h-agent-web/src/server.rs`。

## 契约

- 线协议 v2：REST 端点全在 `/api/v2`（state/messages/input/commands/cancel/activate/approvals/provider/events），语义见 `build_router`；快照必含 protocol_version、event_cursor、active_session、sessions、provider/model/mode、approval、todos。
- 事件 = `Envelope`（全局单调 cursor + session_id + flattened Event，type snake_case）；消息页 = `MessagePage`（messages、next_before、has_more，游标分页）。必处理：text_delta/reasoning_delta、tool_*、approval(_resolved)、completed/failed/cancelled、todo_updated、local_command_finished、sessions_changed、child_session_progress、transcript_invalidated；未知 type 静默忽略。
- 浏览器从快照 `event_cursor` 建立 SSE；服务端桥接 replay + live，客户端按 cursor 去重。进程内消费端使用 core 的原子 `subscribe_from`；`ResyncRequired` 时丢弃本地事件缓存、重取快照与消息页。
- 前端分层：transport 唯一 fetch/EventSource/Tauri IPC、错误只走 onError；store 纯状态（`state/reducer.ts` reduce + `state/store.ts` useSyncExternalStore，PROTOCOL_VERSION 检查，未知 type 静默忽略）；actions 提供语义 action 集（`actions.ts`，只调 Transport 并回灌 store）；view 只调 actions、禁止直连 transport。消费端 Transport 接口见 `web/src/transport/transport.ts`。
- 任何消费端（含 TUI/Desktop）：命令 = AppHandle 方法（与 HTTP 同通道，禁止第二套命令语义）、事件 = `subscribe()/replay_after()/current_cursor()`（消费 Envelope/Event，禁止解析 AgentEvent）、快照 = `snapshot()/messages()`；接入点 `AppService::start(CoreConfig) -> AppHandle`。

## 不变量

- v2 是破坏性升级（移除 v1 路由与旧 DTO，`EventDto`/`AppStateDto`/`ServerCommand` 不复存在）；此后只做加法演进：新增类型/字段须旧 UI 可忽略；禁止改语义/改名/复用旧 type。
- 新增 AgentEvent 变体一次接通：forward -> session.rs handle_event -> routed_to_event -> EventBridge -> 前端处理，漏一处静默丢事件。
- 只有 transport 触网络、view 触 DOM；任何消费端不得另起事件/命令通路。
- Approval oneshot sender 不可序列化：DTO 只带 approval_id；超时按拒绝并发终态。
- ts-rs 类型与 core 同源：core 先提交 `bindings/`，本仓库定向更新依赖后运行 `bash scripts/core-bindings.sh sync`；不得手改 `web/ts/`。
- 联调可用 Cargo path patch + `PROTIUM_CORE_PATH` 同步本地 bindings；交付时必须取消两项覆盖，从锁定 Git checkout 重新 sync/check。

## 诊断

| 症状 | 检查顺序 |
| --- | --- |
| 前端无事件 / 断线丢流 | SSE 连接 -> 事件桥 -> Envelope 分支 -> 游标/回放环是否逐出（resync） |
| 协议版本不匹配 / 新事件静默丢弃 | 服务端 vs 生成类型；forward -> Envelope -> store/view |

## 验证

- `cargo test --quiet --lib --all-features --locked protocol`（穷尽 Event 变体 snake_case tag）+ `cargo test --quiet --lib --all-features --locked bridge`（游标/resync）。
- 分层：rg 查 `src/state`、`src/actions`、`src/hooks` 无 fetch/EventSource；`src/components` 无 fetch。
- 前端单测：`cd web && pnpm test`（reducer 全事件变体、未知事件兼容、Transport 契约、重连/resync、缓存淘汰）。
- core 更新：`cargo update -p protium-core` -> `core-bindings.sh sync` -> `core-bindings.sh check` -> Rust/前端测试；文档跑 `check-agent-docs.sh` 与 `git diff --check`。
- 最终检查 metadata source 与 `Cargo.lock` 均为预期 Git SHA，环境中无 `PROTIUM_CORE_PATH`，所有验证使用 `--locked`。
