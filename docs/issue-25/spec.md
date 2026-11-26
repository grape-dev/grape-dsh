# Issue #25 Spec：本机 Worker 接入状态不可信

> 分支：`feat/issue-25`（基线 `dev-ch-11 @ f535462`，含 `main 77dcfd0 / 0.5.1`）
> 来源：Issue #25 正文 + issue agent Spec（评论 id=202080643）

## 目标

面板「本机 Worker」状态必须与服务端 `GET /api/settings/runtime-devices` 的
`health / last_seen_at` 一致或能解释差异；**探测失败不得显示「未运行」，也不得触发自动拉起**。

## 现状（事故链）

1. `/grape-worker-api/check` → `readLocalWorker()` 把进程探测折叠成布尔 `running`；
   PowerShell `Get-CimInstance` 8s 超时 / 工具不可用 → 空数组 → `running=false`。
2. 面板只看 `processAlive`：false → 「未运行（将自动尝试拉起）」→ `POST /ensure-worker`。
3. 同设备因此出现第二份 worker 进程：PID 8264（`<home>/grape/.venv`）与 PID 7012
   （系统 `Python312`），同设备凭据争用、心跳抖动，主控侧更不稳定。
4. `/check` 已回 `bin/binSource/probeError/readError`，但缺少「为何判未运行」的探测元数据，
   也未把服务端 `health/last_seen_at/worker_version` 落到面板。

## 需求（Issue 7 项）

1. 根因结论：PowerShell 探测超时被当成无进程 → 误判未运行 → 重复拉起（本 PR 给出证据链）。
2. 状态模型细化：取消单一布尔，至少 9 态，每态一句建议。
3. 判定优先级：服务端 `last_seen_at` 在 2×heartbeat 窗口内时服务端优先；
   探测失败显示「探测不可用 / 服务端在线」且不拉起。
4. 拉起护栏与拉起后校验：任一存活 agent 进程（含子进程、非 venv 解释器）拒拉；
   拉起后核对 `runtime.env` 的 device_name/token/服务地址，回写 pid/退出码/stderr 摘要。
5. 面板可诊断：「判定依据」折叠区 + 脱敏「复制诊断信息」。
6. 单测 6 类容错（探测不可用/超时、双进程、凭据非 active、服务端 online 本地探测失败、
   节流窗口重复触发、拉起失败回写），`npm test` 只加不减。
7. 文档：状态机图 + 故障树、中英 README、patch bump、RELEASE-RECORD。

## 范围外

- 服务端 `/api/settings/runtime-devices`、`/grape-worker-api` 之外平台契约；
- 33 个 `grape_*` 工具对外契约；
- Worker 抢单 / 心跳协议本身。

## 验收

- [x] 面板状态与服务端 `health/last_seen_at` 一致或可解释；
- [x] 探测失败显示「探测不可用 / 服务端在线」，且 0 次自动拉起；
- [x] 不打印 token，诊断可复制且脱敏（`RUNTIME_TOKEN` / `tk_` / `grape_` / `tko_` / `rta_`）；
- [x] `npm run typecheck` 通过；`npm test` 185 tests（基线 176，只加不减）/ 1 skipped；
- [x] patch 版本 bump 并更新 `docs/RELEASE-RECORD.md`。