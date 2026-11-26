# Issue #42 任务拆解与验收对照（Task）

## 1. 任务清单

### P1 task / scenes 读路由

- [x] T1-1 `test/task-view.test.mjs`：`findMineIssue`（repo_key / 编号命中与不命中）、
      `projectTaskView` 字段齐全、GitCode 整数 / Gitee `IKXR3B`、id 非法归 0、描述三级回退
- [x] T1-2 `test/task-view.test.mjs`：`projectScenesView` 只透出白名单字段 + `degraded` 标记
- [x] T1-3 `test/host-fetch.test.mjs`：`buildScenesWithPipelineUrl` 含 `repo=owner/repo`；
      快路径 Bearer + 结构校验失败 → `HostFetchError(schema)`
- [x] T1-4 `test/panel-api.test.mjs`：`/task` 透传、非法 number 400、45s 缓存、force；
      mine 行走宿主 HTTP 快路径（`repo_key` + `per_page=100`，命中后不 spawn CLI）、
      快路径失败回退 `issues mine`（断言参数里**没有** `--per_page`）；
      `/scenes` 快路径成功 / 403 降级单条 + `degraded`
- [x] T1-5 `src/task-view.ts`、`src/host-fetch.ts`（`buildIssuesMineUrl` / `hostFetchIssuesMine`）、
      `src/panel-api.ts`（`TASK_MINE_PER_PAGE`）

### P2 进入对话

- [x] T2-1 `test/issue-actions.test.mjs`：`chatDeepLink`（GitCode / Gitee）、
      `needsPreflightStart`（active/processing/running/is_running/终态）、`isRunningStatus`
- [x] T2-2 `test/issue-action-api.test.mjs`：`parseIssueActionId`（`id` / `issue_id` / 非法）、
      `toIssueActionError`（4xx 透传 / 5xx→502 / request_id）
- [x] T2-3 `test/worker-api-guard.test.mjs`：新写路径同源放行 / 跨站 403
- [x] T2-4 `src/issue-actions.ts`、`src/issue-action-api.ts`、`src/index.ts` `issue-start`
- [x] T2-5 `src/client/issue-actions.ts` + `GrapeFocusPanel` 按钮

### P3 复制需求 + scene_id

- [x] T3-1 `test/create-issue.test.mjs`：`scene_id` 合法透传 / 缺省 payload 不变 / 非法 400
- [x] T3-2 `test/issue-actions.test.mjs`：`copyPrefill` 标题 +「（副本）」、描述 + Issue 链接、
      空描述只留链接、标题超 200 截断
- [x] T3-3 `src/create-issue.ts`、`src/client/create-issue-flow.ts`、`src/client/CreateIssueForm.tsx`、
      `GrapeBrowsePanel.tsx`、`GrapeFocusPanel.tsx`

### P4 确认完成

- [x] T4-1 `test/issue-actions.test.mjs`：`canConfirmDone`（终态禁点 / id 缺失禁点）
- [x] T4-2 `test/issue-action-api.test.mjs`：confirm-done 的 409 / 5xx 映射
- [x] T4-3 `src/index.ts` `issue-confirm-done`、面板二次确认

### P5 移交流水线

- [x] T5-1 `test/task-view.test.mjs`：`projectHandoffTargets`（数组 / `{scenes|targets}`、
      顶层 `current_scene_id` 回填 `is_current`（真实响应形状：`targets[]` 无 `is_current`）、
      item `is_current` 兼容、嵌套 `{data:{...}}`、非法项丢弃）
- [x] T5-2 `test/issue-action-api.test.mjs`：`classifyHandoffResult`（`seq>0` / 两类 skipped / 原文）
- [x] T5-3 `test/issue-actions.test.mjs`：`canHandoff`、`handoffSkipText`
- [x] T5-4 `src/index.ts` `issue-handoff-targets` / `issue-handoff`、面板移交弹层

## 2. 验收条款 → 代码位置 → 测试名

| # | 验收条款 | 代码位置 | 测试名 |
|---|---|---|---|
| 1 | 6 按钮平铺换行；终态「确认完成/移交」置灰 | `src/client/GrapeFocusPanel.tsx` `EscapeHatch`；`src/issue-actions.ts` `canConfirmDone/canHandoff` | `test/issue-actions.test.mjs`「终态与缺 id 时确认完成/移交不可用（终态 = completed / cancelled / closed / stage=done）」 |
| 2 | `active` 先 `/start`、深链 `#chat/issue:<number>:<repo_key>`、Gitee 不串、未登录提示 | `src/issue-actions.ts` `chatDeepLink/needsPreflightStart`；`src/index.ts` issue-start；`src/client/issue-actions.ts` | `test/issue-actions.test.mjs`「深链形态：#chat/issue:<number>:<repo_key>，base 尾斜杠归一」「预检 /start：只有运行中且拿得到内部 id 才调」；`test/issue-action-api.test.mjs`「parseIssueActionId：issue number / 0 / 负数 / 元字符 → invalid_id」 |
| 3 | 复制预填标题 +「（副本）」、描述 + Issue 链接、场景默认源场景且可编辑；创建后 pin + 切实时 | `src/issue-actions.ts` `copyPrefill`；`src/client/CreateIssueForm.tsx`；`create-issue-flow.ts` `sceneId` | `test/issue-actions.test.mjs`「copy 预填：标题 +「（副本）」、描述 + 空行 + Issue 链接」；`test/create-issue.test.mjs`「payload：scene_id 有则进 payload，无则不出现（缺省与 #40 完全一致）」 |
| 4 | 场景下拉列全仓库场景；创建失败展示平台可读原因 | `src/panel-api.ts` `/scenes`；`src/task-view.ts` `projectScenesView`；`src/host-fetch.ts` scenesWithPipeline | `test/task-view.test.mjs`「projectScenesView：只透出 id / display_name / work_branch / pipeline.nodes 白名单字段」；`test/panel-api.test.mjs`「/scenes：宿主快路径命中…」「/scenes：快路径 403 → 降级为当前场景单条 + degraded 标记」；`test/host-fetch.test.mjs`「scenes URL 含 repo=owner/repo（URL 编码…）」 |
| 5 | 确认完成二次确认 + 成功刷新 + 不重复提交 | `src/index.ts` issue-confirm-done；`src/issue-action-api.ts`；`GrapeFocusPanel` busy 单飞 | `test/issue-action-api.test.mjs`「错误映射：4xx 原状态透传（403 / 404 / 409）」「issue-start 的 409 视为已启动」 |
| 6 | 移交用内部 id、当前场景标记、成功刷新、两类 skipped 文案、空目标禁用 | `src/index.ts` handoff-targets/handoff；`src/task-view.ts` `projectHandoffTargets`（顶层 `current_scene_id` → `is_current`）；`src/client/GrapeFocusPanel.tsx`「当前」Tag + 当前项 disabled；`src/issue-action-api.ts` `classifyHandoffResult`；`src/issue-actions.ts` `handoffSkipText` | `test/task-view.test.mjs`「projectHandoffTargets：兼容数组 / scenes / targets 信封…」「projectHandoffTargets：顶层 current_scene_id 回填 is_current（真实响应形状：targets 无 is_current）」；`test/issue-action-api.test.mjs`「classifyHandoffResult：duplicate_handoff / target_scene_missing_node 两类 skipped」「validateHandoffInput：id + target_scene_id 白名单」；`test/issue-actions.test.mjs`「skipped 文案：两类 skip 各自可读，未知错误不吞」 |
| 7 | `task` 字段齐全（含 `conversation_id` / `is_running`），GitCode 数字编号与 Gitee 字母数字编号正确 | `src/panel-api.ts` `/task`（mine 走 HTTP `per_page=100`，CLI 回退无 `--per_page`）；`src/host-fetch.ts` `hostFetchIssuesMine`；`src/task-view.ts` `projectTaskView` | `test/panel-api.test.mjs`「/task：返回 id / issue_number / …」「/task：mine 行走宿主 HTTP 快路径（repo_key + per_page=100），命中后不再 spawn mine CLI」「/task：mine HTTP 快路径失败（403/结构不符）→ 回退 issues mine CLI（无 --per_page）」「/task：非法 number → 400，且不发起 CLI」；`test/host-fetch.test.mjs`「mine URL：repo_key + per_page=100（per_page 只在提供时入参）」「mine 快路径：Bearer 鉴权 + per_page=100 + 原样透传 issues 行（含 conversation_id / is_running）」；`test/task-view.test.mjs`「字段齐全…」「GitCode 整数编号归一为字符串，Gitee 字母数字编号原样保留」「描述三级回退…」 |
| 8 | 新写路由跨站 `Origin` 403、同源放行 | `src/index.ts` prefix 守卫；`src/worker-api-guard.ts` 不变 | `test/worker-api-guard.test.mjs`「Issue #42 新增写路径：同源 Origin → 放行」「…跨站 Origin / Sec-Fetch-Site=cross-site → 403」 |
| 9 | `typecheck`/`test`/`build` 全绿；`npm test` 总数不下降；文档含对照表 | `docs/issue-42/{spec,plan,task}.md` | `npm run typecheck && npm test && npm run build` |

## 3. 手工验收清单

- **M1 按钮布局**：打开实时面板 → 展开任一需求卡 → 底部动作区 6 个按钮平铺；
  缩窄侧栏到 320px → 自动换成 2–3 行，不出现水平滚动条。
- **M2 终态置灰**：观察一条 `completed` 需求（如 #41）→「确认完成」「移交」不可点；
  有 tooltip/提示说明已终态；`task.id` 缺失时同样不可点并提示刷新。
- **M3 进入对话**：观察 `processing` 的需求（#42）→ 点「进入对话」→ 侧栏浏览器打开
  `<base>/app/grape-dev/grape-dsh/#chat/issue:42:gitcode:grape-dev/grape-dsh`；
  预检 `/start` 失败时仍然打开（只看不报错）。未登录时提示「请先登录 Grape Web」。
- **M4 复制需求**：点「复制需求」→ 表单仓库只读、标题为原标题 +「（副本）」、
  描述含原文 + `Issue 链接: ...`、场景下拉默认源场景且可切换、指派可选；
  点「创建并执行」→ 新需求出现在列表并加入观察、面板切到实时。
- **M5 场景降级**：用 user_only token 不可用的环境 → 场景下拉只有当前场景一项，
  且带「仅当前场景」提示（`degraded`），不报错。
- **M6 确认完成**：`processing` 需求点「确认完成」→ 二次确认弹层 → 确认后卡片状态变已完成、
  pin 刷新；连点只发一次请求。
- **M7 移交**：点「移交」→ 弹层列出同仓库其他流水线、当前场景打「当前」标记；
  空目标时「移交」按钮禁用；成功后卡片刷新；重复移交给出「已移交」提示。
- **M8 跨站守卫**：`curl -X POST -H "Origin: https://evil.example" -H "Content-Type: application/json"
  --data '{"id":20864}' http://<dsh-host>/grape-worker-api/issue-start` → `403 cross_origin`；
  面板内点击正常。

## 4. 自检命令

```bash
npm run typecheck
npm test                      # 复审前基线 437；本次 443（新增 6 条：mine HTTP URL/取数/失败 + /task HTTP 命中 + /task CLI 回退 + handoff current_scene_id），收尾不得低于
npm run build
git grep -n "handoff-targets\|confirm-done\|issue-start" src/
```