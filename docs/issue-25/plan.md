# Issue #25 方案设计

## 架构

把「本地进程探测布尔值」升级为「本地事实 + 服务端心跳 + 探测元数据 + 凭据状态 + 拉起护栏」
五输入的纯函数状态推导，面板与拉起路由共用同一结论。

```
readLocalWorker()
  ├─ runtime.env 事实（device_name / server_url / token 是否存在 / heartbeat 秒）
  ├─ processes: WorkerProcess[]        ← 命中进程（多进程并存全部保留）
  ├─ probe: { method, command, timeoutMs, ok, status, error, stderrLines(≤20), matched }
  └─ probeFailed = !probe.ok && method ∉ {pid-file, none}
          │
          ▼
classifyWorkerState({ local, server, probe, cred, throttle, expected })
          │
          ├─ { state: 12 态, basis: string[], advice: string, canAutoStart: boolean }
          ▼
/grape-worker-api/check ──► GrapeMachinePanel（状态 + 建议 + 判定依据 + 脱敏复制）
/grape-worker-api/ensure-worker ──► canAutoStart 才允许 shouldAutoStartWorker()
/grape-worker-api/onboard(start) ──► evaluateStartGuard() + recordWorkerStart()
```

## 状态与优先级

| 优先级 | 状态 | 条件 | canAutoStart |
|---|---|---|---|
| 1 | `read-error` | `local.readError` 非空 | false |
| 2 | `identity-mismatch` | 进程在跑且 device_name / server_url 与期望不一致 | false |
| 3 | `server-online-probe-failed` | 服务端 online 且在 2×hb 窗口内 + 探测失败 | false |
| 4 | `server-online-no-local-process` | 服务端 online + 探测成功但无进程 | false |
| 5 | `online` | 服务端 online + 本地进程在跑 | false |
| 6 | `credential-inactive` | 凭据状态 ≠ active | false |
| 7 | `not-installed` | 未安装 | false |
| 8 | `started-waiting-heartbeat` | 进程在跑但服务端不在窗口内 | false |
| 9 | `probe-failed` | 探测失败且服务端不在线 | false |
| 10 | `autostart-blocked` | 42 / 用户停止 | false |
| 11 | `autostart-throttled` | 5 分钟内已拉起 | false |
| 12 | `installed-stopped` | 已装未运行、探测成功、无存活进程 | **true** |

服务端时间解析：无时区后缀按 UTC（与服务端一致），窗口 = `2 × RUNTIME_HEARTBEAT_INTERVAL`（缺省 15s → 30s）。

## 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 状态来源 | 枚举 + basis + advice | 单布尔无法解释差异 |
| 冲突优先级 | 2×heartbeat 窗口内服务端优先 | 服务端 `last_seen_at` 是唯一可信在线证据 |
| 拉起策略 | `canAutoStart` 才拉；护栏再校验存活进程/探测失败 | 重复拉起正是事故形态 |
| 拉起后核对 | 重读 runtime.env，与期望设备名/服务地址/服务端行对账，差异写入记录 | 不阻断进程，但可诊断 |
| 脱敏 | 复用 `redactSensitiveText` + 扩展 `tko_` | 避免两套脱敏不一致 |

## 改动文件

- `src/local-runtime.ts`：`WorkerProbeFacts` / `collectWorkerProcesses` / `classifyWorkerState` /
  `evaluateStartGuard` / `autoStartStatus` / `buildWorkerStartRecord`；`readLocalWorker` 保留探测元数据。
- `src/worker-onboard.ts`：`ServerDevice` 增加 `worker_version`。
- `src/index.ts`：`/check` 合成状态并回传判定依据；`/ensure-worker`、`/onboard(start)` 护栏与拉起后核对回写。
- `src/client/GrapeMachinePanel.tsx`：状态 + 建议、折叠「判定依据」、「复制诊断信息」。
- `src/repo-diagnostics.ts`：脱敏前缀补 `tko_`。
- `test/local-runtime.test.mjs`：新增 9 个用例（6 类容错 + 状态齐全/身份不一致/脱敏）。
- 文档与版本：`docs/local-worker-and-takeover-stop.md`、中英 README、`docs/RELEASE-RECORD.md`、`package.json`。

## 测试 seam

纯函数 seam（最高、无 IO）：`readLocalWorker`（注入 fs/process probe）、`classifyWorkerState`、
`evaluateStartGuard`、`shouldAutoStartWorker`、`buildWorkerStartRecord`、`redactSensitiveText`。