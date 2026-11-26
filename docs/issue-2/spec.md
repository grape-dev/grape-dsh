# Issue #2 需求文档（Spec）

> 依据 Issue #2 评论「📋 Spec Document」与「[VOD Agent] 需求结构化收敛」，基线分支 `dev-ch`，开发分支 `feat/issue-2`。

## 目标

把「本机接入」从「按模板重建」改为「先读本机事实、原样复用身份」：

1. 已接入的机器必须被判为「已接入」，设备名原样取自本机 `RUNTIME_DEVICE_NAME`，不再按 `dsh-<host>` 重推导；
2. 点「接入」对已安装的机器**零副作用**（不新建 credential、不新增设备、不改 `runtime.env`、不重启 worker）；
3. 已安装但未运行时静默拉起一次，受 5 分钟节流与退出码 42 约束；
4. 面板时间按浏览器时区渲染并自动刷新；
5. 全流程遵守 Issue #1 的 R1~R10 铁律（禁 shell 拼串 / POSIX 重定向 / 写死 `/tmp`、`/opt`，路径走 `path`/`os`，可执行名按平台）。

## 现场事故与根因（已核实，基线 `dev-ch`）

| # | 定位 | 事实 | 后果 |
|---|---|---|---|
| 1 | `src/index.ts:995` `/check` | `name = dsh-<host>` 截 88 字符，仅按 credential 名匹配；不读 `runtime.env`；CLI 失败即 `found:false` | 已接入机器被判「未接入」 |
| 2 | `src/index.ts:1123` `/onboard` | 无条件 `credential create` → `workerInstallCommand()` → `execSync` 安装；安装脚本重写 `runtime.env` 并重启 worker；无 rollback | 新 credential → 新 `runtime_id` → 场景 `engine_runtime_ids` 失效 → 设备离线，旧 `rta_` 不可恢复 |
| 3 | `src/worker-onboard.ts` | 已有 `mintCredential`/`listCredentials`，但 `index.ts` 未接线；无「按本次 `created.id` 撤销」helper | 逻辑两份风险 |
| 4 | `src/client/GrapeMachinePanel.tsx:201,206` | `last_seen_at.slice(0,19)` 把 UTC 当本地时间（少 8 小时）；仅挂载时查询一次 | 时间错误、状态陈旧 |
| 5 | `src/install-command.ts:12` | `workerInstallCommand()` 是「改名 + 重写 env」的唯一执行入口 | 必须在状态机里收敛调用条件 |

## 本机事实来源（与服务端安装脚本逐字核对）

抓取线上安装脚本（`GET /api/runtime/install`、`install.ps1`）核对，四种布局与 `runtime.env` 键如下：

| 平台 / 用户 | 安装目录 | 配置文件 | 启动脚本 |
|---|---|---|---|
| Windows | `%USERPROFILE%\grape` | `%USERPROFILE%\.grape\runtime.env` | `<dir>\start-worker.ps1` |
| Linux/macOS 普通用户 | `$HOME/grape` | `$HOME/.grape/runtime.env` | `<dir>/start-worker.sh` |
| Linux root（`id -u`=0） | `/opt/grape` | `/etc/grape/runtime.env` | `/opt/grape/start-worker.sh` + systemd `runtime-agent` |

`runtime.env` 由安装脚本写入（`umask 077` + `chmod 600`）：

```
RUNTIME_TOKEN=<rta_...>
RUNTIME_SERVER_URL=<server>
RUNTIME_DEVICE_NAME=<device>
RUNTIME_MAX_CONCURRENT_TASKS=20
RUNTIME_POLL_INTERVAL=3
RUNTIME_HEARTBEAT_INTERVAL=15
```

版本文件：`<cfgDir>/worker.version`（安装脚本从 `<dir>/VERSION` 复制）。

进程识别：安装脚本不写 pid 文件；POSIX 侧 `pgrep -f "<start-script>.*-m src.runtime.agent"`，
Windows 侧 `Get-CimInstance Win32_Process` 且 `CommandLine -like '*src.runtime.agent*'`。
故本实现以「python 解释器 + `-m src.runtime.agent`」为唯一主判据（`isWorkerCommand`，避免日志/编辑器里恰好出现该串时把离线误报成运行中）；`pgrep -f` 兜底只回 pid、命令列置为固定串时单独放行；pid 文件仅作存在时的快速路径（`process.kill(pid,0)`）。

## 服务端契约（`grape --help` 实证）

| 用途 | 端点 |
|---|---|
| 列凭据 | `GET /api/settings/runtime-credentials` |
| 签发凭据 | `POST /api/settings/runtime-credentials`（body `{name, scope, repo_key}`） |
| 吊销凭据 | `POST /api/settings/runtime-credentials/{cid}/revoke`（body 无；按 cid 删行并级联） |
| 列设备 | `GET /api/settings/runtime-devices?page=&page_size=`（按 `credential_id` 分组，含 `device_name`/`health`/`worker_version`/`runtimes`） |

## 范围

**In**：`readLocalWorker()` 四布局只读探测；`/check` 多源只读判定；`/onboard` 幂等状态机 + credential 事务化；
`/ensure-worker` 静默拉起 + 节流 + code 42；`formatTime` + 面板自动刷新；对应单测。

**Out**：不改设备默认命名规则（新建仍为 `dsh-<host>` 截 88）；不做服务端数据迁移；不重构 `src/panel-api.ts`（repos/issues/pipeline 只读代理，与 worker 路由无关）；不做后台无条件轮询；不清理 `main` 上历史 POSIX 写法（属 Issue #1 范围）。

## 验收标准

- [x] 已接入机 `/check` → `found:true`、`deviceName` 等于本机 `RUNTIME_DEVICE_NAME`、`source=runtime-env`（`readLocalWorker` runtime-env 用例 + `decideOnboard` already-connected）
- [x] 已装机点「接入」→ 0 新增 credential / 设备、`runtime.env` 不变、worker 不重启（返回 `already-connected`）（`decideOnboard` 分支 + `runOnboardTransaction` 仅在 initialize/reinstall 触达）
- [x] 本地数据即可渲染设备卡；CLI 补全成功；CLI 失败显示「设备信息读取失败」且接入按钮禁用（`readLocalWorker` EACCES 用例 + `read_error` 态）
- [x] 已装未运行 → 自动拉起 1 次，遵守 5 分钟节流；code 42 不拉起（`shouldAutoStartWorker` 节流 / code42 / 用户停止用例 + `recordAutoStart` 用例）
- [x] credential 创建后安装失败 → 自动按本次 id revoke，无孤儿凭据/设备（`runOnboardTransaction` 失败路径 + `verifyDeviceOnline` 按 `created.id` 匹配用例）
- [x] 面板时间 = 浏览器本地时间；15~30s 自动刷新，隐藏暂停，回前台刷新（`formatTime` 用例 + 面板 `setInterval` + `visibilitychange`）
- [x] 单测覆盖 win32 / linux-root / linux-user / macOS、`formatTime`、拉起节流、`listServerDevices` 分页、`matchCredential` 多凭据；`npm test` 77/77 全绿
- [x] 新增代码无 POSIX 专用命令/重定向（`/dev/null`、`/tmp/`、写死 `/opt/`、`mkdir -p`）

## 复审修复（PR #2 审查意见）

| 审查项 | 修复 |
|---|---|
| Required#1 `readServerState` 多行凭据误判 | 新增 `matchCredential()`：device_name 优先、name 兜底、**active 优先**；`/check` 同步复用 |
| Required#2 `verifyDeviceOnline` 按名字校验 | 改为按本次 `created.id` 精确匹配；事务把 `created.id` 传给 `verify`，旧凭据行不再能误判 failed |
| Required#3 `/onboard` 并发签发 | 进程内 promise 互斥：在途请求直接返回 409 `inFlight`（不排队、不复用首次结果），双击/双标签/超时重试不得并发签发两条凭据 |
| Required#4 `/revoke` CLI-only 部署失去能力 | API Key 缺失时回落 `grape settings runtime credential revoke --cid`，CLI-only 部署保留注销能力 |
| 测试缺口 | 新增 `verifyDeviceOnline`（id 匹配 / 旧行回归 / pending）、`listServerDevices` 分页、`readServerState`+`matchCredential` 多凭据、`startLocalWorker` 拉起路径用例 |