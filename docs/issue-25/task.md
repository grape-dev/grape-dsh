# Issue #25 任务拆解

- [x] T1 `readLocalWorker` 保留探测方式/命令/超时/退出码/stderr 前 20 行，不再折叠布尔；
      新增 `heartbeatIntervalSec`、`processes`、`probeFailed`。
- [x] T2 新增纯函数 `classifyWorkerState`（12 态 + basis + advice + canAutoStart）与
      `WORKER_STATE_ADVICE`；服务端 2×heartbeat 窗口优先，探测失败不判未运行。
- [x] T3 新增 `evaluateStartGuard`：任一存活 agent 进程 / 探测失败 → 拒拉。
- [x] T4 `/check` 并行取服务端设备行（含 worker_version）、runtime.env、进程探测与凭据，
      合成状态并回传 `workerState/probe/processes/lastStart/autoStartThrottled`（脱敏）。
- [x] T5 `/ensure-worker` 与 `/onboard(start)` 使用 `canAutoStart` + `evaluateStartGuard`；
      拉起后 `buildWorkerStartRecord` 核对 runtime.env 并回写 pid/退出码/stderr 摘要。
- [x] T6 面板：状态 + 建议、折叠「判定依据」、脱敏「复制诊断信息」；自动拉起改用 `canAutoStart`。
- [x] T7 `redactSensitiveText` 增加 `tko_` 前缀。
- [x] T8 单测 9 个（探测不可用/超时、双进程、凭据非 active、服务端 online + 本地探测失败、
      节流重复触发、拉起失败回写、9+ 态齐全、身份不一致、脱敏）；`npm test` 185 / 1 skipped。
- [x] T9 文档：状态机图 + 故障树、中英 README、RELEASE-RECORD、patch bump 0.5.1 → 0.5.2。
- [x] T10 `npm run typecheck` + `npm test` 全绿；自审查 + 敏感增量扫描后建 PR。