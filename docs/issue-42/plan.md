# Issue #42 方案设计（Plan）

## 1. 架构决策

### 1.1 纯逻辑放 `src/*.ts`，DOM 接线放 `src/client/`

`tsconfig.json` 排除 `src/client`（`lib/client/*.js` 不产出），`tsconfig.client.json` 是 `noEmit`。
因此**可被 `node:test` 覆盖的判定**必须落在 `src/*.ts`（编译进 `lib/`），`src/client/issue-actions.ts`
只做 `fetch` / `window.open` 接线，判定一律 import 纯模块。这与 #40（`create-issue.ts` +
`create-issue-flow.ts`）同一条分界线，不新造第二套。

### 1.2 读路由走既有面板代理，写路由走既有 worker-api 前缀

- 读：`GET /grape-panel-api/task|scenes` —— 复用 `run()` 的缓存 / 在途去重 / 配置身份隔离；
- 写：`/grape-worker-api/issue-*` —— 复用 #40 的 `checkWorkerApiRequest` prefix 守卫（**零新增守卫代码**）。

### 1.3 数据流

```
卡片展开 / 点操作（懒加载，不进 20s 轮询）
  GET /grape-panel-api/task
      ├─ 宿主 HTTP GET /api/issues/mine?repo_key=<platform:owner/repo>&per_page=100
      │     （主：平台消歧；per_page 由 HTTP 端点承载，宿主 token 直连）
      ├─ 快路径不可用 → issues mine --repo_key <platform:owner/repo>（回退，**不带 --per_page**：
      │     该参数在部分 CLI 版本上 Usage 报错；默认 20 行，目标行不在其中时走 detail 兜底）
      ├─ 未命中 → issues detail（issue_id / scene_id + 首个 issue_opened seq）
      └─ task_description 空 → events detail --seq <first issue_opened>
            → payload.object_attributes.description
  GET /grape-panel-api/scenes[&scene_id=]
      ├─ 宿主快路径 GET /api/scenes/with-pipeline?repo=owner/repo
      └─ 失败降级：scenes detail 单条 + degraded
动作 → /grape-worker-api/issue-start|issue-confirm-done|issue-handoff-targets|issue-handoff
      → grapeApiCall → /api/issues/{内部 id}/...
```

## 2. 模块改动表

| 模块 | 类型 | 内容 |
|---|---|---|
| `src/task-view.ts` | 新增（纯） | `findMineIssue` / `projectTaskView` / `projectScenesView` / `projectHandoffTargets` |
| `src/issue-action-api.ts` | 新增（纯） | `parseIssueActionId` / `validateIssueHandoffInput` / `toIssueActionError` / `classifyHandoffResult` |
| `src/issue-actions.ts` | 新增（纯，无 DOM） | `isRunningStatus` / `needsPreflightStart` / `chatDeepLink` / `canConfirmDone` / `canHandoff` / `copyPrefill` / `handoffSkipText` |
| `src/panel-api.ts` | 修改 | `TASK_TTL_MS=45_000`、`TASK_MINE_PER_PAGE=100`；`/task`、`/scenes`（复用 `run()`） |
| `src/host-fetch.ts` | 修改 | `buildScenesWithPipelineUrl`、`hostFetchScenesWithPipeline`；`buildIssuesMineUrl`、`hostFetchIssuesMine`；适配器可选方法 |
| `src/create-issue.ts` | 修改 | `CreateIssueValue.scene_id?` + 白名单校验；payload 有则带、无则不出现 |
| `src/index.ts` | 修改 | 4 条写路由 + `create-issue` 透传 `scene_id` |
| `src/client/create-issue-flow.ts` | 修改 | `CreateIssueRequest.sceneId?` → payload `scene_id` |
| `src/client/CreateIssueForm.tsx` | 新增 | 共享表单 `mode='create'|'copy'` |
| `src/client/GrapeBrowsePanel.tsx` | 修改 | `CreateIssueBar` 改用共享表单（行为不变） |
| `src/client/issue-actions.ts` | 新增 | 打开侧栏聊天 / 调写路由 / 平台可读错误 |
| `src/client/GrapeFocusPanel.tsx` | 修改 | `EscapeHatch` 6 按钮 + 复制/移交弹层 + task 懒加载 + 在途禁用 + 成功刷新 |

## 3. 关键判定

### 3.1 「运行中」谓词

`status ∈ {active, processing, running}` 或 `is_running === true` → 运行中。
只有运行中才需要预检 `/start`（`needsPreflightStart`）；`409` 视为已启动，不阻断打开深链。

### 3.2 深链

```
${baseUrl}/app/${owner}/${repo}/#chat/issue:${issue_number}:${repo_key}
```

`repo_key = platform:owner/repo`（`repoKeyFor` 同源）。Gitee 字母数字编号原样进 `issue_number` 段。

### 3.3 终态 / 可用性

- `canConfirmDone / canHandoff`：`task.id > 0` **且** 状态非 `completed / cancelled / done`；
- 空 id（`issues mine` 与 `issues detail` 都拿不到）→ 两个按钮禁用 + 提示刷新；
- 每个写动作在途禁用（`busy` 单一字符串 state，天然单飞）。

### 3.4 错误映射

`toIssueActionError`：4xx 原状态透传（code 取平台 `code/error_code`，message 取
`message/error/msg`，透出 `request_id`）；5xx / 网络 → `502 upstream_unavailable`。
`toIssueActionError` 与 #40 的 `toCreateIssueError` 同口径，但**不复用同一函数**：两者的兜底文案
（`创建需求失败` vs `操作失败`）与默认 code 不同，硬合并会让 #40 的文案漂移。

### 3.5 handoff 结果分类

`classifyHandoffResult(data)`：

- `seq > 0` → `{ok:true, seq}`；
- `skipped` 为 `duplicate_handoff` / `target_scene_missing_node` → `{ok:false, skipped}`；
- 其他 → `{ok:false, skipped:'', message}`（原文 + code）。

## 4. 测试 seam（编码前声明）

| 切片 | seam | 测试文件 |
|---|---|---|
| P1 | `projectTaskView/findMineIssue/projectScenesView`；`buildScenesWithPipelineUrl`；`GET /task` `/scenes` handler | `test/task-view.test.mjs`、`test/host-fetch.test.mjs`、`test/panel-api.test.mjs` |
| P2 | `needsPreflightStart/chatDeepLink`；`parseIssueActionId/toIssueActionError`；守卫对新增路径 | `test/issue-actions.test.mjs`、`test/issue-action-api.test.mjs`、`test/worker-api-guard.test.mjs` |
| P3 | `copyPrefill`；`validateCreateIssueInput(scene_id)/buildCreateIssuePayload` | `test/issue-actions.test.mjs`、`test/create-issue.test.mjs` |
| P4 | `toIssueActionError` 409 / 5xx；`canConfirmDone` | `test/issue-action-api.test.mjs`、`test/issue-actions.test.mjs` |
| P5 | `projectHandoffTargets`、`classifyHandoffResult`、`handoffSkipText` | `test/task-view.test.mjs`、`test/issue-action-api.test.mjs`、`test/issue-actions.test.mjs` |

路由层（`src/index.ts`）不引入新的可测 seam：它的职责只是 `grapeApiCall` + 映射函数，
映射逻辑已全部下沉到纯模块；路由本身用同源守卫测试 + 手工验收覆盖（与 #40 一致）。

## 5. 实施顺序（TDD，先红后绿）

| 切片 | 红（先提交失败测试） | 绿（最小实现） |
|---|---|---|
| P1 | `task-view` / `host-fetch` / `panel-api` 新用例 | `src/task-view.ts`、`host-fetch.ts`、`panel-api.ts` |
| P2 | `issue-actions`（深链/预检）、`issue-action-api`（id/错误映射）、`worker-api-guard`（新路径） | `src/issue-actions.ts`、`src/issue-action-api.ts`、`src/index.ts` issue-start |
| P3 | `create-issue`（scene_id）、`issue-actions`（copy 预填）、`create-issue-flow` | `src/create-issue.ts`、`create-issue-flow.ts`、`CreateIssueForm.tsx` |
| P4 | `issue-action-api`（confirm-done 409/5xx）、`issue-actions`（canConfirmDone） | `src/index.ts` issue-confirm-done、面板按钮 |
| P5 | `task-view`（targets 投影）、`issue-action-api`（handoff/skipped）、`issue-actions`（skipped 文案） | `src/index.ts` handoff*、面板移交弹层 |

客户端 UI（`GrapeFocusPanel` / `CreateIssueForm`）无 `node:test` 基建，按 #40 先例走手工验收清单（见 task.md）。

## 6. 收尾验证

```bash
npm run typecheck && npm test && npm run build
git grep -n "handoff-targets\|confirm-done\|issue-start" src/
```

`npm test` 基线 = **396 个用例全绿**，收尾不得低于该数。