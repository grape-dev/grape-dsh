# Issue #42 需求文档（Spec）

> 目标分支：`dev-ch-11`（基线 `82aa04b`，0.5.4，含 #40 / #41）｜评级：**ready**｜里程碑：`v0.5.5`
> 权威需求来源：Issue #42 正文 + Spec 评论（id `203700678`）。本文档与其一致，只补实现落点。

## 1. 目标

在 `GrapeFocusPanel` 需求卡底部动作区一次性完成 4 个高频动作：

1. **进入对话** —— 打开 Grape Web 聊天深链（不是本地 DSH 会话）；
2. **复制需求** —— 预填表单一键复制成本仓库新需求（可换场景）；
3. **确认完成** —— 二次确认后确认需求完成；
4. **移交流水线** —— 把需求移交给同仓库另一条流水线（场景）。

写操作全部复用 #40 已落地的 `/grape-worker-api/*` 同源 / CSRF 守卫，**不新增跨站面**。

## 2. 现状（`dev-ch-11@82aa04b` 实证）

| 事实 | 位置 |
|---|---|
| 卡片动作区只有「在官网打开」「在侧栏浏览器打开」 | `src/client/GrapeFocusPanel.tsx` `EscapeHatch` |
| 面板代理已有 `/repos /issues /pipeline /dashboard /focus /events /health`，无 `task / scenes` | `src/panel-api.ts` `createPanelApiHandler` |
| 建单能力 `{repo_key,title,description,assignee}`，无 `scene_id` | `src/create-issue.ts` `buildCreateIssuePayload` |
| 建单流程 + 首节点等待已封装 | `src/client/create-issue-flow.ts` |
| 建单表单内联在浏览页 | `src/client/GrapeBrowsePanel.tsx` `CreateIssueBar` |
| 同源守卫在 prefix 入口统一判定 | `src/index.ts` `checkWorkerApiRequest` + `src/worker-api-guard.ts` |
| `issues mine` 返回 `id/repo_key/issue_number/status/scene_id/task_description/conversation_id/is_running/stage` | 实测（#42：`id=20864`、`scene_id=custom-5f5c87a1`、`task_description=""`；`conversation_id=41fb4d5e-…`、`is_running=true`） |
| `GET /api/issues/mine?repo_key=…&per_page=100` 与 `issues mine` 同源同形（`{issues:[…]}`）；CLI 的 `--per_page` 在部分版本上 Usage 报错 | 实测（CLI 0.3.4 支持，旧版不支持 → `/task` 改走 HTTP 承载分页，CLI 回退不带该参数） |
| `issues detail` 返回 `issue_id` + `events[]`（含首个 `issue_opened` 的 seq） | 实测 #42 |
| `events detail --seq` 的 `payload.object_attributes.description` 是需求原文 | 实测 seq `108746` |
| `POST /api/issues/{id}/start`、`/confirm-done`、`GET /handoff/targets`、`POST /handoff` 均存在（**内部 id**） | `docs/grape-cli-command-inventory.md` + `docs/IMPROVEMENTS.md` |
| `GET /api/issues/{id}/handoff/targets` 顶层 `current_scene_id` 标记当前场景；`targets[]` 项只有 `id/name/display_name/description/work_branch/scene_type`，**无 `is_current`** | 实测 20864（4 个 target，当前场景 `custom-5f5c87a1`） |
| 移交用 issue number 实测 404 | 实测口径（Spec §9） |

## 3. 范围

### In Scope

- `src/panel-api.ts` 新增只读 `GET /task`、`GET /scenes`。
- `src/index.ts` 新增 4 条写路由（`issue-start` / `issue-confirm-done` / `issue-handoff-targets` / `issue-handoff`），并给 `create-issue` 透传可选 `scene_id`。
- `src/task-view.ts` / `src/issue-action-api.ts` / `src/issue-actions.ts`：纯逻辑（编译进 `lib/`，`node:test` 可直测）。
- `src/host-fetch.ts`：`/api/scenes/with-pipeline` 宿主快路径。
- `src/client/CreateIssueForm.tsx`：浏览页与「复制需求」共用的建单表单。
- `src/client/issue-actions.ts`：DOM/React 接线（判定一律引用纯模块）。
- `GrapeFocusPanel` 动作区 6 按钮（2 旧 + 4 新）平铺换行、终态置灰、在途禁用。

### Out of Scope

- 管理员确认完成、取消需求；
- 不改平台仓库、不新增平台依赖；
- 不重开 #40、不删除/弱化现有测试。

## 4. 接口契约

### 4.1 `GET /grape-panel-api/task?owner=&repo=&number=[&platform=]`

`data`：`id`(内部数字 id，取不到为 0)、`issue_number`（`normalizeIssueNumber` 归一，GitCode `42` / Gitee `IKXR3B`）、`repo_key`、`status`、`scene_id`、`task_description`、`conversation_id`，可选 `title` / `stage` / `is_running`。

- `number` 非法 → 400 `invalid-param`；
- 懒加载（卡片展开/点操作才取），缓存 **45s**，支持 `force=1`；
- mine 行：宿主快路径 `GET /api/issues/mine?repo_key=…&per_page=100`（主）→ 失败回退 `issues mine --repo_key …`（**不带 `--per_page`**）；回退路径默认 20 行，目标行不在其中时 `conversation_id` / `is_running` 缺失（`id/status/scene_id` 仍由 `issues detail` 补齐）；
- `task_description` 三级回退：`issues mine.task_description` → 首个 `issue_opened` 事件 `payload.object_attributes.description` → `''`。

### 4.2 `GET /grape-panel-api/scenes?owner=&repo=[&scene_id=]`

`data = [{ id, display_name, work_branch, pipeline:{nodes:[{tag,next,handoff,enabled}]}, degraded? }]`；只透出上述字段。

- 宿主快路径：`GET /api/scenes/with-pipeline?repo=owner/repo`（配置 token；user_only）；
- 快路径不可用（403 / 无 token / 结构不符）→ 降级为「当前场景单条」（`scenes detail --scene_id`，WORKER 可用）+ `degraded: true`；
- 缓存 `SCENE_TTL_MS`。

### 4.3 写路由（全部落在既有 `/grape-worker-api/*` 同源守卫内）

| 路由 | 下游 | 入参 |
|---|---|---|
| `POST /grape-worker-api/issue-start` | `POST /api/issues/{id}/start` | `{ id }` 或 `{ issue_id }`（**内部数字 id**） |
| `POST /grape-worker-api/issue-confirm-done` | `POST /api/issues/{id}/confirm-done` | `{ id, confirmation }`（缺失补 `user_confirmed`） |
| `GET /grape-worker-api/issue-handoff-targets?id=` | `GET /api/issues/{id}/handoff/targets` | query `id`（**内部 id，禁止用 number**）；投影用顶层 `current_scene_id` 回填 `is_current`（`target.id === current_scene_id`），兼容 item 上的 `is_current: true` |
| `POST /grape-worker-api/issue-handoff` | `POST /api/issues/{id}/handoff` | `{ id, target_scene_id }` |

### 4.4 `create-issue` 扩展

`POST /grape-worker-api/create-issue` 新增可选 `scene_id`（`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`）；**不传时 payload 与 #40 完全一致**。

### 4.5 错误语义

- 4xx 原状态透传（403 / 404 / 409），带平台 `message` 与 `request_id`；
- 5xx / 网络异常 → `502` + `upstream_unavailable` + 可读文案；
- `issue-start` 的 `409` 视为「已启动」，回 `200 {ok:true, already_started:true}`（继续打开深链）；
- `issue-handoff`：`seq>0` 成功；`skipped=duplicate_handoff` / `skipped=target_scene_missing_node` 分别给可读提示；
- 进入对话：预检 `/start` 失败**继续打开**深链；未登录只提示「请先登录」。

## 5. 交互要求

- 6 个按钮**平铺 + `flex-wrap: wrap`**，不固定列数；
- 终态（已完成 / 已取消）时「确认完成 / 移交」置灰；`task.id` 缺失时同样禁用并提示刷新；
- 每个写动作在途禁用（单飞），成功后刷新 pin（`refreshPin`）；
- 复制需求成功：`addPin` + `setMode('live')` + 提示；
- 复制预填：标题 `原标题（副本）`、描述 `源描述 + 空行 + Issue 链接: <web url>`（必填、可编辑）、场景默认源场景且可切换。

## 6. 验收（9 条）

1. 6 按钮平铺换行；终态「确认完成/移交」置灰；
2. `active` 先 `/start`、深链 `#chat/issue:<number>:<repo_key>`、Gitee 不串、未登录提示；
3. 复制预填标题 +「（副本）」、描述 + Issue 链接、场景默认源场景且可编辑；创建后 pin + 切实时；
4. 场景下拉列全仓库场景；创建失败展示平台可读原因；
5. 确认完成二次确认 + 成功刷新 + 不重复提交；
6. 移交用内部 id、当前场景标记、成功刷新、两类 skipped 文案、空目标禁用；
7. `task` 字段齐全，GitCode 数字编号与 Gitee 字母数字编号正确；
8. 新写路由跨站 `Origin` 403、同源放行；
9. `typecheck` / `test` / `build` 全绿，`npm test` 总数不下降，文档含对照表。

## 7. 风险与实测口径

| 风险 | 口径 |
|---|---|
| `status` 实测为 `processing` 而非 `active` | 「运行中」谓词覆盖 `active` / `processing` / `running` / `is_running`；仅运行中才预检 `/start`，`409` 视为已启动 |
| `repo_key` 含 `:`，与深链分隔符叠加 | 约定字符串 `#chat/issue:42:gitcode:grape-dev/grape-dsh`，用例先断言该字符串 |
| `/api/scenes/with-pipeline` 为 user_only | 宿主快路径为主；403 降级为当前场景单条 + `degraded` |
| 移交用 issue number 实测 404 | 强制内部数字 `id`；`task.id` 缺失时禁用并提示刷新，不用 number 兜底 |
| `task_description` 为空（#42 实测） | 三级回退（见 4.1） |
| `src/client` 不产出 `lib/` | 纯逻辑一律放 `src/*.ts`；`src/client/issue-actions.ts` 只接线 |
| 平台串库 | `platform` 随 `repo_key` 与深链 `repo_key` 走 |