# 发布维护指南

## 适用范围

版本、CI、release notes、tag、平台归档、安装包和 GitHub Release。

## 入口

- `Cargo.toml`：WebUI 版本；`Cargo.lock`：依赖及锁定的 core commit；`.github/workflows/ci.yml`：三平台日常验证。
- `.github/workflows/release.yml`：正式发布；`.github/release-notes/`：按 tag 命名的说明。
- `scripts/package-*` 仅作本地辅助，不是 GitHub Release 的权威流程。

## 不变量

- Cargo manifest/lock 版本一致；tag 是同版本的新 annotated `vX.Y.Z`，不得移动或复用成功 tag。
- core、TUI、WebUI 版本号和 tag 独立；兼容性由锁定 core commit、协议版本、bindings check 和适配器测试确认。
- 本地联调允许 path patch/`PROTIUM_CORE_PATH`；发布前必须移除覆盖，禁止提交 path 锁文件或来自未交付 core 的 bindings。
- core 必须先 push；本仓库再定向更新 core、同步 bindings、构建并提交 `web/dist`，WebUI release 不隐含发布其他仓库。
- 先提交并推送 main、核对远端 SHA，再建 tag；notes 文件必须是 `.github/release-notes/vX.Y.Z.md`。
- 权威流程：版本校验 -> 三平台验证 -> 四目标归档和安装包 -> checksums -> GitHub Release。
- 归档保留 README、LICENSE、第三方声明和示例配置；Release 包含归档、DEB、MSI、checksums 和 notices。
- 不假定本机有 `gh`；凭据不得进入命令、文件、日志或回复，Actions 使用最小权限 token。

## 诊断

| 症状 | 检查顺序 |
| --- | --- |
| push 无结果 | keychain 解锁 -> 远端 SHA/API；禁止把本地输出当成功 |
| workflow 未启动 | 远端 tag -> `v*` 匹配 -> tag 指向/notes/版本提交 |
| version 失败 | tag 去 `v` -> `protium-web` metadata -> lockfile version |
| core/bindings 不一致 | `Cargo.lock` core SHA -> `core-bindings.sh check` -> `web/ts`/适配器 |
| 发布仍引用本地 core | Cargo patch/env -> metadata source -> lockfile Git SHA -> 无覆盖 bindings check |
| publish 失败 | build/installers artifacts -> notes -> checksums -> 权限 |
| 单平台失败 | runner shell -> 路径语义 -> 平台专用依赖/命令 |

## 验证

```bash
cd web && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build && cd ..
bash scripts/core-bindings.sh check
cargo fmt --all -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --quiet --all-features --locked
cargo build --release --locked
git diff --check
```
