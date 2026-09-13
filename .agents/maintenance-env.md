# 维护环境：Windows pwsh/沙箱命令边界

> 适用范围：AI 维护代理在 Windows（DSH harness 沙箱）执行命令的已知边界与解法。人类开发者在普通终端不受影响，不要把这些边界当成产品缺陷或源码问题。配合根文档"实施与验证"节使用。

## 已知边界

| 症状 | 根因 | 解法 |
| --- | --- | --- |
| 原生命令输出经管道接入 cmdlet 时进程启动被拒，报 `拒绝访问` 或 `StandardOutputEncoding is only supported when standard output is redirected`（如 `node --version \| Select-Object`、`pnpm test 2>&1 \| Select-Object -Last 15`） | 原生进程 stdout 被管道重定向即触发沙箱拒绝；裸跑同一命令正常 | 原生命令一律裸跑，预截断交给执行器（超长输出自动截断并存盘）；退出码用 `; "exit=$LASTEXITCODE"` 追加，不用管道尾拼命令 |
| `cmd /c "…"` 启动被拒（拒绝访问） | cmd.exe 属被拒启动面 | 不绕道 cmd，直接调 `pnpm <script>`、`node <file>`（bash 本身启动即崩，见下） |
| vite/vitest 报 `spawn EPERM`（errno -4048，栈在 esbuild `ensureServiceIsRunning`） | esbuild 服务进程按默认 `stdio:'pipe'` spawn，命中沙箱命名管道边界；vitest 加载 vite.config.ts 时即触发，`--pool=threads` 绕不开 | 确认为同一 EPERM 后，按沙箱提权策略对被拒原命令一次性放宽重试（附一句正当理由）；禁止为绕开而改写产物或写第二套构建 |
| vitest forks 池 spawn/IPC EPERM | worker 经 IPC（命名管道）通信 | 纯逻辑测试可先试 `--pool=threads`（worker_threads 进程内）；但配置加载仍需 esbuild，通常最终仍需提权 |
| `bash`（含 Git 自带 `bash.exe`）启动即崩：`fatal error - couldn't create signal pipe, Win32 error 5` | cygwin 运行时初始化需要内部信号管道，命中命名管道边界 | `scripts/check-agent-docs.sh` 等脚本校验改用 PowerShell 逐条等价断言复刻（对齐脚本检查项），或在提权会话运行原脚本 |

## 可靠默认

- 验证命令裸跑：`pnpm typecheck`、`pnpm test`、`pnpm build`、`cargo test --quiet --lib --all-features --locked <filter>`；`git status --short --branch` 与 cmdlet 内部管道不受影响。
- `pnpm typecheck 2>&1; "exit=$LASTEXITCODE"`（无 cmdlet 消费者）可行；`… | Select-Object` 不可行。
- 改 `web/` 后完整链：`pnpm typecheck && pnpm test && pnpm build`；rust-embed debug 构建重启即读新 `web/dist/`，release 构建需重编译二进制。
- 沙箱拒绝总是显式报错（`[sandbox: …]`、EPERM、拒绝访问）：先对照上表；命中则按既定策略（原命令一次性提权重试，被拒后即终局），未命中则不要换写法重试。
