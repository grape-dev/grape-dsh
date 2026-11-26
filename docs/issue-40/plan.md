# Issue #40 方案设计（Plan）

## 方案概述

三个纯模块承载可单测的判定（守卫 / 建单映射 / 接管计划），宿主只做接线；客户端把
「创建并接管」拆成 `create-issue-flow`（建单 + 轮询 + 接管编排）与 `takeover-flow`
（接管动作，节点按钮复用），避免两套顺序逻辑。全程不改 `src/panel-api.ts`、不加依赖。

## 阶段与提交顺序（TDD：先红后绿）

| 阶段 | 红（test） | 绿（feat） | 内容 |
|---|---|---|---|
| P0 | `test/worker-api-guard.test.mjs` | `src/worker-api-guard.ts` + `src/index.ts` 接入 | 同源 / CSRF 守卫覆盖 `/grape-worker-api/*` 全量 |
| P1 | `test/create-issue.test.mjs` | `src/create-issue.ts` + `src/index.ts` 路由 + `src/client/create-issue-flow.ts`（createIssue）+ `GrapeBrowsePanel.tsx` | 校验 / 编号提取 / 错误映射 + 建单表单 |
| P2 | `test/takeover-plan.test.mjs` | `src/takeover-plan.ts` + `src/client/takeover-flow.ts` + `create-issue-flow.ts`（轮询 + 编排）+ `GrapeFocusPanel.tsx` + `index.ts` platform | 创建并接管编排 + platform 透传 |

文档（spec/plan/task）先行提交，再按阶段红/绿分提交。

## P0 实现要点

1. `checkWorkerApiRequest` 输入 `{ method, headers }`，headers 支持普通对象（Node `req.headers`）
   与大小写变体；取值兼容 `string[]`（如 `x-forwarded-host`）。
2. 判定顺序固定：`Sec-Fetch-Site` → `Origin` → `Content-Type` → 放行（顺序影响错误码，
   跨站优先于同源判断，避免同时命中时给出误导性 code）。
3. Origin 解析不依赖 `new URL` 的异常路径也能工作：`//host` 前置 `https:`；解析失败一律
   `cross_origin`（fail-closed）。
4. Host 取值：`host` 缺失 → `x-forwarded-host` 首值（逗号分隔取第一个）；仍缺 → 403。
5. 接入点必须在 prefix handler 解析 `method/url` 后、`/ping` 之前，保证只读路由同样受保护。
6. 403 响应体统一 `{ ok:false, code, error: <可读中文> }`。

## P1 实现要点

1. 校验返回 `{ ok:true, value } | { ok:false, code, message }`，code 为
   `invalid_owner` / `invalid_repo` / `invalid_title` / `invalid_assignee`；title 先 trim 再判长。
2. owner/repo 正则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`，额外拒绝 `..`（路径穿越）。
3. 编号提取逐字段 `normalizeIssueNumber`，命中即返回；`"0"` / 非法形态不作编号。
4. 错误映射：`status` 非数字 → 502；4xx 原状态；5xx → 502 `upstream_unavailable`；
   `code` 取 `code|error_code`，`message` 取 `message|error|msg`，缺省「创建需求失败（HTTP {status}）」；
   `request_id` 先 body 后响应头。
5. `grapeApiCall` 返回值增加 `requestId`（向后兼容，现有调用方忽略即可）；
   `_readBody` 增加可选字节上限（默认 4KB，create-issue 用 64KB 以容纳描述）。
6. 路由成功但无编号：`{ ok:true, number:'', warning:'no_issue_number', message:'已创建但未拿到编号，请刷新列表' }`，
   **不重建**（重建会造出两条需求）。
7. 面板：按钮区在工具条下；表单本地 state（open/intent/submitting/错误）——
   `submitting` 一次点击即置位，三按钮同禁，双击不重复发请求；`intent` 记住点击的入口。
8. 建单请求体由 `buildCreateIssuePayload` 统一生成，**必带 `repo_key = repoKeyFor(platform, owner/repo)`**
   （缺省 `gitcode:`；Gitee/GitLab 同名仓库不串库），路由不自行拼字段。

## P2 实现要点

1. `pickRunningAgent` 只看 `nodes[].status === 1` 的 `tag`，不按 agent 名过滤 → VOD 首节点也能接管。
2. `repoKeyFor`：`repo` 已含 `:` 原样返回（兼容调用方直接传 repo_key）；platform 非法/缺省 → `gitcode`。
3. `requestTakeover` 抽出后行为与内联版一致：乐观 `setTakeoverBusy` + notice、
   成功后 clipboard / localStorage / `setTakeoverSession` / `switchToTakeoverWorkspace`、
   失败 hint（`taken_by_other`）+ request_id + takeover-list 自检、finally 清 busy、
   切 `live` 模式并 `autoOpenOrSwitch`。
4. `waitForFirstRunningNode`：`panelGet('pipeline', {owner, repo, number, force:'1'})` →
   `derivePipelineViewFromData` → `pickRunningAgent`；1.5s 间隔、60s 上限（可注入 sleep / 取数函数便于测试与降级）。
5. 超时 / 无运行节点：提示「已创建并加入观察，启动后手动接管」，保留 pin，**不重试**。
6. 单飞：模块级 `inFlight` 集合按 `owner/repo + title` 去重（验收 11）。
7. platform 透传：`GrapeFocusPanel` 经 `platformFor(owner, repo)`（pins 已知平台）取值，
   两处请求（takeover / takeover-list）都带 `platform`；未知时传空串 → 宿主按 `gitcode`。

## 关键决策

| 决策 | 选项 | 选择 | 理由 |
|---|---|---|---|
| 守卫放在哪 | 每条路由内 / prefix 入口 | **prefix 入口** | 16 条 POST 逐条改必漏；入口一处覆盖全量（含未来新增） |
| 无编号时是否重建 | 自动重试 / 不重建 | **不重建** | 平台可能已建成功，重试会造重复需求 |
| 建单调用 | `grape issues create`（CLI） / `POST /api/issues/{owner}/{repo}` | **HTTP 直连** | OpenAPI 明确该端点建单并触发流水线；免 spawn CLI，面板响应更快 |
| 接管流程位置 | 保留内联 + 新流程另写 | **抽 `takeover-flow`** | 节点按钮与新流程必须同一套顺序逻辑，否则两处漂移 |
| 轮询实现 | 定时器 / 循环 await | **循环 await + 注入取数** | 天然可取消、可测；不额外引依赖 |

## 风险与回退

| 风险 | 影响 | 处理 |
|---|---|---|
| `POST /api/issues/{owner}/{repo}` 若**只建单不触发**流水线 | 验收 6/7（等首节点运行 → 自动接管 / 超时降级）不成立 | 回退到与 `grape_create_issue` 同源的 `grape issues create` CLI 调用路径（`src/tools/issues.ts:88`），宿主路由改为 `execGrape` 建单；仅替换 `create-issue` 路由内部实现，`src/create-issue.ts` 的校验/编号/错误映射与客户端编排不变 |
| 建单成功但响应无编号 | 无法 addPin / 接管 | 回 `{ok:true, number:'', warning:'no_issue_number'}` 提示刷新，**不重建**（避免重复需求） |

- 建单端点与 `grape_create_issue` 工具使用的是**同一个**平台建单入口（CLI `issues create` 即打该 HTTP 端点，工具描述明确「建单 + 触发流水线」），故按「同源」处理，不额外调一次 `a2a handoff`（那会在同一 issue 上触发第二条流水线）。
- 验收 6/7 的真实仓库联调未在开发期执行：验证「建单后是否真起节点」会在 `grape-dev/grape-dsh` 造出一条真实需求，属于超出本 Issue 的副作用，留给 QA 在验收环境确认；若实测不触发，按上表回退。

## 与基线的关系

- 基线 `dev-ch-11`（含 #39 的编号口径收敛），复用 `normalizeIssueNumber`，不重复定义正则。
- 不改 `src/panel-api.ts`：新接口走 `/grape-worker-api/create-issue`，客户端直连同源 POST。
- 平台仓库与依赖不动；文档落 `docs/issue-40/`。