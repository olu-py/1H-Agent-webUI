# 1H-Agent AI 维护协议

> 先读本文件，再按任务路由只读一个相关专题及目标源码；跨领域任务才组合读取，禁止为背景扫描整个仓库。

## 稳定上下文

```text
project: 1H-Agent（1H = 氕/protium）
goal: 极致轻量、高性能、权限感知的浏览器 WebUI Agent
runtime: 单个 Rust/Tokio 进程，内嵌 HTTP 服务 + 前端静态资源；SQLite/WAL
authority: 源码 > config/config.example.toml > .github/workflows > 本文件 > 专题指南
scope: WebUI（REST/SSE + React 静态前端）、模型流、受控工具、多会话、AI 集群、跨平台发布
excluded: 运行时 Node/Electron/捆绑 Chromium、动态插件、图片和语音能力
migration: 多界面低耦合改造（Cargo workspace + protium-core + v2 协议）见 PLAN.md；WebUI 迁移细节见 design/webui-migration.md
```

- 三个发布程序运行时均不依赖 Node；构建期允许 pnpm/TypeScript/Vite（`web/`，锁定版本，产物内嵌）。不引入运行时 Node、Electron、捆绑 Chromium、动态插件 ABI 或后台轮询（SSE 是服务端推送，浏览器 EventSource 重连不算轮询）。所有路径、网络、工具、进程、缓存、channel 和输出必须有边界、取消与释放路径。
- `web/` 是共享 React 前端（Web 经 HTTP/SSE、Desktop 经 Tauri IPC 消费），`src/transport/` 是唯一网络/IPC 接入层，actions/store/hooks 不得导入 fetch、EventSource 或 Tauri API；`web/ts/` 从锁定的 core checkout 同步（勿手改，CI 漂移检查）。

## 一分钟工作流

1. 先运行 `git status --short --branch`，识别并保护用户已有改动。
2. 用 `rg` 定位定义、直接调用者、事件变体和相邻测试；只读任务命中的专题。
3. 从 `crates/1h-agent-web/src/main.rs -> server::run` 进入；UI 无关接口在独立 `1H-Agent-core` 仓库的 `src/service.rs`、`protocol.rs`、`bridge.rs`。
4. 修改事件、配置或持久化类型时，覆盖所有构造点、match、序列化、恢复和测试。
5. 先跑最小目标测试；跨模块行为才升级到完整 Clippy 和测试。
6. core 变更先在独立仓库完成并 push；本仓库只定向更新 Git 依赖、同步 bindings、适配并提交锁文件，禁止编辑 Cargo checkout。

## 任务路由

| 领域 | 首读入口 | 专题/读取条件 |
| --- | --- | --- |
| 启动、服务、全局状态、会话路由 | `protium-core (Git dependency): src/service.rs`、`protium-core (Git dependency): src/app.rs`、`protium-core (Git dependency): src/session.rs` | [Runtime](.agents/guides/runtime.md)；仅沿目标事件链读取 |
| HTTP/SSE 面、v2 端点、前端资源、命令端点 | `crates/1h-agent-web/src/server.rs`、`web/`（React 前端，`pnpm build` 产物内嵌 `web/dist/`） | [WebUI](.agents/guides/webui.md) |
| UI 通用接口、线协议契约（v2）、事件桥、任何消费端接入 | `protium-core (Git dependency): src/protocol.rs`、`protium-core (Git dependency): src/bridge.rs`、`web/ts/`（生成类型） | [UI Contract](.agents/guides/ui-contract.md)；仅改线协议/事件桥/接新消费端时读 |
| Provider、模型、密钥、协议、压缩恢复 | `protium-core (Git dependency): src/config.rs`、`protium-core (Git dependency): src/agent.rs`、`protium-core (Git dependency): src/provider/openai.rs` | [Provider](.agents/guides/provider.md) |
| 子 Agent、审批、取消、集群停滞 | `protium-core (Git dependency): src/agent.rs`、`crates/1h-agent-web/src/server.rs` | [Cluster](.agents/guides/cluster.md) |
| 工具、路径、SSRF、外部进程 | `protium-core (Git dependency): src/tools/`、`protium-core (Git dependency): src/security.rs` | [Tools](.agents/guides/tools.md) |
| 会话、分支、迁移、持久化 | `protium-core (Git dependency): src/storage.rs`、`protium-core (Git dependency): src/session.rs` | [Storage](.agents/guides/storage.md)；涉及 Provider 状态时再读 Provider |
| 配置上限、容量归一化、新增配置键 | `protium-core (Git dependency): src/config.rs` 的 `Config::load` clamp 区、`config/config.example.toml` | 无；同步默认值与 `defaults_are_bounded` 类测试 |
| CI、版本、安装包、tag | `.github/workflows/`、`Cargo.toml` | [Release](.agents/guides/release.md) |

指南与源码不一致时以源码为准，并在同一改动中更新该指南；一个事实只归属根文档或一个专题。

## 架构与全局不变量

```text
browser --REST/SSE--> AppHandle --command--> App/SessionRuntime --> AgentRunner -> OpenAiClient / ToolRegistry
                          |                        |                     |
                          +--EventBridge(ring)-----+                     +-> RoutedEvent(session_id) -> EventBridge
```

- UI 无关核心在 `protium-core`（`service.rs` 的 `AppService::start -> AppHandle`）；消费端（Web/TUI/Desktop）只通过 `AppHandle` 的方法（snapshot/messages/submit/execute_command/approve/cancel/activate_session/set_provider/subscribe/shutdown）串行进入状态机，`App` 管全局状态、当前/后台 runtime 和路由；`SessionRuntime` 独占单会话状态，切换不停止后台任务；后台容量与删除关停契约见 Runtime 专题。
- 三段事件链语义不变：agent task --`agent_tx`--> 转发 task --`router_tx`--> 消费端；事件按 `session_id` 路由，未知 id 静默丢弃。
- 事件投递经全局有界回放环 `EventBridge`（进程内单调游标、容量 clamp）；游标被逐出或消费者滞后时发 `resync_required`，消费端重取快照与消息页。消息页按游标分页（`next_before` + `has_more`），历史变更发 `transcript_invalidated`。
- Provider 私有协议先规范化为 `ModelEvent`；服务端、存储和工具层不解析私有 JSON。
- 恢复沿 `head_turn_id` 父链；fork 不复制 Provider 服务端状态；undo/redo 移动 head 并按 `file_snapshots` 回滚/前滚文件（无快照的路径跳过）。
- workspace 必须 canonicalize；每个 workspace 进程内互斥锁（第二个实例立即失败）；拒绝绝对路径、`..`、符号链接逃逸；新目标验证 canonical parent。
- Web 工具每次重定向都校验 HTTP/HTTPS 和公网地址；HTTP 服务默认仅回环监听，非回环必须启用 token 鉴权；危险操作始终经过 mode、安全分类与审批；审批可"本会话放行"（进程内不落盘，config deny 仍压过它）。
- API Key 只来自环境变量或系统钥匙串，不进入 TOML、SQLite、日志、导出、模型上下文或任何 HTTP 响应。
- 外部进程必须支持超时、输出截断、取消和进程树清理；取消端点产生可观察终态。
- 新增容量或并发前定义硬上限、截断、取消与释放；未知模型使用显式窗口或 Provider 感知注册表。

## 实施与验证

| 改动 | 最小验证 |
| --- | --- |
| 文档 | `bash scripts/check-agent-docs.sh`、`git diff --check` |
| 迭代中 | `cargo test --quiet --lib --all-features --locked <filter>`；每次只选一个相关过滤器 |
| 局部 Rust 完成 | `cargo fmt --all -- --check`、`cargo test --quiet --lib --all-features --locked` |
| 工具/存储/安全/进程/HTTP 面或跨模块 | `cargo clippy --all-targets --all-features --locked -- -D warnings`、`cargo test --quiet --all-features --locked` |
| 发布 | 读取 Release 专题并运行其完整验证 |

保持改动聚焦，复用现有 helper，不清理无法证明无用的文件。未运行的检查必须在最终回复说明；不要因 Cargo 锁或冷缓存终止正常构建。
