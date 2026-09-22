# 三仓推送流程指南

## 适用范围

适用于 Core、TUI、WebUI 的日常改动。具备写权限的维护者直接在 `main` 上提交并推送；三个仓库的版本仍独立维护。

## 入口

- 开始前检查 `git status --short --branch`；确认没有未提交改动，切换到 `main`，执行 `git fetch origin` 和 `git pull --ff-only origin main` 后再修改。
- 只暂存本次文件，检查 `git diff --cached --check` 和 `git diff --cached --stat`；运行与改动范围相称的测试和检查。
- 提交后执行 `git push origin main`。不要创建功能分支或 PR，也不要 force push。
- 推送后查看 GitHub Actions；检查失败时修复并追加提交，再推送到 `main`。

## 不变量

- `main` 允许有写权限的协作者直接推送；CI 在推送后运行，检查失败不会撤销已进入 `main` 的提交。
- 不 force push 或删除 `main`；提交前检查 staged diff，避免混入其他改动。
- 跨仓库 core 更新先提交并推送 Core，再将 TUI/WebUI 固定到明确的 40 位 `rev` 或稳定 tag，定向更新锁文件。
- WebUI 更新 core 后从锁定的 Git checkout 同步 bindings；移除 path patch/环境覆盖并运行 `core-bindings.sh check`。

## 诊断

| 阻塞 | 处理 |
| --- | --- |
| `main` push 被拒 | 检查仓库是否已移除 PR/审核门槛、当前账号是否有写权限；不要 force push。 |
| 本地 `main` 落后远端 | 先 `git fetch origin` 和 `git pull --ff-only origin main`；若无法快进，停止并查清分叉提交。 |
| 推送后 CI 失败 | 修复问题，运行受影响检查，提交修复并再次 push；必要时用 revert 恢复。 |
| 凭据异常 | 恢复 GitHub 凭据后重试原 push，不把 Token 写进命令、文件或日志。 |

## 验证

- Core/TUI：Rust 文档检查、fmt、全目标 Clippy、locked 测试和 release build；查看 push 后平台 CI。
- WebUI：Rust 文档检查、fmt、全目标 Clippy、locked 测试、bindings check、前端 typecheck/test/build。
- 每次提交前运行 `git diff --check`；push 后确认远端 `main` SHA 与本地一致并查看 CI 结果。
