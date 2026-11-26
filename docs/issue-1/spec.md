# Issue #1 需求文档（Spec）

> 依据 `grape-dsh/review/grape-dsh-compat-issues-analysis.md`（v1.1）整改 `@grape-dev/grape-dsh`。
> 目标分支：`dev-ch`；开发分支：`feat/issue-1`。

## 目标

让插件在 **Windows 与 Linux 两侧**都能正确完成：

1. 本机 Worker 检测与 grape CLI 自动安装（`/grape-worker-api/check`、`/install-grape`）；
2. 任务接管（`/grape-worker-api/takeover`），不再出现 `cmd.exe` 乱码报错，不发送空 `PRIVATE-TOKEN`；
3. 官网深链跳转带仓库维度，或按 A″-3 兜底并明确提示（禁止静默跳错）。

## 现状缺陷（实测/代码核对）

| # | 位置 | 缺陷 | 后果 |
|---|---|---|---|
| 1 | `src/index.ts` `/check` | `execSync('grape --version 2>/dev/null')`、`grape settings … 2>/dev/null` | Windows `cmd.exe` 无法执行 POSIX 重定向 → 恒定「未检测到 grape CLI」 |
| 2 | `src/index.ts` `/check` | 探测硬写 `grape`，无视 config `bin` | 用户配了绝对路径仍判未安装 |
| 3 | `src/index.ts` `/install-grape` | `python3` 硬编码 + `2>/dev/null`，只判断命令存在不校验版本 | Windows 无 `python3` → 误报「Python 未安装」 |
| 4 | `src/index.ts` `/install-grape` | `/opt/grape-cli`、`bin/activate`、`mkdir -p`、`test -f`、`ln -sf` | Windows 装不上；`os.platform()` 算出未用（死代码） |
| 5 | `src/index.ts` `/takeover` | 当前实现已改用 `fetch`（`grapeApiCall`）且 cancel 在服务端，但仍：无 token 时照发空 `PRIVATE-TOKEN`；失败路径遗留 token 文件；旧内联 POSIX 脚本仍随包 | 鉴权失败不可读、token 残留、静态自检命中 |
| 6 | `src/focus.ts` `grapeAppUrl` | 只有标量 `param`，无仓库维度；3 处调用点持有 `owner/repo` 未传 | 同号不同仓库跳到错误仓库（静默错位） |
| 7 | `src/index.ts` `/revoke` | `systemctl stop runtime-agent.service 2>/dev/null` | Windows 无 systemd；R6 要求平台分支 |
| 8 | `src/index.ts` `_buildOnboardCommand` | `$(...)`/`2>/dev/null`/`python3`，且无调用点 | 死代码 + 静态自检命中 |

## 范围

**In**：`/check`、`/install-grape`、`/takeover`（含 token 落盘与清理）、`/revoke` 服务停止平台分支、`/onboard` 凭据签发去 shell、`grapeAppUrl` + 3 处调用点、新增跨平台探测模块与测试。

**Out**：方案 B 全链路重写（`/onboard` 安装执行器、`/revoke` 凭据生命周期）、无关重构、Grape 服务端/前端代码。

## 关键设计

1. **不用 shell**：`spawnSync(bin, args[], { shell: false })`、`fetch`、`fs`/`path`/`os`；错误按「未安装（ENOENT）」与「执行失败（stderr）」区分。
2. **探测复用 config**：`config.bin` → `GRAPE_CLI_BIN` → 平台可执行名（`grape.exe` / `grape`）→ 本次会话内刚装好的路径。
3. **Python**：平台候选表（win32 `py`/`python`/`python3`；其它 `python3`/`python`），**真实解析 `--version` 并比较 ≥3.10**；找不到与版本过低分别给文案。
4. **安装布局**：`installLayout()` 按平台返回目录/解释器/pip/grape 可执行名（Windows `%LOCALAPPDATA%\grape-cli` + `Scripts\` + `pip.exe`；Linux `/opt/grape-cli` + `bin/`），目录用 `fs.mkdirSync({recursive:true})`，venv 存在性用 `fs.existsSync`，PATH 暴露用 `fs.symlinkSync`（仅 POSIX）。
5. **接管鉴权**：`resolveApiAuth()` config 优先、env 兜底；baseUrl/token 缺失时直接 503 并给出可读文案（不发空 `PRIVATE-TOKEN`）。token 文件仍留在工作区（本地 agent 必须能读，0600），接管失败时 `finally` 删除；启动时清理历史版本遗留在 `os.tmpdir()` 的 `grape-takeover-*.tok`。
6. **深链**：`grapeAppUrl(baseUrl, GrapeUrlTarget{view, owner, repo, number|seq})` → A″-2 `#pipe/<n>?repo=<owner>/<repo>`；前端是否消费 `?repo=` 未确认，故 UI 在按钮旁给出「若未自动定位仓库请手动选择」提示（A″-3 兜底语义，不静默跳错）。

## 验收

对应 Issue §9.1 / §9.1b / §9.2 P1~P8 / §9.3；测试见 `docs/issue-1/task.md`。