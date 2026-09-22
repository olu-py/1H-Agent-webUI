# 三仓推送流程指南

## 适用范围

适用于 Core、TUI、WebUI 从本地改动、功能分支推送到 PR 合并的日常流程；仓库版本独立维护。

## 入口

- 开始前运行 `git status --short --branch`、`git branch --show-current`、`git fetch origin`；保留已有改动。
- 只暂存本次路径，检查 `git diff --cached --check` 和 `git diff --cached --stat`，再按单一职责提交。
- 运行仓库验证：Core/TUI 用各自最终矩阵；WebUI 另跑 bindings check、`pnpm install --frozen-lockfile`、typecheck、test、build。
- PR 前合入 `origin/main` 并重跑受影响检查；推送当前功能分支：`git push -u origin HEAD`。
- PR 描述改动、验证结果、生成物；core 升级另列旧/新 SHA、changelog 和锁文件/bindings 变化。

## 不变量

- `main` 只经 PR 更新，不直接推送；功能分支满足 required checks、与 `main` 同步及所需审核后再合并。
- 不强推共享分支、不为绕过失败而长期关闭保护规则；自动升级流程创建 PR，不自动合并。
- 跨仓库 core 变更先推送并合并 Core，再将 TUI/WebUI 固定到 40 位 `rev` 或稳定 tag，定向更新锁文件。
- WebUI 更新 core 后从锁定 Git checkout 同步 bindings；交付前移除 path patch/环境覆盖，运行 `core-bindings.sh check`。

## 诊断

| 阻塞 | 处理 |
| --- | --- |
| `main` push 被拒 | 推送功能分支并走 PR；不要尝试绕过保护。 |
| PR 缺审核 | 等待有写权限的审核者；Token 写权限不能替代审批。 |
| 分支落后 `main` | `git fetch origin`、合并 `origin/main` 到功能分支、解决冲突、重跑检查再推送。 |
| 检查失败或凭据异常 | 修复失败项或恢复凭据；不得静默改写 `main`。 |

## 验证

- Core：文档检查、fmt、全目标 Clippy、locked 全测、release build；确认 macOS/Windows required checks。
- TUI：文档检查、fmt、全目标 Clippy、workspace locked 全测、release build。
- WebUI：文档检查、fmt、全目标 Clippy、locked 全测、bindings check、前端 typecheck/test/build、`git diff --check`。
- 合并后确认远端 PR 状态及 CI；本地 `main` 合并不代表远端 `main` 已更新。
