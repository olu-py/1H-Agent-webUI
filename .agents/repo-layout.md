# 仓库目录结构与文件管理规范

> 适用范围：维护者（人类与 AI）新增、移动或清理任何文件时的唯一依据。解释每个目录的职责、每类生成物的来源与清理方式。与根协议冲突时以根协议为准。

## 目录地图（git 跟踪）

| 路径 | 职责 | 约束 |
| --- | --- | --- |
| `/` 根 | 仅标准文件：`README.md`、`AGENTS.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`Cargo.toml`、`Cargo.lock`、`.gitignore`、`.gitattributes` | 根目录**不新增**其他文件；临时维护计划进 `design/`，长期维护指南进 `.agents/guides/` |
| `.agents/` | AI 维护协议入口 `AGENTS.md` 的配套专题指南（`guides/`）、提交/PR 项目 Skill（`skills/git-pr-local-sync/SKILL.md`）、Windows 沙箱边界（`maintenance-env.md`）、本文 | 新专题指南须满足 `scripts/check-agent-docs.sh` 的结构与行数约束并在根协议路由表登记；被路由但不是专题指南的文档也各有行数预算 |
| `.github/workflows/`、`.github/dependabot.yml` | `ci.yml` 四个 job（`Frontend (web)`、`Linux quality`、`Minimum Rust (1.88.0)`、`Test (macos/windows-latest)`）、`release.yml` 发布、`main-guard.yml` 直推复核、`core-upgrade.yml` 自动升级，以及每周 Action 更新 | 引用脚本路径时与 `scripts/` 平铺布局保持一致；Action 固定完整 SHA |
| `.github/release-notes/` | 每个 tag 一份 `vX.Y.Z.md`，Release 流水线按名取用 | 新版本发布前必须补齐 |
| `.githooks/` | `pre-push` 钩子：本地直推兜底，对应 CI 的 `main-guard.yml` | 用 `scripts/install-hooks.ps1` 启用；钩子只是兜底，权威判定在 CI |
| `config/` | 仅 `config.example.toml`（配置样例与默认值快照） | 真实 `config.toml` 落在数据目录或系统配置目录，绝不入库 |
| `crates/1h-agent-web/` | WebUI 适配器 crate（HTTP/SSE 服务、鉴权、内嵌前端） | UI 无关逻辑在独立的 core 仓库 |
| `scripts/` | 平铺 15 个脚本（见下表），被 CI、README、根协议引用 | 不建子目录 |
| `web/src/`、`web/tests/` | React 源码与单测 | 网络访问只出现在 `src/transport/` |
| `web/ts/` | 从 core 同步的 TS 类型（ts-rs 生成） | 只经 `scripts/core-bindings.sh` 更新，禁止手改；CI 做漂移检查 |
| `web/dist/` | 前端构建产物（rust-embed 内嵌进二进制） | 只经 `pnpm build` 产生并随源码提交；CI 重建后 `git diff --exit-code` 校验 |

`scripts/` 归类：

| 类别 | 脚本 | 说明 |
| --- | --- | --- |
| 启动 | `start-web.ps1`（demo/formal 双模式，`-Restart` 停旧换新）、`start-web.sh`（demo）、`start-demo.bat`、`start-formal.bat`、`restart-demo.bat`（demo 一键重启，优先沿用原端口） | 构建过期产物、起服务、开浏览器；幂等复用已运行实例，`-Restart`/`restart-demo.bat` 停旧实例换新（构建失败不影响在跑实例） |
| 校验 | `check-agent-docs.sh`（文档一致性，CI）、`check-msrv-floor.sh`（依赖 rust_version 底线，CI）、`core-bindings.sh sync/check`（bindings 同步与漂移检查）、`smoke-web.sh`（无密钥端到端冒烟） | 冒烟用 `/.smoke-test-$$/` 临时目录，正常退出自清 |
| 打包 | `package-windows.ps1`、`package-linux.sh` | 默认输出到仓库外 `../1H-Agent-Release` |
| 交付/同步 | `push.ps1`（分支推送并校验远端 SHA）、`install-hooks.ps1`（启用 `.githooks/pre-push` 兜底）、`update-core.ps1`、`update-core.sh`（定向更新 core 依赖与锁文件） | 只暂存本次文件；推送前校验远端 SHA；详见 `.agents/guides/release.md` |

## 生成物地图（git 忽略；来源与清理）

| 路径 | 产生者 | 清理方式 |
| --- | --- | --- |
| `target/` | cargo 构建/测试 | 常规工具链的中间产物写在机器级共享缓存（见下节），但 **MSRV 工具链（1.88）不支持 `build.build-dir`，会回落到此处**；**禁止整目录 `cargo clean`**（见下节），单包清理用 `cargo clean -p <包名>` |
| `.1h-agent-data/demo/` | `start-web.*` demo 模式：`data/`（会话库）、`workspace/`（演示工作区）、`server.pid/.url/.log/.err.log` | 实例停止后可整目录删除，下次启动自动重建 |
| `.1h-agent-data/formal/` | `start-web.ps1 -Mode formal` 的 pid/url/log 句柄 | 数据本体在 `%LOCALAPPDATA%\1h-agent`；句柄目录可删 |
| `.pnpm-store/` | pnpm 在**写入受限沙箱**内 install 时的回退 store（见下节） | 删除后在普通终端于 `web/` 重装即恢复共享 store |
| `web/node_modules/` | `pnpm install` | 随时可删重装 |
| `bindings/`（任意层级） | ts-rs 在未设 `TS_RS_EXPORT_DIR` 且本地 path-patch core 联调时的 `cargo test` 默认导出 | 可删；正式类型只经 `core-bindings.sh` 进 `web/ts/` |
| `.cargo-targets-core/` | 历史遗留：曾用 `CARGO_TARGET_DIR` 重定向的 core 联调产物（现行做法见下节） | 出现即删；联调改用 `--config` path patch，不再重定向 target |
| `dist/`、`*.deb`、`*.msi`、`*.zip`、`*.tar.gz` | 本地打包（package 脚本输出在仓库外，此项防手滑） | 可删 |
| `gui-test-screenshots/` | 人工 GUI 验证截图 | 可删 |
| `.smoke-test-*/` | `smoke-web.sh` 被强杀时的残留 | 可删 |
| `design/` | 仅存放任务期间产生、完成后归档或删除的临时维护计划与实施记录；git 忽略不上传，仅本地留存 | 不得存放长期有效的维护指南或 workflow；长期规则写入 `.agents/guides/` 并登记在根 `AGENTS.md` |
| `config.toml`、`.env*`、`*.db*`、`*.log` | 密钥与运行态 | **绝不入库**；按需清理 |
| `/.1h-agent/`、`/.agent-data/`、`/.runtime-data/`、`/.1h-agent-*.md` | 历史遗留名，现行脚本与 core 均不再产生 | 出现即删（.gitignore 保留防护防复发） |

## cargo 中间产物共享缓存（机器级行为说明）

- 本机 `$CARGO_HOME/config.toml`（`D:\Rust\cargo\config.toml`）设了 `[build] build-dir = "D:/workbase/.cargo-build-cache"`：中间产物写在那个共享目录，TUI/core/webUI 三个仓库共用同一份。该键需要较新的工具链，而**本仓库 MSRV 档位是 1.88，会忽略它**（`target/.rustc_info.json` 里就是 rustc 1.88.0），因此跑过 MSRV job 后中间产物落回 `target/`——"`target/` 只剩锁与标记文件"只在从未跑过 MSRV 时成立。
- **禁止 `cargo clean`**：整目录 clean 会连共享缓存一起清空（`cargo clean --dry-run --locked` 即可复核：清单里除本仓 `target/` 外还有 `D:/workbase/.cargo-build-cache` 下的大量文件），等于三个仓库一起冷启、全部重编。要回收空间就删共享目录本身；只想清一个包用 `cargo clean -p <包名>`。
- **禁止为工具链、用途或联调另设 `CARGO_TARGET_DIR`**：同一目录内不同 rustc 版本与 SourceId 的产物各按指纹共存、互不驱逐，分目录只会重复编译。联调 core 用 `--config` 临时 path patch 与 `PROTIUM_CORE_PATH`（见 [README](../../README.md) 的本地联调示例与根协议「一分钟工作流」）。

## pnpm store：每台机器的行为说明

- pnpm 11 在 Windows 多盘机器（家目录在 C:、项目在 D:）的默认解析：从盘根**向下**找第一个可建立硬链接的目录，正常得到盘根共享 store `D:\.pnpm-store\v11`（本机已存在并由其他 D: 项目共用）。
- 在 DSH 等写入受限沙箱里，盘根不可写，「第一个可链接目录」落到仓库根，于是仓库内长出 `.pnpm-store/`。这是沙箱边界的产物，不是配置错误。
- 仓库内出现 `.pnpm-store/` 的清理：确认无 install 进行后删除该目录，再在普通终端 `web/` 下 `pnpm install --frozen-lockfile`（必要时先删 `node_modules` 重装），`node_modules/.modules.yaml` 的 `storeDir` 应回到 `D:\.pnpm-store\v11`。
- 不建议显式配置 `store-dir`（`%LOCALAPPDATA%\pnpm\config\config.yaml`）：显式路径会让沙箱内 install 直接 EPERM 失败，反而不如默认回退健壮。

## 新增文件归位规则

| 要新增什么 | 放哪里 | 备注 |
| --- | --- | --- |
| 维护/开发脚本 | `scripts/` 平铺 | 命名沿用 `动词-对象` 风格；更新 README/CI 引用 |
| 专题维护指南 | `.agents/guides/` | 需含五节结构、≤50 行，并在根协议路由表登记；`check-agent-docs.sh` 强校验 |
| 临时维护计划/实施记录 | `design/` | 仅限任务期间使用、完成后归档或删除的材料；git 忽略不上传；不得放长期维护指南或 workflow |
| 长期维护指南/workflow | `.agents/guides/` | 按专题指南结构约束编写，并在根 `AGENTS.md` 路由表登记 |
| 发布说明 | `.github/release-notes/vX.Y.Z.md` | 与 `Cargo.toml` 版本一致 |
| TS 协议类型 | 只经 `scripts/core-bindings.sh sync` 进 `web/ts/` | CI 漂移检查兜底 |
| 前端构建产物 | 只经 `pnpm build` 进 `web/dist/` | 不手改、不手造 |
| 任何运行时状态 | 数据目录（`AGENT_DATA_DIR` / `%LOCALAPPDATA%\1h-agent`）或 `.1h-agent-data/` | 不进跟踪区 |

## 定期维护例程

1. 巡检意外产物：`git status --ignored --short`，对照上表解释每一项。
2. demo 状态陈旧（无运行实例且不再需要演示会话）：删 `.1h-agent-data/demo/`。
3. 盘占用偏大：空间几乎都在机器级共享缓存 `D:\workbase\.cargo-build-cache`（三个仓库共用，见上节），确需回收就删该目录，**不要跑 `cargo clean`**。
4. 共享 store 膨胀（长期）：普通终端 `pnpm store prune`。
5. 文档改动：跑 `bash scripts/check-agent-docs.sh`（DSH 沙箱内 bash 不可用时按 `.agents/maintenance-env.md` 用 PowerShell 复刻断言）。
6. 任何「不知道哪来的文件」：先查本表与 `.gitignore` 注释，确认无引用后删除；若会复发，在 `.gitignore` 增防护并在本文登记。
