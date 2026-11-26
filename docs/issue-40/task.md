# Issue #40 任务拆解与验收对照（Task）

## 任务清单

### P0 同源 / CSRF 守卫

- [x] T0-1 `test/worker-api-guard.test.mjs`：同源 / 跨站 / `Sec-Fetch-Site` / `text/plain` /
      无头（CLI）/ 大小写 / 协议相对 / `null` / `x-forwarded-host` / Host 缺失 fail-closed
- [x] T0-2 `src/worker-api-guard.ts`：`checkWorkerApiRequest`
- [x] T0-3 `src/index.ts` prefix handler 接入（解析 method/url 后、任何路由前）

### P1 创建需求

- [x] T1-1 `test/create-issue.test.mjs`：title 1–200 边界、owner/repo 形态与 `..`、
      编号三种字段 + `IKXR3B`、403 映射、5xx→502、request_id 两个来源
- [x] T1-2 `src/create-issue.ts`：`validateCreateIssueInput` / `extractCreatedIssueNumber` /
      `toCreateIssueError`
- [x] T1-3 `grapeApiCall` 增 `requestId`；`_readBody` 增可选上限
- [x] T1-4 `src/index.ts` `POST /grape-worker-api/create-issue`
- [x] T1-5 `GrapeBrowsePanel.tsx` 按钮区 + 表单 + 提交态 + 可读错误

### P2 创建需求并接管

- [x] T2-1 `test/takeover-plan.test.mjs`：首节点 status=1（vod）、无运行节点、repoKey
      缺省/gitee/已含前缀/非法 platform、失败文案互异
- [x] T2-2 `src/takeover-plan.ts`：`pickRunningAgent` / `normalizePlatform` / `repoKeyFor` /
      `takeoverFailureText`
- [x] T2-3 `src/client/takeover-flow.ts`：`requestTakeover` / `postTakeoverList`
- [x] T2-4 `src/client/create-issue-flow.ts`：`createIssue` / `waitForFirstRunningNode` /
      `createIssueAndTakeover`（单飞 + 超时降级）
- [x] T2-5 `GrapeFocusPanel.tsx`：onTakeover 改调 takeover-flow；接管条带 platform
- [x] T2-6 `src/index.ts` takeover-list / takeover 接受 `platform`，repoKey 走 `repoKeyFor`
- [x] T2-7 `pins-store.ts`：`platformFor()` 查询已观察仓库平台

## 验收条款 → 代码 → 测试

| # | 验收 | 代码位置 | 自动/手工测试 |
|---|---|---|---|
| 1 | 根列表无按钮；进仓库出现；仓库只读 | `GrapeBrowsePanel` 按钮区（`kind !== 'repos'`） | 手工 A1 |
| 2 | 标题为空/超长校验；提交中三按钮禁用；双击不重复建单 | `validateCreateIssueInput`；表单 `submitting` | `create-issue.test.mjs`「title 1–200 边界」+ 手工 A2 |
| 3 | 成功返回编号 → addPin → 切实时；Gitee 字母数字编号正确 | `extractCreatedIssueNumber`；`create-issue-flow` | `create-issue.test.mjs`「issue_number→number→issue_id」「IKXR3B」 |
| 4 | 400/403 原因可读，不出现裸 HTTP 500 | `toCreateIssueError` | `create-issue.test.mjs`「403 映射」「5xx→502」 |
| 5 | 跨站 Origin 的 POST 403；同源面板请求正常 | `worker-api-guard` + `index.ts` 接入 | `worker-api-guard.test.mjs` |
| 6 | 60s 内首节点运行 → 自动接管并开会话 | `waitForFirstRunningNode` + `requestTakeover` | `takeover-plan.test.mjs`「首节点 status=1」+ 手工 A3 |
| 7 | 窗口内无运行节点 → 提示手动接管、不报错、不重试、pin 保留 | 超时分支 | `takeover-plan.test.mjs`「无运行节点返回空」+ 手工 A4 |
| 8 | 接管目标取实际运行节点（VOD 首节点也能接管），不写死 coding | `pickRunningAgent` | `takeover-plan.test.mjs`「vod 而非 coding」 |
| 9 | Gitee 仓库不串 GitCode（platform 透传） | `repoKeyFor` + `index.ts` 两处 | `takeover-plan.test.mjs`「gitee:owner/repo」 |
| 10 | 接管失败（taken_by_other / 权限 / 网络）可读，pin 仍保留 | `takeoverFailureText` | `takeover-plan.test.mjs`「文案互异」 |
| 11 | 重复点「创建并接管」不重复建单 / 重复接管 | 表单 `submitting` + `createIssueAndTakeover` 单飞 | 手工 A5 |

## 手工验证清单（client UI 无 node:test 基建，故人工执行）

- **A1 按钮位置**：打开浏览页 → 根列表（仓库层级）**无**按钮区；点进任一仓库 → issue 列表出现
  「创建需求」「创建需求并接管」；再点进流水线详情仍出现；表单仓库字段只读、显示 `owner/repo`。
- **A2 校验与提交态**：标题留空 / 贴 201 字 → 表单内可读提示、不发请求；点「创建」后三按钮同时禁用，
  快速双击只产生一条需求（同仓库刷新列表核对）。
- **A3 创建并接管成功**：点「创建需求并接管」→ 面板提示「已创建 #N，已加入观察」→ 60s 内首节点运行后
  自动切到该节点会话并发送接管 prompt（VOD 首节点场景同样成立）。
- **A4 超时降级**：用只建单不触发流水线的仓库（或临时把超时调小）→ 提示「已创建并加入观察，
  启动后手动接管」，pin 卡仍在观察列表，无报错、无重试。
- **A5 重复点击**：连续两次点「创建并接管」→ 第二次不发请求（按钮禁用 / 单飞），仓库内只新增一条需求，
  平台只有一条 active 接管。
- **A6 跨站守卫**：`curl -X POST -H "Origin: https://evil.example" -H "Content-Type: application/json"
  --data '{}' http://<dsh-host>/grape-worker-api/revoke` → `403 {"code":"cross_origin"}`；
  同源面板请求（浏览器内点按钮）正常。

## 自检命令

```bash
npm run typecheck
npm test
npm run build
git grep -n "Origin\|Sec-Fetch-Site" src/index.ts   # 应命中守卫接入点
```

## 复审修复（QA PR #40 审查：2 Required / 3 Optional / 2 Nit）

| 级别 | 审查意见 | 修复 | 测试 |
|---|---|---|---|
| Required | 建单载荷未带 `repo_key`，`platform` 在 `validateCreateIssueInput` 处被丢弃 → Gitee 等平台串库 | `create-issue.ts` 保留归一后的 `platform`；新增 `buildCreateIssuePayload` 生成 `repo_key`（缺省 `gitcode:`，Gitee → `gitee:`），路由改用它 | `create-issue.test.mjs`：`gitee:owner/repo` / 缺省 gitcode / 可选字段不传空串 / platform 归一保留 |
| Required | `verifyStillActive` 把查询失败（null）当「没有接管」，随后 `clearPendingTakeover()` | 新增纯函数 `takeoverStillActive`（查到 → true；确认查不到 → false；**查不到结果 → true**），接管条改用它 | `takeover-plan.test.mjs`：三态各一条 |
| Optional | `requestHost` 不认 HTTP/2 `:authority`，同源 POST 会被 fail-closed | `requestHost` 依次取 `host` → `x-forwarded-host` 首值 → `:authority` | `worker-api-guard.test.mjs`：`:authority` 同源放行 / 跨源 403 |
| Optional | body 超限时静默变 `{}`，误报「owner 格式不合法」 | `_readBody` 超限回 `__tooLarge` 标记，create-issue 路由回 413 `payload_too_large` + 可读文案；表单描述框 `maxLength=10000` + 占位提示 | 路由级（手工 A2 覆盖文案） |
| Optional | 两个入口不记忆意图，打开表单后还要再点一次 | `CreateIssueBar` 记 `intent`，对应动作按钮默认 primary | 手工 A1 |
| Nit | 兜底文案自带「接管失败：」前缀导致重复两遍 | `takeoverFailureText` 兜底不再带前缀，由调用方统一加 | `takeover-plan.test.mjs`：文案不以「接管失败」开头 |
| Nit | `waitForFirstRunningNode` 注释写「先等再查」与实现相反 | 注释改为「先查再等」 | — |

工作流类意见（无 CI、零审批）属仓库设置，需管理员配置分支保护与 CI 门禁，不在本单代码范围内。
