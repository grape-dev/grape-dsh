# Issue #2 任务拆解（Task）

基线 `dev-ch`，开发分支 `feat/issue-2`。按里程碑交付，M1/M2 为 P0。每切片严格「红 → 绿」。

| # | 里程碑 | 切片 | 提交 | 验证信号 |
|---|---|---|---|---|
| 1 | 文档 | 需求 / 方案 / 任务 | `docs(#2)` | 三份文档落盘 |
| 2 | M1+M5 | 先写失败测试：四布局 `workerLayout`、`parseEnvText`、`readLocalWorker` 四源、`decideOnboard` 全分支、拉起节流/code42、`formatTime` | `test(#2)` | `node --test` 红（模块不存在/行为缺失） |
| 3 | M1+M5 | `src/local-runtime.ts` 新增布局/只读探测/进程枚举/拉起护栏；新增 `src/time-format.ts` | `feat(#2)` | 上述测试转绿；`npm run typecheck` 通过 |
| 4 | M1+M2 | `/check` 多源只读；`/onboard` 状态机 + credential 事务化；`/ensure-worker`；`worker-onboard.ts` 导出 `mint/list/listServerDevices/revokeCredential/decideOnboard/runOnboardTransaction`；`/revoke` 收敛到 `revokeCredential` | `feat(#2)` | 状态机测试绿；`installed` 路径零 `workerInstallCommand` 调用 |
| 5 | M3+M4 | 面板：`formatTime` + `read_error` 态 + 接入按钮护栏 + 自动刷新 + 本地事实卡片 | `feat(#2)` | `npm run typecheck`（client project）通过 |
| 6 | M5 | `package.json` 测试脚本覆盖 `test/`；R1~R10 静态自检 | `chore(#2)` | `npm test` 全绿；`git diff` 新增行无 `/dev/null`、`/tmp/`、字面 `/opt/`、`mkdir -p` |

## 验收对照

| 验收项 | 覆盖测试 / 检查 |
|---|---|
| 已接入机 `/check` found:true 且 deviceName 与本地一致 | `readLocalWorker` runtime-env 用例 + `decideOnboard` already-connected |
| 已装机点接入 0 新增 credential/设备、env 不变、worker 不重启 | `decideOnboard` 分支断言 action，且 index 路由在 `installed` 时不触达 `workerInstallCommand` |
| 已装未运行自动拉起 1 次；code 42 不拉起 | `shouldAutoStartWorker` 节流 / code42 屏蔽用例 |
| credential 失败自动 revoke 无孤儿 | `runOnboardTransaction` 失败路径（revoke 只按本次 id） |
| 面板时间 = 浏览器时间且自动刷新 | `formatTime` UTC 无 `Z` / 带 `Z` / 非法输入用例 + 面板 `setInterval` + `visibilitychange` |
| 四平台单测通过 | `workerLayout` win32 / linux-root / linux-user / darwin 用例 |