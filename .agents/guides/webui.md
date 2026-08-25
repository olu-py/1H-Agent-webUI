# WebUI 服务与前端维护指南

## 适用范围

HTTP/SSE 服务面、v2 事件序列化、审批待决表、静态前端资源内嵌、命令端点与浏览器交互。

## 入口

- `crates/1h-agent-web/src/server.rs`：`run`、v2 路由表、SSE 适配、上行命令转发。
- 独立 core 仓库 `src/service.rs`：`AppService::start -> AppHandle`、`Engine` 状态机、审批待决表、命令串行化。
- `protium-core (Git dependency): src/bridge.rs`：`EventBridge` 回放环、SSE 下发、全局游标/replay/resync。
- `protium-core (Git dependency): src/protocol.rs`：v2 `Envelope`/`Event` 序列化与 `approval_id` 映射。
- `crates/1h-agent-web/src/auth.rs`：回环/非回环 token 鉴权（token 存 data_dir，不进日志）。
- `web/`：共享 React 前端（Vite + TS，`pnpm build` 产物内嵌 `web/dist/`）；`src/transport/` 唯一网络层。

## 不变量

- 单 Rust 二进制内嵌前端（rust-embed 内嵌 `web/dist/`）；运行时无 Node，构建期允许 pnpm/Vite。
- 上行全部走 REST POST，经 `AppHandle` channel 串行进入状态机；命令解析复用 `commands::parse`，不得旁路出第二套命令语义。
- 下行走 SSE：全局有界回放环 `EventBridge`（进程内单调游标、容量 clamp）；客户端从快照 `event_cursor` 订阅并按 cursor 去重，游标被逐出或滞后发 `resync_required`。
- `Approval` 事件的 oneshot sender 不可序列化：DTO 只带 `approval_id`，sender 存待决表；裁决 POST 回送 bool；待决表必须有超时拒绝兜底，超时按拒绝处理并发终态事件。
- HTTP 服务默认仅回环监听；`server.bind` 非回环必须启用 token 鉴权（token 不进日志）。任何响应不得包含 API Key 或密钥派生物。
- 请求体、URL 参数和事件缓冲全部有硬上限；SSE 连接有空闲超时与关闭清理；客户端断开不取消 agent 任务，取消只经取消端点。
- 事件用 serde tag+payload；新增 `AgentEvent` 变体必须一次接通：agent forward 闭包 -> `session.rs handle_event` -> `routed_to_event` -> `EventBridge` -> 前端处理，漏一处前端表现为静默丢事件。
- 前端复刻语义约束：首页不预建会话、首条消息才创建；后台容量由服务端 enforce，前端只展示。
- 线协议是对外契约，v2 起破坏性升级（移除 v1 路由与旧 DTO）；加法演进：新增 Event 类型/字段须容忍旧 UI 忽略，禁止改语义或复用旧 type。契约见 .agents/guides/ui-contract.md。
- Web 消费端无关：浏览器经 HTTP/SSE 消费；未来进程内 TUI/Desktop 复用同一 `AppHandle`/`EventBridge`/v2 `Event` 契约，禁止第二套命令/事件通路。契约与接入点见 .agents/guides/ui-contract.md。

## 诊断

| 症状 | 检查顺序 |
| --- | --- |
| 前端无事件 | SSE 连接 -> 事件桥消费 -> DTO 分支 -> 游标位置 |
| 断线丢流 | cursor -> 回放环长度 -> 是否被逐出（resync_required） |
| 审批悬挂 | 待决表超时 -> oneshot send 顺序 -> 终态事件 |
| 命令乱序 | 串行化入口 -> 互斥范围 -> await 点 |
| 页面空白 | 内嵌资源路径 -> 404 -> MIME -> 缓存头 |

## 验证

- 迭代过滤器：`service::tests`、`protocol`、`bridge::tests`、`approval_timeout`。
- core/绑定：定向更新后运行 `bash scripts/core-bindings.sh sync` 与 `check`；前端运行 `cd web && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build`，提交 `web/ts/` 与必要的 `web/dist/`。
- 新端点最少覆盖：成功路径、未知 session 404、超限 4xx、取消后终态可观察。
- 手工冒烟：`curl -N localhost:7788/api/v2/events?cursor=0` + 浏览器完整流程（新建/恢复会话、流式、审批、取消、多标签同会话）。
- HTTP 面或协议变更升级到完整测试和 Clippy；发布前跑 Release 专题矩阵。
