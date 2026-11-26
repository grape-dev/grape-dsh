# Plan: Issue #4 整改方案

## 改动点与实现策略

| 项 | 文件 | 方案 |
|---|---|---|
| P0-1 | `test/worker-identity.test.mjs` | POSIX 拉起用例加 `{ skip: process.platform === 'win32' }`；新增 Windows 用例，通过 `startLocalWorker` 第 4 个可选参数注入假 spawn，断言 `powershell.exe` + `-File <startScript>` 的 argv |
| P0-2 | `package.json` | `version` 0.4.2 → 0.4.3 |
| P1-3 | `src/worker-onboard.ts` | `mint` 移入 `try`；新增可选 `lookup(name)` 依赖，仅在签发失败**结果不确定**（AbortError/超时/网络）时按名称回查并 `revoke`，确定失败（HTTP 4xx）不回查，避免误撤同名他人凭据 |
| P1-4 | `src/local-runtime.ts`、`src/index.ts` | `startLocalWorker` 增加可选注入 spawn；`spawnDetached` 以 pid>0 判 `started`，无 pid 立即失败，异步 `error` 回写同一结果对象；`index.ts` 仅在 `started.started` 时 `recordAutoStart` |
| P1-5 | `src/worker-onboard.ts`、`src/index.ts` | `listCredentials` 非 2xx/网络错误抛错；`readServerState` 捕获后返回 `unknown:true`；`handleInstall` 显式处理失败（502）而不是当作“无凭据” |
| P1-6 | `src/index.ts` | `/check` 的服务端设备补全增加 30s TTL 缓存；onboard/revoke 成功后失效缓存；路由仍只读 |
| P1-7 | `docs/issue-2/spec.md` | 进程判据改为 python + `-m src.runtime.agent`；并发行为改为 409 `inFlight`、不复用首次结果 |
| P1-8 | `src/index.ts` | 重排 `const started = ...` 缩进 |

## 测试策略（TDD）

1. 先写失败用例（红）：Windows 拉起 argv、spawn 失败回写、mint 超时孤儿撤销、`listCredentials` 失败抛错、`readServerState` 失败 `unknown`。
2. 再实现最小改动使用例转绿。
3. 回归：`npm run typecheck`、`npm test`（Windows 记录 skip）、`npm pack` 版本核对。

## 安全 / 回归边界

- `installed=true` 分支不安装、不签发凭据的逻辑不变；
- `/check` 只做本地只读探测 + 30s TTL 的展示补全，不写服务端；
- 回查撤销仅限“本次 mint 结果未知”场景，且有名称唯一性约束。