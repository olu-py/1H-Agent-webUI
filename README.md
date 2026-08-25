# 1H-Agent

`1H` 指氕（protium），即氢-1 同位素。1H-Agent 是面向 Linux、macOS 和 Windows 的轻量、权限感知浏览器 Agent：单 Rust 二进制内嵌 HTTP 服务与前端页面，流式对话、工具审批、AI 集群与本地会话持久化全部由单个进程承担，无 Node.js 构建链、无 Python、无 Chromium。

## 获取与启动

GitHub Releases 提供 Linux x86_64、Windows x86_64、macOS Intel 和 macOS Apple Silicon 的原生包，并附带 `SHA256SUMS.txt` 用于校验。前端资源已内嵌进二进制，发布归档无需额外文件。

启动后默认监听回环地址，用浏览器打开输出中的地址即可：

```bash
./1h-agent --workspace /path/to/project
# 1H-Agent WebUI listening on http://127.0.0.1:7788/
```

macOS 二进制未签名。若系统阻止首次运行，确认文件来源后可移除下载隔离属性：

```bash
xattr -d com.apple.quarantine ./1h-agent
```

常用命令行参数：

| 参数 | 说明 |
| --- | --- |
| `--workspace <dir>` | 工作目录，文件工具的活动范围（默认当前目录） |
| `--port <n>` | WebUI 端口（覆盖 `server.port`，clamp 到 1024-65535） |
| `--host <addr>` | 绑定地址（覆盖 `server.bind`）。默认仅回环 `127.0.0.1`；绑定非回环地址时强制启用 token 鉴权 |

从源码开发运行：

```bash
cargo run -- --workspace /path/to/project
```

构建 release 二进制：

```bash
cargo build --release
./target/release/1h-agent --workspace /path/to/project
```

## 更新 protium-core

WebUI 通过 Git 依赖使用独立的 `protium-core` 仓库。core 合并到 `main` 后，在本仓库运行：

```bash
cargo update -p protium-core
bash scripts/core-bindings.sh sync
cargo test --all-features --locked
```

协议绑定由 core 仓库维护；同步后再按 WebUI 的 TypeScript 测试和适配器变更更新前端。

## 浏览器界面

首页列出可恢复的会话并允许新建；输入首条消息并回车即创建新会话，不会预先建立空会话。主界面包含消息流（流式文本、思考面板、工具卡片）、任务清单浮窗、模式/Provider/模型控件、命令输入框与审批弹层。实时事件经 SSE 推送；同一会话在多个标签页打开时共享同一条事件流，命令通过 REST 串行进入状态机。

常用操作：

| 操作 | 方式 |
| --- | --- |
| 新建 / 恢复会话 | 首页输入首条消息回车，或点击会话列表 |
| 发送 / 换行 | 输入框回车 / `Shift+Enter` |
| 切换模式 | `/plan` `/build` `/explore` `/cluster`，或点击模式标签 |
| 命令 | 输入框以 `/` 开头，如 `/help` `/todo` `/undo` `/redo` `/diff` `/export` `/clear` `/rename <标题>` `/model <模型名>` |
| 任务清单 | `/todo`、`/todo add <标题>`、`/todo doing\|done\|undo <序号>`、`/todo edit <序号> <标题>`、`/todo remove <序号>`、`/todo clear` |
| 选择供应商 / 模型 | 点击界面中的供应商或模型控件，或 `/model <模型名>` |
| 引用文件 / 执行命令 | `@path` / `!command`（命令须审批） |
| 工具 / 审批 | 工具卡片显示状态与结果；危险操作弹出审批，可批准、拒绝或本会话放行 |
| 取消 | 界面取消按钮或 `Esc`（仅取消当前会话的进行中请求） |
| 文件操作 | 限定在 `--workspace` 内；写入、删除、命令、浏览器交互和变更型 Git 操作按策略要求审批 |

## 配置 Provider

在界面中通过 Provider 控件添加或切换供应商。设置页列出已保存的连接；可从 OpenAI、DeepSeek、Qwen/Bailian、火山方舟和自定义兼容模板中创建。每种模板只能添加一次；非密钥配置保存到 TOML；API Key 只来自环境变量或系统钥匙串，不进入 TOML、数据库、日志或任何 HTTP 响应。

| Provider | API Key 环境变量 | 默认模型 |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-5-mini` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` |
| Qwen/Bailian | `DASHSCOPE_API_KEY` | `qwen3.8-max` |
| Volcano Ark | `ARK_API_KEY` | `doubao-seed-2-1-pro-260628` |
| Custom | `AGENT_API_KEY` | 自行设置 |

配置示例见 [`config/config.example.toml`](config/config.example.toml)。`AGENT_API_BASE`、`AGENT_MODEL`、`AGENT_PROVIDER` 可覆盖 Provider 字段，`AGENT_DATA_DIR` 可指定会话数据库目录。Qwen/Bailian 的 URL 必须替换其中的 `WorkspaceId`。

DeepSeek 的 Responses 模式默认启用 Provider 原生联网搜索。设置以下配置可关闭它，并回退到本地文本搜索与网页抓取：

```toml
[provider]
native_web_search = "disabled"
```

## AI 集群模式

切换到 `cluster` 模式（`/cluster` 或点击模式标签）后，可在对话里用自然语言给不同角色指派不同模型，例如「用 deepseek-v4-pro 做计划与审批，用 deepseek-v4-flash 做实施」。主 Agent 会通过 `agent_spawn` 调度子 Agent 串行/并行执行，每个子 Agent 生成一个**树形子会话**（默认折叠，点击展开），父会话与当前会话在会话列表高亮显示，子会话以批次面板展示运行中/等待审批等状态。子 Agent 返回 JSON 结果（`session_id`、`status`、`output`），写文件操作仍需用户审批；子 Agent 无终端权限，验证由主 Agent 完成。`agent_spawn` 还可通过 `provider` 指定其他 Provider、通过 `agent` 引用 `[[agents]]` 配置模板。

## AI 维护文档

维护或开发本项目的 AI Agent 请先读取 [AGENTS.md](AGENTS.md)，再按任务路由只加载相关专题指南。该入口提供架构、源码路由、安全边界和分级验证规则。

## 第三方声明

本项目使用或改写的第三方内容及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
