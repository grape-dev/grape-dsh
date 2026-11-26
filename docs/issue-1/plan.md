# Issue #1 方案设计（Plan）

## 模块划分

新增 `src/local-runtime.ts`（host 侧、纯函数 + 注入式探针，便于单测）：

| 导出 | 职责 |
|---|---|
| `runLocal(bin, args, timeoutMs)` | `spawnSync` 数组传参 + `shell:false`；返回 `{ok,status,stdout,stderr,error,missing}`，`missing` 区分 ENOENT |
| `pythonLaunchers(platform)` | 平台候选表（R5） |
| `findPython(platform, probe)` | 候选逐个探测并解析版本，返回满足 ≥3.10 的首个，否则返回找到的最高版本（`ok:false`） |
| `parsePythonVersion(text)` | `Python 3.12.10` → `{3,12,10}` |
| `pythonMissingMessage` / `pythonTooOldMessage` | 两种失败的可读文案（消除「Python 未安装」误导） |
| `grapeExecutable(platform)` | `win32 ? 'grape.exe' : 'grape'` |
| `installLayout(platform, env, home)` | 目录/venv/解释器/pip/grape 路径 + POSIX 软链目标；用 `path.win32` / `path.posix` 保证跨平台可测 |
| `resolveApiAuth(cfg, env)` | config 优先、env 兜底；缺 baseUrl/token 时返回 `error` 文案 |
| `cleanupStaleTakeoverTokens(dir)` | 清理历史遗留 `grape-takeover-*.tok`（默认 `os.tmpdir()`） |
| `stopRuntimeAgent(platform, probe)` | R6：Linux `systemctl` / Windows `sc.exe`→`Stop-Service`，两侧 try/catch |

## 三个切片（与里程碑一致，单 PR 三段提交）

### M1 探测 + 安装（commit 1）

- `/check`：`bin = config.bin || GRAPE_CLI_BIN || installedGrapeBin || grapeExecutable()`；`runLocal(bin, ['--version'])`；凭据列表用 `spawnSync` 取 `--json-out` 后再 `JSON.parse`；响应新增 `bin` / `probeError` / `grapeMissing`（前端忽略未知字段）。
- `/install-grape`：`findPython()` → 缺失/过低分别 503；`installLayout()` 建目录（`mkdirSync recursive`）、建 venv（`venvPython` 不存在才建）、`venvPip install <tarball>`、POSIX 侧 `symlinkSync`、`runLocal(grapeBin, ['--version'])` 验证；成功后记录 `installedGrapeBin` 供 `/check` 复用（避免「装好了仍检测不到」）。
- `/onboard` 凭据签发：`spawnSync(bin, ['settings','runtime','credential','create','--json',…,'--json-out'])`，JSON 解析在 Node 内完成（去 shell、去 `2>/dev/null`）；安装执行器本身属方案 B，本次不动。
- `/revoke`：删凭据改 `runLocal`；停服务走 `stopRuntimeAgent()` 平台分支。
- 删除死代码 `_buildOnboardCommand`（无调用点，且含 `$(...)`/`2>/dev/null`/`python3`）。

### M2 接管（commit 2）

- `resolveApiAuth()`：config `baseUrl`/`token` 优先，env 兜底；缺失时 503「未配置 token」等可读文案 → 不再发送空 `PRIVATE-TOKEN`。
- `prepareTakeoverWorkspace()`：路径改 `path.join`；返回 `tokenFile`；`/takeover` 用 `try/finally`，接管失败（prompt 为空、异常、提前 return）时删除刚写入的 token 文件。
- 挂载时调用 `cleanupStaleTakeoverTokens()` 清理 `os.tmpdir()` 里旧版本遗留的 token 文件。
- 删除旧服务端兜底的内联 POSIX 脚本生成（`.grape-takeover-report.sh` / `.grape-takeover-request-finish.sh`：仅 POSIX、`2>/dev/null` + `python3`，且 `authorization: Bearer ***` 是失效占位值，从未可用）；脚本统一由服务端按 `host_os` 渲染（`bundle.assets.scripts` → `writeTakeoverScripts`），缺资产时打印明确告警。

### M3 深链（commit 3）

- `focus.ts`：`grapeAppUrl(baseUrl, target: GrapeUrlTarget)`；`pipe` → `#pipe/<n>?repo=<owner>/<repo>`；`event` → `#event/<seq>?repo=…`；`dash` → `#dash?repo=…`；无仓库时不带参数（保持旧行为）。
- `pipelineFocus` 透传 owner/repo；`eventFocus(baseUrl, seq, ref?)` 支持可选仓库；`overviewFocus` 带仓库。
- 调用点：`GrapeBrowsePanel.tsx:970`、`pins-store.ts:435`、`focus.ts:163`；`GrapeBrowsePanel` 与 `Footprint`（焦点卡 EscapeHatch）在按钮旁给出「若官网未自动定位到 <owner>/<repo>，请在页面顶部手动选择」提示（A″-3 兜底，不静默跳错）。

## 测试缝（seam）

`src/local-runtime.ts` 的纯函数 + 注入式 `probe`；`src/focus.ts` 的 URL 构造器。
测试用 Node 内置 `node:test`（`test/*.test.mjs`，跑 `lib/` 编译产物，`npm test = build && node --test test/`），不引入第三方依赖。

覆盖：
1. `bin` 错误路径 → `runLocal` 返回 `ok:false` 且 `missing:true`（/check 不误报成功）；有效可执行（`process.execPath --version`）→ `ok:true`（证明无 shell 也能跑）。
2. Python 3.9 → `findPython` 返回 `ok:false`，文案含「版本过低」；无候选 → `null` + 「未找到」文案。
3. 无 token → `resolveApiAuth` 返回 `error`（含「未配置 token」），且 token 为空。
4. token 清理 → `cleanupStaleTakeoverTokens(dir)` 只删 `grape-takeover-*.tok`，保留其它文件。
5. 同号不同仓库 → `grapeAppUrl` 两个 URL 不同且各自含 `repo=<owner>/<repo>`；同一目标两次调用一致（两个按钮同 URL）。
6. `installLayout('win32')` → `Scripts\pip.exe` / `Scripts\grape.exe` / `LOCALAPPDATA`；`installLayout('linux')` → `/opt/grape-cli` / `bin/pip` / `bin/grape`。

## 风险

| 风险 | 缓解 |
|---|---|
| `?repo=` 需 Grape 前端消费（Q2 未确认） | URL 已带仓库维度 + UI 明确提示手动选择；PR 说明依赖 |
| 删除内联 POSIX 脚本影响「老服务端」 | 该脚本 `Bearer ***` 失效，本就不可用；缺资产时告警 |
| `pip install` 新装路径未被 PATH 收录（Windows） | `/check` 优先使用本会话安装路径 `installedGrapeBin` |
| 接管会取消原任务（既有语义） | 不改变语义，PR 中重申风险 |