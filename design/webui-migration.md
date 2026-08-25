# 已归档：1H-Agent WebUI 改造计划

> 来源：2026-08-21 改版决策。迁移已经完成，本文仅保留实施记录，不再是当前维护依据。
> 当前架构、入口和验证以 `AGENTS.md`、`.agents/guides/webui.md` 与
> `.agents/guides/ui-contract.md` 为准。

---

## 历史基线（依据 2026-08-21 源码）

- UI 无关层（直接复用，不动协议）：`agent.rs`（AgentRunner/AgentEvent）、
  `session.rs`（SessionRuntime）、`storage.rs`、`provider/`、`tools/`、
  `security.rs`、`config.rs`、`secrets.rs`、`commands.rs`（命令面）、
  `model.rs`（展示模型）。
- 终端耦合层（替换对象）：`app.rs`（6095 行，事件循环+命令执行+鼠标/键盘
  处理混合）、`ui.rs`（3536 行）、`home.rs`、`output.rs`、`input.rs`、
  `ui_layout.rs`、`ui_theme.rs`、`ui_view_model.rs`、`clipboard.rs`。
- 事件链本身 UI 无关：agent task --`agent_tx`--> 转发 task --`router_tx`-->
  `App.router_rx`，按 `session_id` 路由。审批经 oneshot 回传 agent。
- 存储为 SQLite/WAL，会话树、快照、软删协议不变。
- 密钥仅在环境变量或系统钥匙串；不进 TOML/SQLite/日志/导出/模型上下文。

## 关键决策

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 进程形态 | 单 Rust 二进制内嵌 HTTP 服务器 + 前端静态资源 | 保留"单二进制"章程；无 Node.js/Chromium |
| 前端技术 | React + TypeScript + Vite，pnpm 仅用于开发/构建 | 提交并内嵌 `web/dist/`；终端用户运行时无需 Node |
| 实时通道 | SSE（`text/event-stream`）下发事件流 | 单向流为主，比 WebSocket 简单；浏览器自动重连 |
| 命令上行 | REST POST（JSON） | 提交输入/命令/审批/取消一次一请求，语义清晰 |
| 会话模型 | 复用 SessionRuntime + router 聚合器 | 现有三段事件链原样保留，仅换 App 层消费端 |
| 审批 | oneshot 通道语义不变；WebUI 弹层选择后 POST /approvals/:id | 弱网下 oneshot sender 侧增加超时拒绝兜底 |
| 寄宿策略 | axum + tower-http 静态资源；actix 为备选 | 生态最成熟、tokio 原生；Clippy/发布链兼容 |
| TUI 代码 | 分阶段:先共存后删除。WebUI 可用后按模块删除 TUI 专有文件 | 降低单次改动风险；tests 依赖部分 UI 无关逻辑 |

## 阶段计划

### 阶段 0：文档奠基（本次改动，仅文档）

- [x] 本计划文档。
- [x] AGENTS.md 章程翻转为 WebUI 形态（保留单二进制、密钥边界、工具安全等
      不变量，移除"Web UI excluded"），任务路由表新增 webui 专题。
- [x] `.agents/guides/tui.md` 删除，新增 `.agents/guides/webui.md`
      （承载 SSE/REST 契约、事件 DTO 序列化、前端资源内嵌与缓存不变量）。
- [x] runtime.md 改写为"Server 生命周期"：事件链语义不变，App 消费端由
      终端事件循环改为 HTTP/SSE 消费端。
- [x] provider/cluster/tools/storage 指南中对 TUI 的引用改为 UI 无关表述
      或指向 webui.md；check-agent-docs.sh 指南清单同步。

### 阶段 1：服务端骨架（后端先行）

- [x] `Cargo.toml` 增加 axum（+ tower-http services，仅 static + 简单 CORS）
      依赖；无 Node 工具链。
- [x] 新建 `src/server/mod.rs`：`run(workspace, config)` 从 `main.rs` 接管
      启动流程；`Config::load` 增加 `[server]` 段（bind 地址、端口 clamp、
      默认仅回环地址 127.0.0.1）。
- [x] 事件桥：`EventBridge`（router_rx 消费者）维护 `broadcast` 通道 + 每
      session append 日志；SSE 认领并转发 `AgentEvent` 序列化 DTO。
- [x] REST 面（先读后写）：
  - `GET /api/state`：当前会话列表/当前会话 ID/phase/mode/provider/model。
  - `GET /api/sessions/:id/messages`：从 `load_messages` 沿 head 链导出
    列表（含 tool_call 决策审计字段）。
  - `GET /api/events`（SSE）：全局事件流（server-sent events，带 session id
    根据需折叠为 per-session 流或全局流）。
  - `GET /`：内嵌静态前端（rust-embed/include_dir 或 include_str!）。
- [x] 事件 DTO：`AgentEvent` 的 Web 序列化形状（serde tag + payload），
      `oneshot::Sender<bool>` 字段无法序列化，在桥内转成 `approval_id`，
      sender 存服务端待决表；裁决 POST 回来后 oneshot send。
- [x] `--workspace` CLI 保留；新增 `--port`（默认 7788），
      并预留 `--host` 回环限制说明。
- [x] 验证：`cargo test --lib`（新增 server 模块测试：state 快照、事件桥
      顺序性、审批 id 映射）。

### 阶段 2：核心交互链路（打通最小可用）

- [x] 上行端点：
  - `POST /api/sessions/:id/input`：提交用户输入（等价 submit_input，含
    `/` 斜杠命令解析复用 `commands::parse`）。
  - `POST /api/sessions/:id/commands`：结构化命令（New/Rename/Delete/Fork/
    Undo/Redo/Compact/Export/Diff/Mode/Todo/Clear）。
  - `POST /api/approvals/:approval_id` { accept: bool }。
  - `POST /api/sessions/:id/cancel`：等价 Esc 取消当前请求。
  - `POST /api/config/provider` 等 Provider 设置端点（复用 settings 逻辑，
      密钥仍走钥匙串；服务端只保存 preset 名与非密钥字段，不存任何密钥指纹）。
- [x] 事件桥将 `Approval` 事件转 DTO（含 call/reason/source）+ approval_id；
      待决表加超时拒绝（默认 5 分钟），超时按拒绝处理（发 false）。
- [x] 上行 approve/deny 到达后 oneshot send(true/false)。
- [x] 取消：cancel 端点触发 `shutdown`/abort 语义与 TUI Esc 相同
      （仅当前会话）。会话切换由前端状态栏实现，切换即 `GET /api/state` 刷新。
- [x] 验证：`cargo test --lib`（含 server 模块 21 测试）；curl + SSE 冒烟已过
      （审批流/取消/命令/Last-Event-ID 续传/token 鉴权/会话激活）。浏览器
      冒烟（mock provider 全链路）：流式渲染、审批弹层通过/拒绝、取消
      （服务端 cancel → 前端 Cancelled 同步）、多标签同会话广播、
      /diff、/export、/undo、/redo、集群子 agent 进度批次面板均已过。
      修复：`cancel_session` 未广播 Cancelled DTO（前端状态滞留"等待模型
      响应"）→ 补推送；`sessions_changed` 触发 refreshState 重载消息流导致
      集群面板/实时流式被清空 → refreshState 仅在会话切换时重载消息。

### 阶段 3：前端实现（历史记录；现已迁移为 React/Vite）

- [x] `web/` 最终采用 React + TypeScript + Vite；构建期使用 pnpm，提交的
      `web/dist/` 经 rust-embed 内嵌进二进制，运行时不依赖 Node。
- [x] 首页（会话列表 + 新建/恢复 + Provider/模型选择）复刻 home 语义：
      不预建空会话，首条消息提交才创建会话。
- [x] 主界面：消息流（Markdown 渲染可用极小 vendored 渲染器或转纯文本 +
      `<pre>`）、流式文本、思考面板、工具卡片、审批弹层、todo 浮窗、
      mode/provider/model 控件、输入框 + `/` 命令补全（复用 fuzzy_score）。
- [x] 会话切换/后台容量:前端侧展示列表,后台 runtime 容量仍由服务端 enforce。
- [x] 验证: `cargo test --lib` + `cargo build` + `cargo clippy -D warnings` +
      完整矩阵（300 lib + 3 集成）。浏览器冒烟已覆盖：首页渲染、首消息
      建会话、流式文本（reasoning+text）、审批弹层→批准→工具执行→结果、
      取消（含 Escape 前端绑定）、多标签同会话 SSE 广播、/diff、/export、
      /undo、/redo、todo 浮窗、命令补全、会话面板、集群子 agent 批次面板
      （spawn 审批 → 面板渲染子会话进度 → 完成移除）。

### 阶段 4：集群/审批/取消全链路 + 删除 TUI

- [x] 子 agent 进度、批次面板、全局最早审批路由到父会话/全局弹层。
- [x] undo/redo 文件回滚、export、diff 展示。

### 阶段 5：收尾清理
- [x] 删除 `src/home.rs`、`src/ui.rs`、`src/output.rs`、`src/ui_layout.rs`、
      `src/ui_theme.rs`、`src/ui_view_model.rs`、`src/clipboard.rs`。
      `src/input.rs` 保留：其 `InputBuffer` 是 UI 无关的输入缓冲区，WebUI
      服务器（`app.input`）与 `submit_input` 仍在使用；TUI 渲染视图
      （`InputViewport`/`input_viewport`/`input_cursor_viewport`）已删除。
      `src/output.rs` 整体删除：`MessageLayout`/`OutputSelection`/`EdgeScroll`/
      `CachedMarkdown` 及 `SessionRuntime` 上的布局/滚动/展开字段均为 TUI
      残留，服务端与前端不读取；随依赖一起移除。
- [x] README 更新为 WebUI 使用说明（浏览器访问、REST/SSE 契约、命令表、
      非回环 token 鉴权、Provider 配置、集群模式）；发布归档无需额外前端
      文件（rust-embed 内嵌）。
- [x] README 与本项目指针：项目改名与仓库名（1H-Agent-webUI）已定，文档
      中旧名引用统一。
- [x] 完整验证矩阵：fmt、clippy -D warnings、全测试、release build、
      `bash scripts/check-agent-docs.sh`。全部通过：186 lib + 3 集成测试、
      clippy -D warnings 无告警、release 二进制内嵌前端冒烟通过。

## 风险与对策

- **风险 1：审批 oneshot 弱网超时**。对策：服务端待决表对每项审批记录
  deadline，超时自动 send(false) 并向流中发终态事件，agent 不悬挂。
- **风险 2：SSE 断线重连丢事件**。对策：事件桥维护每会话单调递增 seq，
  `Last-Event-ID` 续传；桥内环形缓冲有限长度（上限可配 clamp）。
- **重试语义**：浏览器 EventSource 自动重连 + seq 续传对齐 provider 重试
  不变量"流中断不重试"（服务端不重放已消费事件）。
- **风险 3：远程访问 SSRF 面**。server 默认仅回环监听；`--host` 或 config
  `server.bind` 非回环时要求 token（config 随机生成存 data_dir，首次打印
  一次）。
- **风险 4：单二进制与前端内嵌**。rust-embed 会把资源打进 rlib；发布归档
  不再需要额外前端文件，但需验证 Windows 路径分隔符与 include 宏的交互。
  频繁改动时可用 `debug-embed` 特性切换。
- **风险 5：app.rs 业务函数迁移遗漏**。对策：迁移前先落 server 层单测覆盖
  `execute_command` 全分支（既有 app 层测试大量可复用），再按命令分支迁移。
- **风险 6：多标签页**。一个浏览器多标签打开同会话：SSE 广播通道天然支
  持多消费者；上行命令需经同一 `App` 状态机串行化（POST 经互斥锁或 channel
  串行化进入 App 状态机）。
- **风险 7：密钥安全**。任何 API 端点不返回密钥；settings 端点只写 preset
  名/非密钥字段；钥匙串解锁仍是"当前 Provider 一次"。

## 验证矩阵（阶段完成定义）

| 阶段 | 必过 |
| --- | --- |
| 0 | `bash scripts/check-agent-docs.sh`、`git diff --check` |
| 1 | lib 测试（server 模块）+ `curl` 冒烟 |
| 2 | lib 测试 + curl 审批/取消/命令端点冒烟 |
| 2.5 | 浏览器手工冒烟清单（见 webui.md） |
| 3 | 同 2.5 + 删除 TUI 前后全测试 |
| 4 | 完整矩阵：fmt + clippy -D warnings + 全测试 + release build + docs check |
| 5 | 完整矩阵（TUI 依赖移除后）全过；浏览器冒烟：首页/新建会话、流式、
      审批批准→工具执行、取消（Cancelled DTO 广播与前端同步）、/undo、
      /redo、release 二进制内嵌前端可访问 |
