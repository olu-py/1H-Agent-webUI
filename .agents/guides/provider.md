# Provider 维护指南

## 适用范围

Provider 档案、设置、密钥、请求协议、reasoning、`response_id`、上下文压缩和会话恢复。

## 入口

- 配置：`ProviderConfig`（稳定 `id` + 模板 `preset` + 可选 `name`/`enabled_models`）、`ProviderPreset`、`provider_for_id`/`provider_for`、`upsert_provider`、`remove_provider_by_id`。
- 元数据链：`AppHandle::provider_models(refresh)` → `GET /api/v2/config/provider/models`（`ProviderModelsDto`，缓存即时应答、refresh 有界内联拉取）；前端 `web/src/transport/` 是唯一接入层，actions `loadProviderModels` 失败静默回退静态列表。
- 启动选择：`HomeSelection`、`apply_home_selection`（迁移期沿用，WebUI 首页复刻同语义，见 design/webui-migration.md）。
- 密钥/设置：`api_key_cached*`、`store_api_key_cached`、连接列表与模板表单。
- 请求/恢复：`replay_safe_items`、请求游标、`protium-core (Git dependency): src/provider/openai.rs`、`protium-core (Git dependency): src/storage.rs` 的 Provider 状态。

## 不变量

- `Config.provider` 是当前连接；`Config.providers` 按稳定 `id` 唯一保存完整档案——内置四家仍各一份，自定义供应商可多份共存（`custom-<32 hex>`，显示名 trim 后必填，与内置显示名及已有自定义名大小写不敏感去重；历史无名 custom 允许空名回退 preset 标签）。旧 `[provider]`/无 `id` 旧档案在 `Config::load` 规范化为 `preset.key_id()` 后无损迁移（单一 custom 保持 `"custom"`），API Key 永不序列化。
- 非密钥配置按默认值 -> TOML -> 环境变量覆盖；模板只用 `ProviderPreset::defaults`，不得复制默认 URL。
- 启动只用 `api_key_cached` 解锁当前 Provider 一次，其他环境变量密钥可无交互预热（按 preset 家族查环境变量、按 id 入缓存）；不得遍历独立钥匙串条目。钥匙串账户名与进程缓存键均为 provider id：内置 id == preset key（向后兼容），自定义 id 各自独立。显式切换/编辑 Provider 可按需解锁一次，Agent 热路径只用 `api_key_cached_only`；新密钥通过 `store_api_key_cached` 同步钥匙串和内存。
- 启动选择只复制按 id 去重的非密钥档案；仅 `StartNew` 将所选 Provider/模型/mode 应用到配置与新会话并按需解锁，`Resume` 仍恢复目标会话状态。设置面板列出全部命名自定义供应商（名称必填、可无限添加、可改名/删除），转发 core 的名称校验与错误文案。
- 切换 Provider/模型必须重建 runner 并清理旧 `response_id` 与 usage anchor（core `rebuild_runner` 内统一清锚）。增量游标从最新用户消息开始且保留其后 `@` 上下文。
- 窗口解析（core 权威）：显式 `context_window_tokens` > 运行时发现（provider `/models`、models.dev）> 内置注册表；未知返回 `None`，不猜窗口。拉取全部事件驱动（切换、未知窗口首次 submit、设置显式刷新），无轮询、冷启动零网络；`[model_metadata] fetch = false` 全程离线，TTL 只门控刷新尝试。设置对话框模型下拉 = 拉取列表（仅当编辑的 preset+base_url 与 active 档案一致时适用，models.dev 社区值按模型精确键回填未报告字段）∪ 静态 preset 列表，custom 无列表时回退手输；窗口未知时暴露显式输入 + “获取”按钮（同 active 档案限定，强刷后回填，失败静默提示）；状态栏按 `ContextBudgetDto.window_source` 显示来源徽标（config/provider/community/registry/unknown），前端不得自行推断窗口。
- 压缩检查点和 `/uncompact` 都清理 `previous_response_id`；压缩摘要不得与旧服务端状态混用。
- 计量与溢出恢复由 core 权威实现，wire 无变更：`ContextBudgetDto.used_tokens` 来自 `session::estimate_used_tokens`（真实 usage 锚定前缀、增量按校准系数估算，锚随压缩/`/uncompact`/undo-redo/切 Provider 清除）；provider 确认的上下文溢出走"压缩→硬裁→严格下降才重试"恢复，重试上限 `compaction.max_overflow_retries`（clamp 0..=3，0 关闭），`ProviderRetry` 事件复用、前端已可渲染。
- 服务端状态失效后先清 ID，再用 `replay_safe_items` 重放；不得发送孤立 output 或无结果 call。
- DeepSeek Responses 不用 previous ID；原生搜索与同名本地 tool 互斥。
- Reasoning 事件按增量语义处理：空 content 不结束思考，done 的完整文本不重复追加；完成项 `summary` 仅在该流未收到任何思考增量时兜底（流级状态判定）。Qwen 3.7/3.8 字段按各协议隔离；custom 端点两种协议统一 `CompatibleAuto`，兼容全部已知思考增量事件形态（`reasoning_summary_text`/`reasoning_text`/`reasoning_content`/`reasoning` 的 `.delta`）。
- 私有 JSON/SSE 必须先规范化为公共事件；诊断输出始终脱敏。
- `enabled_models` 本期只持久化并经 DTO 往返（空 = 不限），不参与运行时过滤，也不改动模型列表拉取路径；"真正使用的模型"勾选留作后续独立改动。
- HTTP 层指数退避重试仅在"未发出任何事件"的失败上生效（连接/发送阶段错误与 408/429/500/502/503/504）；流中断不重试，由 agent 层空输出重放兜底；`Retry-After` 优先并被 clamp 到 `retry_max_backoff_ms`。重试上限与退避参数来自 `ProviderConfig`（0 关闭）并 clamp。

## 诊断

| 症状 | 检查顺序 |
| --- | --- |
| orphan tool output 400 | 游标 -> call/output ID -> response ID -> replay 过滤 |
| 切换后配置回退 | profile -> active 副本 -> session provider/model -> runner rebuild |
| 重复钥匙串弹窗 | 热路径 key 查询 -> cache-only -> 缓存错误是否被错误重试 |
| 请求/SSE 400 | `ProviderKind` -> body/tool/thinking 字段 -> SSE 终态 |
| 请求失败但无重试 | `retry_max_attempts`/clamp -> 错误分类（`retry_delay`）-> 是否已发事件 |
| 模型下拉无拉取列表 | `[model_metadata] fetch` -> 密钥是否就绪 -> base_url 是否与 active 档案一致 -> TTL/缓存行 -> 静态列表兜底 |

## 验证

- 迭代过滤器：`config::tests`、`settings::tests`、`secrets::tests`、`provider::openai::tests`、`provider::tests`（重试决策）。
- Agent 状态过滤器：`incremental_cursor_keeps_latest_user_message_and_following_context`、`stateless_replay_keeps_only_complete_ordered_tool_pairs`、`provider_retry_event_reaches_the_ui_channel`。
- 完成阶段按根文档运行一次 lib 测试；涉及存储恢复时升级到完整测试。
- WebUI 侧：`pnpm typecheck` + `pnpm test`（reducer/actions/transport 过滤器覆盖 `providerModels` 分发、refresh 参数与失败回退）；bindings 变更先 `cargo update -p protium-core` 再同步 `web/ts/`。
- 重试测试用 `OpenAiClient::scripted_with_failures`/`scripted_steps`（`Fail`/`Events`/`EventsThenFail`）模拟"发出事件后再失败"的流中断，验证不重试防 delta 重放；集成测用 1ms 退避避免 flaky。步骤按请求顺序严格消费且 `scripted_with_failures` 把失败全部前置，"失败→成功→失败"的交错序列须用纯失败步骤组合表达（如以 500 步令压缩失败、由 trim 路径产生进展，见溢出恢复耗尽测试）。
- 新增 `ModelEvent` 变体需一次接通：`StreamCollector::on_event` 的 `other => Some(other)` 自动透传 → agent 主/子 forward 闭包显式分支（`Send`/`SendIgnore`）→ 确认 `should_coalesce_stream_redraw` 是否需合并低频事件。
