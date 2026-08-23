# 多界面低耦合架构改造方案

## Summary

将仓库改为 Cargo workspace，由无 UI 依赖的 Rust 核心驱动三个独立程序：

```text
protium-core
  ├─ 1h-agent-web      Axum + React DOM + HTTP/SSE
  ├─ 1h-agent-tui      ratatui + 进程内 AppHandle
  └─ 1h-agent-desktop  Tauri + React DOM + 进程内 IPC
```

外部模型、工具、存储、权限、命令解析和会话状态全部留在 Rust。Web 与 Desktop 共享完整 React UI；TUI 只共享 Rust 核心、DTO 和交互语义，终端组件独立实现，以保证启动速度和内存表现。

三个程序均支持 Windows、macOS、Linux，命令名明确改为 `1h-agent-web`、`1h-agent-tui`、`1h-agent-desktop`。

## Core And Protocol

- 提取 `protium-core`，不得依赖 Axum、Tauri、ratatui、React 或平台 WebView；现有 `App`、Provider、Storage、SessionRuntime、Tools 和安全逻辑迁入该 crate。
- 新增 `AppService::start(CoreConfig) -> AppHandle`。`AppHandle` 提供 `snapshot`、`messages`、`submit`、`execute_command`、`approve`、`cancel`、`activate_session`、`set_provider`、`subscribe`、`shutdown`，不向消费端暴露 oneshot 或内部 `ServerCommand`。
- 内部命令队列保持有界容量 64；退出时拒绝未决审批、取消 agent 树、关闭订阅并释放数据库和 workspace 锁。
- 每个 canonical workspace 使用独占文件锁。第二个程序打开相同 workspace 时立即失败；Desktop 显示占用提示，Web/TUI 输出错误并退出。
- UI 协议直接升级为 v2，不保留 v1 路由。Web API 统一放在 `/api/v2`，旧缓存通过无缓存 `index.html`、带 hash 的静态资源和协议版本检查失效。
- 定义稳定的 `AppSnapshotV2`、`MessageDto`、`MessagePage`、`UiEventEnvelope`、`ApiError`；不再向 UI 暴露 `provider::ConversationItem` 或 Provider 私有 JSON。
- `UiEventEnvelope` 使用进程级单调递增 `cursor`，包含 `session_id` 和事件 payload。快照同时返回 `event_cursor`，客户端从该位置订阅，消除快照与订阅之间的丢事件窗口。
- EventBridge 改为全局有界重放环，内部存储 `Arc<UiEventEnvelope>`，避免广播和重放复制大型字符串。默认保留 512 事件且总计不超过 4 MiB；两项限制均可配置并 clamp。
- cursor 已被逐出时返回 `resync_required`，消费端重新获取 snapshot 和当前消息页，不猜测缺失状态。
- 消息接口改为游标分页：默认 100 条，允许 20–200 条；响应返回 opaque `next_before` 和 `has_more`。SQLite 增加适合 `session_id + hidden + id` 的索引，查询沿当前 head 父链过滤后倒序 limit，再恢复展示顺序。
- undo、redo、compact 等修改历史的命令产生 `transcript_invalidated` 事件，替代前端固定延时刷新。
- 使用 `ts-rs` 从 Rust DTO 生成 TypeScript discriminated unions；CI 重新生成到临时目录并比较，防止 Rust/TS 契约漂移。

## Frontends

- 使用锁定版本的 pnpm、TypeScript、Vite 和 React；Node 只存在于开发与 CI，三个发布程序运行时均不依赖 Node。
- 建立共享 `Transport` 接口，方法与 `AppHandle` 一一对应。实现 `HttpSseTransport` 和 `TauriIpcTransport`；actions、store、hooks 不导入 fetch、EventSource 或 Tauri API。
- 使用自定义 reducer、`useSyncExternalStore` 和 React hooks，不引入 Redux/Zustand。流式文本、工具调用、审批、todo、子会话和 transcript invalidation 全部归约到纯状态，React component 不解释协议。
- 客户端只缓存当前会话最多 5 页、共 500 条消息；切换会话释放旧 transcript。长列表使用虚拟化，历史滚动按需加载，后台会话只保留摘要状态。
- Web 继续由 Axum 服务并通过 `rust-embed` 内嵌构建产物；移除 permissive CORS，默认严格同源，非回环访问继续要求 token。
- Desktop 使用 Tauri 同进程启动 `AppService`，通过 IPC adapter 调用；不启动 localhost 服务。JS 先注册事件监听，再请求 `subscribe(cursor)`，窗口关闭时注销订阅并 shutdown。
- TUI 使用 ratatui/crossterm 和 `AppHandle`，只渲染可见 viewport，复用分页与 500 条缓存上限；覆盖会话、流式输出、工具、审批、取消、todo、命令补全和子会话状态。
- 配置文件继续共享，但 core 只接收 `CoreConfig`；Web 专属 bind/port/auth 配置留在 Web adapter，Desktop/TUI 不依赖 server 配置。

## Delivery And Validation

- 按“核心抽取 → v2 协议和分页 → React Web → TUI → Desktop → 发布矩阵”实施；每阶段保持 Rust 测试通过，最终版本一次性切换 v2。
- 首阶段记录当前 release 的启动时间、空闲 RSS、命令分发、事件广播和消息加载基线。核心路径 p95 延迟、Web/TUI Rust RSS 不得退化超过 10%；Desktop 单独记录包含系统 WebView 的总 RSS，后续版本以首版为基线执行相同 10% 回归门槛。
- 增加 10,000 条消息长会话测试，验证首屏只返回一页、分页顺序正确、undo/redo 父链正确、客户端缓存不超过 500 条。
- Rust 测试覆盖命令串行化、审批超时、取消终态、workspace 独占锁、全局 cursor、慢消费者、环形缓冲逐出、resync 和完整 shutdown。
- TypeScript 测试覆盖 reducer 的全部事件变体、未知事件兼容、Transport 契约、重连/resync、transcript invalidation 和缓存淘汰。
- React Web 使用 Playwright 覆盖首消息建会话、流式响应、工具审批、取消、切换会话、历史分页和子会话进度；Desktop 对相同用例运行 IPC smoke；TUI 使用 ratatui TestBackend 做交互和 snapshot 测试。
- CI 先执行 `pnpm install --frozen-lockfile`、类型检查、单测和 Web build，再执行三平台 Rust fmt、Clippy、全测试和 release build。
- Release 分别产出 Web/TUI 的原生归档与安装包，以及 Desktop 的 Windows MSI、macOS DMG、Linux AppImage/DEB，统一生成 checksums 和第三方声明。
- 更新根维护协议：允许构建期 Node/pnpm，但继续禁止运行时 Node、Electron、捆绑 Chromium和动态插件；新增多 UI 架构文档并同步 UI Contract、Runtime、WebUI、Release 指南。

## Assumptions

- Web 仍支持受鉴权的远程访问；TUI 与 Desktop 仅操作本机 workspace。
- Desktop 使用系统 WebView，不采用 Electron。
- 三个程序不能同时拥有同一个 workspace；本次不引入常驻 daemon 或跨进程附着协议。
- v1 API 和旧原生 JS UI在同一版本直接移除，作为明确的破坏性升级记录。
- 现有用户未提交改动在实施时保留并合并，不覆盖当前文档和 CI 修改。
