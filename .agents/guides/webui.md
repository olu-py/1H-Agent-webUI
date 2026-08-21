# WebUI 服务与前端维护指南

## 适用范围

HTTP/SSE 服务面、事件 DTO 序列化、审批待决表、静态前端资源内嵌、命令端点与浏览器交互。

## 入口

- `src/server/mod.rs`：`run`、路由表、`AppState`（Machine 状态机）、上行命令串行化。
- `src/server/events.rs`：`EventBridge`、SSE 下发、seq/续传缓冲。
- `src/server/dto.rs`：`AgentEvent` -> Web DTO 的转换与 `approval_id` 映射。
- `src/server/auth.rs`：回环/非回环 token 鉴权（token 存 data_dir，不进日志）。
- `web/`：内嵌前端资源（原生 ES 模块，无构建链）。

## 不变量

- 单 Rust 二进制内嵌前端（rust-embed 类机制）；禁止 Node 构建链、npm 依赖和运行时下载。
- 上行全部走 REST POST，经互斥/channel 串行进入状态机；命令解析复用 `commands::parse`，不得旁路出第二套命令语义。
- 下行走 SSE：事件桥维护每会话单调递增 seq 与有限环形缓冲（上限 clamp）；`Last-Event-ID` 续传，服务端不重放已消费事件。
- `Approval` 事件的 oneshot sender 不可序列化：DTO 只带 `approval_id`，sender 存待决表；裁决 POST 回送 bool；待决表必须有超时拒绝兜底，超时按拒绝处理并发终态事件。
- HTTP 服务默认仅回环监听；`server.bind` 非回环必须启用 token 鉴权（token 不进日志）。任何响应不得包含 API Key 或密钥派生物。
- 请求体、URL 参数和事件缓冲全部有硬上限；SSE 连接有空闲超时与关闭清理；客户端断开不取消 agent 任务，取消只经取消端点。
- 事件 DTO 用 serde tag+payload；新增 `AgentEvent` 变体必须一次接通：agent forward 闭包 -> `session.rs handle_event` -> `EventBridge` DTO 分支 -> 前端处理，漏一处前端表现为静默丢事件。
- 前端复刻语义约束：首页不预建会话、首条消息才创建；后台容量由服务端 enforce，前端只展示。

## 诊断

| 症状 | 检查顺序 |
| --- | --- |
| 前端无事件 | SSE 连接 -> 事件桥消费 -> DTO 分支 -> seq 游标 |
| 断线丢流 | Last-Event-ID -> 环形缓冲长度 -> 事件是否被逐出 |
| 审批悬挂 | 待决表超时 -> oneshot send 顺序 -> 终态事件 |
| 命令乱序 | 串行化入口 -> 互斥范围 -> await 点 |
| 页面空白 | 内嵌资源路径 -> 404 -> MIME -> 缓存头 |

## 验证

- 迭代过滤器：`server::tests`、`dto`、`event_bridge`、`approval_timeout`。
- 新端点最少覆盖：成功路径、未知 session 404、超限 4xx、取消后终态可观察。
- 手工冒烟：`curl -N localhost:7788/api/events` + 浏览器完整流程（新建/恢复会话、流式、审批、取消、多标签同会话）。
- HTTP 面或 DTO 变更升级到完整测试和 Clippy；发布前跑 Release 专题矩阵。
