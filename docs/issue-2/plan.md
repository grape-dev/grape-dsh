# Issue #2 方案设计（Plan）

## 模块划分

### `src/local-runtime.ts`（新增，host 侧纯函数 + 注入式探针）

| 导出 | 职责 |
|---|---|
| `workerLayout(platform, env, home, uid)` | 单平台规范布局：`installDir` / `envFile` / `versionFile` / `startScript` / `pidFile` / `rootMode`；用 `path.win32` / `path.posix` 显式构造，单测可在任一平台断言四侧结果 |
| `workerLayoutCandidates(...)` | 规范布局 + POSIX 侧另一布局（root 装了非 root 布局或反之），去重保序 |
| `parseEnvText(text)` | 解析 `KEY=VALUE`（忽略注释/空行，去包裹引号） |
| `readLocalWorker(deps)` | 只读探测 → `{installed, running, deviceName, serverUrl, version, tokenPresent, installDir, envFile, source, readError}`；`source ∈ runtime-env / process / install-dir / none` |
| `listWorkerProcesses(platform, probe)` | POSIX `ps -A -o pid=,args=`（退化 `pgrep -f`）；Windows `powershell -Command Get-CimInstance Win32_Process`，数组传参、`shell:false` |
| `startLocalWorker(layout, platform, spawnFn)` | 拉起：POSIX root 走 `systemctl start runtime-agent.service`，非 root 执行 `start-worker.sh`；Windows 执行 `start-worker.ps1`；返回是否已发起 |
| `shouldAutoStartWorker(facts, now)` / `markWorkerAutoStarted` / `blockAutoStart` / `resetAutoStartState` | 静默拉起护栏：5 分钟/设备节流、code 42 与用户显式停止的进程内永久屏蔽 |

关键约束：一切路径 `path`/`os` 构造；POSIX 根目录用 `posix.join(posix.sep,'opt','grape')` 而非字面量；命令一律 `spawnSync/spawn(bin, args[], {shell:false})`。

### `src/time-format.ts`（新增，浏览器与单测共用）

`formatTime(iso, opts?)`：无 `Z`/偏移的时间补 `Z` 按 UTC 解析 → `Intl.DateTimeFormat` 按 `timeZone`（默认浏览器时区）渲染
`YYYY-MM-DD HH:mm:ss`；无法解析时原样返回（不丢信息）。`opts` 可注入 `locale`/`timeZone` 以便单测断言确定性。

### `src/worker-onboard.ts`（补充，单一实现）

| 导出 | 说明 |
|---|---|
| `mintCredential` / `listCredentials` | 既有实现改为导出 |
| `listServerDevices(cfg, pageSize)` | `GET /api/settings/runtime-devices`，翻页聚合（分页是硬约束） |
| `revokeCredential(cfg, id)` | `POST /api/settings/runtime-credentials/{id}/revoke`，**只按本次 `created.id`**；`index.ts` 的 `/revoke` 改为调用它（不再保留第二份 CLI 调用） |
| `decideOnboard(local, server)` | 纯状态机：`read-error` / `initialize` / `start` / `already-connected` / `conflict` / `confirm-reinstall` / `reinstall` |
| `runOnboardTransaction(deps)` | 事务化：`create → install → verify`，`catch` 内 `revokeCredential(created.id)` 并抛出 |

状态机（铁律：`installed=true` 一律不安装）：

| 本地状态 | 行为 | HTTP |
|---|---|---|
| `readError` 非空 | `read-error`：不安装、不建凭据 | 500 |
| 未安装 + 服务端已有同名凭据 | `conflict`：可能同名设备属另一台机器，只报冲突、不重复造身份 | 409 |
| 未安装 | `initialize`：按现有默认命名 `dsh-<host>` 建凭据 + 安装 | 200 |
| 已装 + 未运行 | `start`：静默拉起，不建凭据、不改名、不改 env | 200 |
| 已装 + 运行 + 无同名凭据 | `already-connected`：零副作用 | 200 |
| 已装 + 运行 + `device_name` 与本地不一致 | `conflict`：明确报冲突，不做静默迁移 | 409 |
| 已装 + 运行 + 凭据非 active | 需 `confirm:true` 才 `reinstall`（同设备名新建凭据 + 重装） | 409 |

### `src/index.ts`（路由编排）

- `GET /check`：**严格只读**。`readLocalWorker()` → 本地事实；`grape --version` 判 CLI；`credentials`/`devices` 仅做补全。
  响应新增 `source/deviceName/serverUrl/workerVersion/processAlive/tokenPresent/readError/installDir/installed`。
- `POST /onboard`：`decideOnboard` → 按动作执行；`installed` 路径绝不调用 `workerInstallCommand()`。
- `POST /ensure-worker`（新增）：静默拉起入口（面板打开/刷新调用），受 `shouldAutoStartWorker` 护栏；`/check` 保持只读。
- `POST /revoke`：优先 `revokeCredential()` + `stopRuntimeAgent()`，并写入「用户显式停止」标记。
  无插件 API Key 的 CLI-only 部署回落 `grape settings runtime credential revoke --cid`（保留注销能力）。
- `POST /onboard` 进程内 promise 互斥：在途时返回 409 `inFlight`，避免双击/双标签/超时重试并发签发两条凭据。

### `src/client/GrapeMachinePanel.tsx`

- `formatTime` 覆盖 `last_seen_at` / `created_at`，UTC 原文进 `title`（tooltip）。
- 新增 `read_error` 态：显示「设备信息读取失败」并**禁用接入按钮**。
- 设备卡优先用本地事实（`deviceName`/`workerVersion`/`processAlive`/`tokenPresent`/`serverUrl`），凭据信息仅作补全。
- 20s 定时刷新 + `document.hidden` 时暂停 + `visibilitychange` 回前台刷新 + 保留手动「刷新」。
- 检查到 `installed && !processAlive && !readError` 时触发 `/ensure-worker`；失败回写原因并按 5 分钟节流重试。
- 未运行时展示 `autoStartBlocked` 原因（code 42 / 用户停止），不再永远显示「将自动尝试拉起」。

## 关键取舍

| 决策 | 选择 | 理由 |
|---|---|---|
| D1 静默拉起入口 | 独立 `POST /ensure-worker` | M1 要求 `/check` 永不写；让 `/check` 带副作用会破坏只读契约与探针可测性 |
| D2 在线校验超时 | 安装成功但注册超时 → 返回 `pending`，**不 revoke** | 注册慢于超时并不代表凭据无效；此时 revoke 会再次把已装机器打离线，代价高于孤儿风险（安装在 `catch` 内失败才 revoke） |
| D3 进程识别 | pid 文件快速路径 + 命令行结构匹配（python + `-m src.runtime.agent`） | 线上安装脚本不写 pid 文件（已核对 `install-worker.sh`/`install.ps1`）；结构匹配避免日志/编辑器里出现该串被误报为运行中 |
| D4 设备名 | 已装一律 `RUNTIME_DEVICE_NAME` 原样；未装才用 `dsh-<host>` | 重推导必然产生新身份，与服务端 device→engine 归一冲突 |

## 测试缝（seam）

- `workerLayout` / `readLocalWorker` / `decideOnboard` / `shouldAutoStartWorker` / `formatTime` 全部为纯函数，依赖经参数注入（fs 读、进程枚举、时间）。
- 测试沿用 `node:test` 跑 `lib/` 产物（`npm test = build && node --test test/`），不引入第三方框架。
- 新增 `test/worker-identity.test.mjs`：四布局、env 解析、只读探测四源、状态机全分支、节流/code42/用户停止、`formatTime`。
- `test/local-runtime.test.mjs` 保持既有 28 例全绿（回归）。