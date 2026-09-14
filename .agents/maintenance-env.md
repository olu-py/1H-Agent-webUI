# 维护环境：Windows pwsh/沙箱命令边界

> 适用范围：AI 维护代理在 Windows（DSH harness 沙箱）执行命令的已知边界与解法。人类开发者在普通终端不受影响，不要把这些边界当成产品缺陷或源码问题。配合根文档"实施与验证"节使用。

## 已知边界

| 症状 | 根因 | 解法 |
| --- | --- | --- |
| 原生命令输出经管道接入 cmdlet 时进程启动被拒，报 `拒绝访问`、`StandardOutputEncoding is only supported when standard output is redirected` 或 `StandardErrorEncoding is only supported when standard error is redirected`（如 `node --version \| Select-Object`、`pnpm test 2>&1 \| Select-Object -Last 15`、`git ls-files \| ForEach-Object`、`git show … \| Select-Object`；`git … 2>$null` 这类 stderr 重定向同样触发） | 原生进程 stdout/stderr 被重定向接入 cmdlet 即触发沙箱拒绝；裸跑同一命令正常 | 原生命令一律裸跑，预截断交给执行器（超长输出自动截断并存盘）；退出码用 `; "exit=$LASTEXITCODE"` 追加，不用管道尾拼命令；`git` 输出加工交给 `git` 自身参数（`--oneline`、`-n <N>` 等） |
| `cmd /c "…"` 启动被拒（拒绝访问） | cmd.exe 属被拒启动面 | 不绕道 cmd，直接调 `pnpm <script>`、`node <file>`（bash 本身启动即崩，见下） |
| vite/vitest 报 `spawn EPERM`（errno -4048，栈在 esbuild `ensureServiceIsRunning`） | esbuild 服务进程按默认 `stdio:'pipe'` spawn，命中沙箱命名管道边界；vitest 加载 vite.config.ts 时即触发，`--pool=threads` 绕不开 | 确认为同一 EPERM 后，按沙箱提权策略对被拒原命令一次性放宽重试（附一句正当理由）；禁止为绕开而改写产物或写第二套构建 |
| vitest forks 池 spawn/IPC EPERM | worker 经 IPC（命名管道）通信 | 纯逻辑测试可先试 `--pool=threads`（worker_threads 进程内）；但配置加载仍需 esbuild，通常最终仍需提权 |
| `bash`（含 Git 自带 `bash.exe`）启动即崩：`fatal error - couldn't create signal pipe, Win32 error 5` | cygwin 运行时初始化需要内部信号管道，命中命名管道边界 | `scripts/check-agent-docs.sh` 等脚本校验改用 PowerShell 逐条等价断言复刻（对齐脚本检查项），或在提权会话运行原脚本 |
| pwsh 字面量断言误判：`-like '*[AGENTS.md](AGENTS.md)*'` 判为不匹配（复刻文档检查时曾因此误报 README 缺链接） | `-like` 把 `[...]` 当通配符字符类，`-match` 把它当正则字符组，均非字面语义 | 字面量包含判断用 `.Contains()`，或 `[regex]::Escape($pat)` 配 `-match`；断言失败先怀疑匹配语义再怀疑内容 |
| 新增目录类 ignore 防护后用空目录探针验证，`git status --ignored` 不显示该目录 | git 只跟踪文件，空目录不进入任何状态 | 探针目录里先放一个文件再验证；验证后清理探针文件与目录 |
| 沙箱内 `pnpm store path` / `pnpm install` 结果不可信：解析到仓库内 `.pnpm-store` 回退位，或直接 EPERM | pnpm 解析 store 前要在盘根等位置写临时探测文件找「第一个可链接目录」；沙箱仅工作区可写，探测结果落在仓库根 | store 迁移、重装、验证一律在完整权限下执行；回退成因与清理流程见 `.agents/repo-layout.md` 的 pnpm store 节 |
| `Select-String`/`Get-Content` 对仓库内 UTF-8 无 BOM 的中文文档做模式匹配静默失配（复刻 `check-agent-docs.sh` 断言「## 适用范围」查不到、行数统计虽对但内容比对全空） | Windows PowerShell 5.1 对无 BOM 文件按 ANSI/GBK 解码，中文字节按错误码页比对 | 文本读取与断言一律用 `[System.IO.File]::ReadAllText/ReadAllLines($path, [System.Text.Encoding]::UTF8)`（或 `-contains` 精确行比对），不用 `Get-Content`/`Select-String` 直读 |
| `Get-Content -Raw` 后 `.Replace("`n…")` 在 CRLF 文件上是静默无操作（内容不变）；PS 5.1 `Set-Content -Encoding UTF8` 又会写入 BOM、有把整文件重写的风险 | 字符串模式只含 LF 与实际 CRLF 字节不符；PS 5.1 的 UTF8 编码器固定带 BOM | 文本修改一律用文件编辑工具；必须脚本化时按字节处理（同时匹配 `` `r`n ``/`` `n ``）并用 `[System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))` 写回，改后 `git diff --stat` 复核无整文件重写 |
| `pnpm config set … --global` 报 `The configured global bin directory … is not in PATH`，配置未写入 | pnpm 11 要求先 `pnpm setup`（全局 bin 入 PATH）才允许该命令写配置 | 不必为此跑 setup：pnpm 11 全局配置文件是 `%LOCALAPPDATA%\pnpm\config\config.yaml`，键用 **camelCase**（如 `storeDir`；`~/.npmrc`、`config\rc` 与 kebab-case 键均实测无效）。共享 store 诉求默认行为已满足；显式 `storeDir` 会让沙箱内 install 硬失败，勿设 |

## 可靠默认

- 验证命令裸跑：`pnpm typecheck`、`pnpm test`、`pnpm build`、`cargo test --quiet --lib --all-features --locked <filter>`；`git status --short --branch` 与 cmdlet 内部管道不受影响。
- 字面量断言用 `.Contains()` 或 `[regex]::Escape()`，不用 `-like` 裸模式（`[...]` 是通配符字符类）。
- 删除运行时状态目录前先确认无存活实例（读 pid 文件 + `Get-Process -Id <pid>`，或 `Get-Process 1h-agent-web`）。
- `pnpm typecheck 2>&1; "exit=$LASTEXITCODE"`（无 cmdlet 消费者）可行；`… | Select-Object` 不可行。
- 改 `web/` 后完整链：`pnpm typecheck && pnpm test && pnpm build`；rust-embed debug 构建重启即读新 `web/dist/`，release 构建需重编译二进制。
- 沙箱拒绝总是显式报错（`[sandbox: …]`、EPERM、拒绝访问）：先对照上表；命中则按既定策略（原命令一次性提权重试，被拒后即终局），未命中则不要换写法重试。
