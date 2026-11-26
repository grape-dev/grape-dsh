# Spec: Issue #4 — #2 合入收尾（Windows 测试守卫 / 0.4.3 / Minor 收口）

> 基线：`dev-ch @ 9520db9`；开发分支：`feat/issue-4`；禁止 force push、禁止直接向 `main` 提交。

## Objective

收口 PR #2 合入后的整改，使 `dev-ch` 在 Windows / Linux 双平台均可交付：

- Windows 本地 `npm test` 从 1 fail 恢复为 0 fail；
- 版本号从 0.4.2 提升到 0.4.3，使合入前后产物可区分；
- 收口 QA 复审遗留的 6 条 Minor（mint 孤儿凭据、spawn 结果回写、凭据列表失败语义、`/check` 轮询、文档判据、缩进）。

## In Scope

1. **P0-1 测试守卫**：`test/worker-identity.test.mjs` 的 POSIX 拉起用例加 `win32` skip；新增 Windows 成功拉起用例（`startLocalWorker(layout,'win32')` → `powershell -File <startScript>`），断言 argv，spawn 可注入（不真起进程）。
2. **P0-2 版本 bump**：`package.json` 0.4.2 → 0.4.3。
3. **P1-3 孤儿凭据**：`runOnboardTransaction` 的 `mint` 移入 `try`；签发结果未知（超时/中断）时按名称回查并撤销本次孤儿凭据。
4. **P1-4 拉起结果真实回写**：`spawnDetached` 按 pid/error 真实回写 `started`/`error`；`src/index.ts` 的 `recordAutoStart` 仅真正拉起时记账。
5. **P1-5 凭据列表失败语义**：`listCredentials` 失败不得返回 `[]`，改为抛错；`readServerState` 因此落到 `unknown:true`。
6. **P1-6 `/check` 只读收敛**：服务端 `runtime-devices` 补全加 30s TTL 缓存，`/check` 仍严格只读。
7. **P1-7 文档对齐**：`docs/issue-2/spec.md` 进程判据对齐 `isWorkerCommand`（python + `-m src.runtime.agent`）；并发摘要修正为“在途 409 `inFlight`，不复用首次结果”。
8. **P1-8 缩进重排**：`src/index.ts` 中 `const started = ...` 回归 IIFE 体缩进。

## Out of Scope

- `/onboard` 强制插件 API Key 设计；
- `/grape-worker-api` 内联路由 Origin/CSRF 校验；
- `src/panel-api.ts` 重构；
- `main` 分支。

## Acceptance Criteria

- [ ] Windows 与 Linux `npm run typecheck` 均通过；
- [ ] Windows `npm test` 0 fail（skip 数量与原因写清）；Linux 全绿；
- [ ] `npm pack` 产物 tgz 的 `version` = 0.4.3；
- [ ] P1-3 ~ P1-5 各有用例覆盖（mint 超时/孤儿、spawn 失败、`listCredentials` 错误路径）；
- [ ] 无行为回归：`installed=true` 仍不安装、不签凭据；`/check` 仍严格只读；
- [ ] `lib/*.js` 与 `src` 同步（`npm run build` 产物一致）。