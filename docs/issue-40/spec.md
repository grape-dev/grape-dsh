# Issue #40 需求规格（Spec）

> 基线：`dev-ch-11`（含 #39）｜ 顺序：P0 同源守卫 → P1 创建需求 → P2 创建并接管 ｜ P1 完成即可独立验收

## 1. 目标

「浏览」页**进入某个仓库后**（issue 列表 / 流水线详情）提供两个入口：

- **创建需求**：填标题 / 描述 / 指派 → 建 issue 并触发流水线，成功后自动加入观察并切到「实时」；
- **创建需求并接管**：建单后等首个运行节点出现（60s 内），把该**实际运行节点**拉到本机 DSH 会话。

仓库根列表不显示按钮；表单里的仓库只读（取当前浏览栈 `currentRepo()`），不做仓库选择器。
仓库根列表无按钮 —— 面板只在 `view.kind !== 'repos'` 时渲染按钮区。

## 2. 现状（`dev-ch-11` 实证）

| 事实 | 位置 |
|---|---|
| `/grape-worker-api/*` 单一 prefix handler | `src/index.ts:1257-1263` 注册 |
| 16 条 POST 路由，**无任何** `Origin` / `Sec-Fetch-Site` 校验 | `src/index.ts:1433-2299`（`grep -c` = 0） |
| 无 `create-issue` 路由 | 同上 |
| `repoKey` 默认写死 `gitcode`（两处） | `src/index.ts:2112`（takeover-list）、`:2313`（takeover） |
| 建单编号字段已有兼容先例 | `src/tools/issues.ts` `grape_create_issue`：`issue_number ?? number ?? issue_id` |
| 编号归一口径 | `src/issue-number.ts:36` `normalizeIssueNumber` |
| 面板取数 / 观察 / 模式 | `browse-store.ts:148` `panelGet`；`pins-store.ts:240` `addPin`；`tab-mode.ts:32` `setMode` |
| 流水线视图口径 | `pipeline-model.ts:489` `derivePipelineViewFromData`；节点 `status === 1` 即进行中 |
| 接管现状 | `GrapeFocusPanel.tsx:425-531` 内联 onTakeover；`takeover-switch.ts:170` `switchToTakeoverWorkspace` |
| panel-api 只读白名单 | `src/panel-api.ts` 仅 `repos` / `issues` / `pipeline` 等 GET，本次不改 |

平台契约（`~/.grape/openapi-2.3.0a1.json` 实测）：

- `POST /api/issues/{owner}/{repo}` summary「Create issue (unified entry)」，
  description 明确 **"creates the GitCode issue, records it and triggers the pipeline"**，
  `trigger_pipeline` 默认 `true` → 建单即触发流水线（验收 6/7 的前置成立，不需要实际建单试探）。

## 3. 技术方案

### P0 同源 / CSRF 守卫（前置，覆盖 `/grape-worker-api/*` 全量）

新增纯模块 `src/worker-api-guard.ts`：

```
checkWorkerApiRequest({ method, headers })
  → { allow: true } | { allow: false, status: 403, code, message }
```

规则按顺序（headers 键大小写不敏感，值 trim）：

1. `Sec-Fetch-Site` 归一（trim + 小写）为 `cross-site` → 403 `cross_site`；
2. `Origin` 存在（非空）：`null` → 403 `cross_origin`；协议相对 `//host` 按 `https:` 解析；
   Origin 的 `host(:port)` 与请求 `Host`（缺失时取 `x-forwarded-host` 首值）不一致 → 403 `cross_origin`；
   两者都缺失 → fail-closed 403 `cross_origin`；
3. 非 `GET`/`HEAD` 且带 `Content-Type`：取 `;` 前、trim、小写后必须为 `application/json`，
   否则 403 `bad_content_type`（挡 simple-form / `text/plain` CSRF）；
4. 无 `Origin` 且无 `Content-Type`（CLI / 宿主内部调用）→ 放行。

接入点：`src/index.ts` prefix handler 解析 `method/url` 之后、第一个路由分支之前统一调用；
命中即 `_jsonReply(res, 403, { ok:false, code, error })` 并 return。

### P1 创建需求

- 纯模块 `src/create-issue.ts`：
  - `validateCreateIssueInput(raw)`：owner/repo `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` 且不含 `..`；
    title trim 后 1–200；description / assignee 可选（assignee 同 owner 形态）；
  - `extractCreatedIssueNumber(data)`：`issue_number → number → issue_id`，逐字段过
    `normalizeIssueNumber`（Gitee 字母数字、拒 `"0"`）；
  - `toCreateIssueError({status, data, requestId})`：4xx 原状态透传；5xx → 502 `upstream_unavailable`；
    code 取 `code/error_code`，message 取 `message/error/msg`，缺省「创建需求失败（HTTP {status}）」；
    `request_id` 取 body 或响应头。
- 宿主路由 `POST /grape-worker-api/create-issue`：
  校验（400 带 code/message）→ `resolveApiAuth`（失败 503 `not_configured`）→
  `grapeApiCall('POST', '/api/issues/{owner}/{repo}', {title, description?, assignee?})`；
  成功 `{ok:true, number}`；成功但无编号 → `{ok:true, number:"", warning:"no_issue_number", message}`
  （**不重建**）。`grapeApiCall` 增可选 `requestId`（`request-id` / `x-request-id` 响应头）。
- 面板：`GrapeBrowsePanel.tsx` 工具条下方按钮区（`view.kind !== 'repos'`）；
  表单仓库只读 `owner/repo`，标题 `maxLength=200`，`submitting` 同时禁用 取消/创建/创建并接管；
  成功 `addPin({owner, repo, number, title, platform})` → `setMode('live')` → 提示「已创建 #N，已加入观察」；
  失败在表单内展示可读 message。

### P2 创建需求并接管

- 纯模块 `src/takeover-plan.ts`：
  - `pickRunningAgent(view)`：首个 `status === 1` 节点的 `tag`（无则 `''`，不写死 coding）；
  - `normalizePlatform(v)` / `repoKeyFor(platform, repo)`：repo 已含 `:` 原样，否则 `${platform}:${repo}`，
    platform 缺省 `gitcode`（非法归一为空后按缺省处理）；
  - `takeoverFailureText({code, status, message, network})`：`taken_by_other` / 无运行节点 /
    401-403 / 网络错误 文案互异。
- `src/client/takeover-flow.ts`：把 `GrapeFocusPanel` 内联 onTakeover 抽成
  `requestTakeover({owner, repo, platform, number, agentType})`（乐观 busy、POST takeover、
  clipboard + localStorage + `setTakeoverSession` + `switchToTakeoverWorkspace`、失败 hint /
  request_id / takeover-list 自检、finally 清 busy、`setMode('live')` + `autoOpenOrSwitch`），
  节点按钮与新流程共用；导出 `postTakeoverList` 供接管条复用（两处都带 platform）。
- `src/client/create-issue-flow.ts`：`createIssue` → `addPin` → `setMode('live')` →
  `waitForFirstRunningNode`（`panelGet('pipeline', {force:'1'})` 1.5s/次、最多 60s、`pickRunningAgent`）
  → `requestTakeover`；超时提示「已创建并加入观察，启动后手动接管」，**保留 pin、不重试**；
  模块级单飞（同一仓库/标题在跑时不再发请求，验收 11）。
- `src/index.ts:2103`（takeover-list）与 `:2299`（takeover）：接受 `body.platform`
  （缺省 `gitcode`，`^[a-z][a-z0-9_-]{0,31}$`），repoKey 走 `repoKeyFor`；
  客户端 takeover / takeover-list 两处请求带当前仓库 platform（Gitee 不串 GitCode）。

## 4. 改动模块

| 模块 | 类型 | 说明 |
|---|---|---|
| `src/worker-api-guard.ts` | 新增 | P0 同源 / CSRF 纯守卫 |
| `src/create-issue.ts` | 新增 | P1 校验 / 编号提取 / 错误映射 |
| `src/takeover-plan.ts` | 新增 | P2 节点选择 / repoKey / 失败文案 |
| `src/index.ts` | 修改 | 守卫接入、create-issue 路由、两处 platform + repoKey、`grapeApiCall` requestId |
| `src/client/GrapeBrowsePanel.tsx` | 修改 | 工具条按钮 + 表单 + 提交态 |
| `src/client/takeover-flow.ts`、`create-issue-flow.ts` | 新增 | 接管与「创建并接管」流程共用 |
| `src/client/GrapeFocusPanel.tsx` | 修改 | onTakeover 改调 takeover-flow，接管条带 platform |
| `src/client/pins-store.ts` | 修改 | `platformFor()` 只读查平台（焦点卡无 platform 字段时按缺省） |
| `docs/issue-40/{spec,plan,task}.md` | 新增 | 本 Spec + 方案 + 对照表 / 手工清单 |
| `src/panel-api.ts`、平台仓库、依赖 | 不变 | 只读白名单不动，不加依赖 |

## 5. 验收条款 → 代码位置 → 测试

| # | 验收 | 代码位置 | 测试 |
|---|---|---|---|
| 1 | 根列表无按钮 / 进仓库出现 / 仓库只读 | `GrapeBrowsePanel.tsx` 按钮区（`kind !== 'repos'`） | 手工 A1 |
| 2 | 标题校验 / 提交禁用 / 双击不重复 | `create-issue.ts validateCreateIssueInput`；表单 `submitting` | `test/create-issue.test.mjs`「title 1–200 边界」+ 手工 A2 |
| 3 | 成功编号 / addPin / 切实时；Gitee 编号 | `extractCreatedIssueNumber`；`create-issue-flow` | `test/create-issue.test.mjs`「issue_number→number→issue_id」「IKXR3B」 |
| 4 | 400/403 原因可读，不出现裸 500 | `toCreateIssueError` | `test/create-issue.test.mjs`「403 映射」「5xx→502」 |
| 5 | 跨站 POST 403；同源正常 | `worker-api-guard.ts` + `index.ts` 接入点 | `test/worker-api-guard.test.mjs` |
| 6 | 60s 内首节点运行 → 自动接管 | `create-issue-flow` + `takeover-flow` | `test/takeover-plan.test.mjs`「首节点 status=1」 |
| 7 | 超时降级、不报错、不重试、pin 保留 | `waitForFirstRunningNode` 超时分支 | `test/takeover-plan.test.mjs`「无运行节点返回空」+ 手工 A4 |
| 8 | 接管取实际运行节点，不写死 coding | `pickRunningAgent` | `test/takeover-plan.test.mjs`「vod 而非 coding」 |
| 9 | Gitee 不串 GitCode | `repoKeyFor` + `index.ts` 两处 | `test/takeover-plan.test.mjs` |
| 10 | 接管失败原因可读且 pin 保留 | `takeoverFailureText` | `test/takeover-plan.test.mjs` |
| 11 | 重复点不重复建单 / 接管 | 表单 `submitting` + flow 单飞 | 手工 A5 |

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| `POST /api/issues/{owner}/{repo}` 是否触发流水线 | 验收 6/7 依赖节点出现 | OpenAPI 2.3.0a1 明确「triggers the pipeline」且 `trigger_pipeline` 默认 true → 主路径成立，不实际建单试探 |
| 反向代理改写 Host | 同源判定误杀面板请求 | `x-forwarded-host` 首值兜底；两者都缺 fail-closed，不放宽校验 |
| client UI 无 node:test 基建 | 按钮位置 / 双击无自动回归 | 纯逻辑（校验 / 选择 / repoKey / 文案）全进 `lib` 单测；UI 行为进 `task.md` 手工清单 |
| 测试弱化 | 回归面收窄 | 只增不删，基线 304 条（303 pass / 1 skip），新增 3 个测试文件后总数上升 |

## 7. 交付要求

- P0 → P1 → P2，每阶段先写测试（RED）再实现；P1 完成即可独立验收。
- `docs/issue-40/{spec,plan,task}.md` 落库，`task.md` 含手工验证清单。
- 自检：`npm run typecheck`、`npm test`、`npm run build`、
  `git grep -n "Origin\|Sec-Fetch-Site" src/index.ts`（命中守卫接入点）。