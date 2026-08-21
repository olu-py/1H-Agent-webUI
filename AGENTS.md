# 1H-Agent AI 维护协议

> 先读本文件，再按任务路由只读一个相关专题及目标源码；跨领域任务才组合读取，禁止为背景扫描整个仓库。

## 稳定上下文

```text
project: 1H-Agent（1H = 氕/protium）
goal: 极致轻量、高性能、权限感知的浏览器 WebUI Agent
runtime: 单个 Rust/Tokio 进程，内嵌 HTTP 服务 + 前端静态资源；SQLite/WAL
authority: 源码 > config/config.example.toml > .github/workflows > 本文件 > 专题指南
scope: WebUI（REST/SSE + 静态前端）、模型流、受控工具、多会话、AI 集群、跨平台发布
excluded: Node 构建链、npm 依赖、远程 MCP、动态插件、图片和语音能力
migration: TUI -> WebUI 改造进行中，权威计划见 design/webui-migration.md；阶段 5 前禁止混合重构
```

保持单 Rust 二进制，前端资源内嵌；不引入 Node.js、Python、Chromium、动态插件 ABI 或后台轮询（SSE 是服务端推送，浏览器 EventSource 重连不算轮询）。所有路径、网络、工具、进程、缓存、channel 和输出必须有边界、取消与释放路径。

## 一分钟工作流

1. 先运行 `git status --short --branch`，识别并保护用户已有改动。
2. 用 `rg` 定位定义、直接调用者、事件变体和相邻测试；只读任务命中的专题。
3. 从 `src/main.rs -> server::run` 进入：全局状态在 `AppState`，单会话在 `SessionRuntime`，模型/工具循环在 `AgentRunner`。
4. 修改事件、配置或持久化类型时，覆盖所有构造点、match、序列化、恢复和测试。
5. 先跑最小目标测试；跨模块行为才升级到完整 Clippy 和测试。

## 任务路由

| 领域 | 首读入口 | 专题/读取条件 |
| --- | --- | --- |
| 启动、全局状态、会话路由 | `src/main.rs`、`src/server/mod.rs`、`src/session.rs` | [Runtime](.agents/guides/runtime.md)；仅沿目标事件链读取 |
| HTTP/SSE 面、事件 DTO、前端资源、命令端点 | `src/server/` | [WebUI](.agents/guides/webui.md) |
| Provider、模型、密钥、协议、压缩恢复 | `src/config.rs`、`src/agent.rs`、`src/provider/openai.rs` | [Provider](.agents/guides/provider.md) |
| 子 Agent、审批、取消、集群停滞 | `src/agent.rs`、`src/server/mod.rs` | [Cluster](.agents/guides/cluster.md) |
| 工具、路径、SSRF、外部进程 | `src/tools/`、`src/security.rs` | [Tools](.agents/guides/tools.md) |
| 会话、分支、迁移、持久化 | `src/storage.rs`、`src/session.rs` | [Storage](.agents/guides/storage.md)；涉及 Provider 状态时再读 Provider |
| 配置上限、容量归一化、新增配置键 | `src/config.rs` 的 `Config::load` clamp 区、`config/config.example.toml` | 无；同步默认值与 `defaults_are_bounded` 类测试 |
| CI、版本、安装包、tag | `.github/workflows/`、`Cargo.toml` | [Release](.agents/guides/release.md) |

指南与源码不一致时以源码为准，并在同一改动中更新该指南；一个事实只归属根文档或一个专题。

## 架构与全局不变量

```text
browser --REST--> AppState --+-> SessionRuntime --> AgentRunner -> OpenAiClient / ToolRegistry
   ^                          |          |               |
   +----------SSE------------+          +-> Storage     +-> RoutedEvent(session_id) -> EventBridge
```

- `AppState` 管全局状态、当前/后台 runtime 和路由；`SessionRuntime` 独占单会话状态，切换不停止后台任务；后台容量与删除关停契约见 Runtime 专题。
- 三段事件链语义不变：agent task --`agent_tx`--> 转发 task --`router_tx`--> 消费端；事件按 `session_id` 路由，未知 id 静默丢弃。上行命令必须串行进入状态机。
- Provider 私有协议先规范化为 `ModelEvent`；服务端、存储和工具层不解析私有 JSON。
- 恢复沿 `head_turn_id` 父链；fork 不复制 Provider 服务端状态；undo/redo 移动 head 并按 `file_snapshots` 回滚/前滚文件（无快照的路径跳过）。
- workspace 必须 canonicalize；拒绝绝对路径、`..`、符号链接逃逸；新目标验证 canonical parent。
- Web 工具每次重定向都校验 HTTP/HTTPS 和公网地址；HTTP 服务默认仅回环监听，非回环必须启用 token 鉴权；危险操作始终经过 mode、安全分类与审批；审批可"本会话放行"（进程内不落盘，config deny 仍压过它）。
- API Key 只来自环境变量或系统钥匙串，不进入 TOML、SQLite、日志、导出、模型上下文或任何 HTTP 响应。
- 外部进程必须支持超时、输出截断、取消和进程树清理；取消端点产生可观察终态。
- 新增容量或并发前定义硬上限、截断、取消与释放；未知模型使用显式窗口或 Provider 感知注册表。

## 实施与验证

| 改动 | 最小验证 |
| --- | --- |
| 文档 | `bash scripts/check-agent-docs.sh`、`git diff --check` |
| 迭代中 | `cargo test --lib --all-features --locked <filter>`；每次只选一个相关过滤器 |
| 局部 Rust 完成 | `cargo fmt --all -- --check`、`cargo test --lib --all-features --locked` |
| 工具/存储/安全/进程/HTTP 面或跨模块 | `cargo clippy --all-targets --all-features --locked -- -D warnings`、`cargo test --all-features --locked` |
| 发布 | 读取 Release 专题并运行其完整验证 |

保持改动聚焦，复用现有 helper，不清理无法证明无用的文件。未运行的检查必须在最终回复说明；不要因 Cargo 锁或冷缓存终止正常构建。
