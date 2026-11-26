# grape-dsh 插件改进方案

> 针对三个问题：① 无法创建新 issue ② 无法查看 issue ③ 状态展示全是文字、没有 UI
> 全部结论基于本机实测（2026-10-14），不含推测。凡未实测的条目均显式标注。

---

## 一、现状取证（先摆事实）

### 1.1 当前注册的 9 个工具（实测）

| # | 工具 | 端点 |
|---|------|------|
| 1 | `grape_list_scenes` | `GET /api/scenes/market?limit=100` |
| 2 | `grape_apply_scene` | `POST /api/scenes/apply/{owner}/{repo}`（body `{scene_id}`） |
| 3 | `grape_list_managed_repos` | `GET /api/repos/managed` |
| 4 | `grape_trigger_pipeline` | `POST /api/a2a` |
| 5 | `grape_get_task_status` | `GET /api/events/detail/{seq}` |
| 6 | `grape_wait_task` | 轮询 #5 |
| 7 | `grape_get_pipeline_info` | `GET /api/issues/{owner}/{repo}/{number}/pipeline` |
| 8 | `grape_list_issues` | `GET /api/issues/{owner}/{repo}` |
| 9 | `grape_get_issue_events` | `GET /api/issues/{owner}/{repo}/{number}/events` |

**没有 create_issue 工具** —— 与 skill 里记的「插件没有 create_issue 工具，所以 trigger_pipeline 只能对已存在的 issue 触发」一致。

### 1.2 三个问题的根因

**问题① 无法创建 issue —— 工具缺失，且 Grape 其实有"一条龙"接口**

Grape 侧有两个创建入口（都在 `/openapi.json` 里）：

| 端点 | 说明 |
|------|------|
| `POST /api/issues/{owner}/{repo}` | **unified entry**。源码 `src/api/routes/issues.py:1343` 注释：「Creates an Issue (unified external entry): creates the GitCode issue, records it **and triggers the pipeline**」。body：`{repo_key?, title, description?, assignee?, scene_id?, is_subtask_mode?}`，返回 `{ok, issue_number, task_id, created, ...}`。需 `require_org_member`。 |
| `POST /api/git-repo/{owner}/{repo}/issues` | 仅在 GitCode 建 issue（body `{title(必), body, assignee}`），**不触发流水线** |

→ 用 unified entry 可以**一次调用完成"建 issue + 触发流水线"**，正好补上 `trigger_pipeline` 的前置依赖断点。

**问题② 无法查看 issue —— 工具在、接口通，但有两个真实缺陷**

实测 `GET /api/issues/wdmike/snake-game-0915` → 200，返回 7 条。缺陷在两处：

1. **query 参数名写错，过滤静默失效。** 插件传的是 `state`（`src/tools/issues.ts:40`），而接口只认 **`status`**（另有 `sort_order` / `mode` / `assignees`）。实测传 `?state=all` 与不传返回完全一致 → 参数被忽略，用户以为"筛不出来"。
2. **必须同时给 owner + repo，没有"我的全部 issue"入口。** Grape 有 `GET /api/issues/mine`（`issues.py:1232`），支持 `status` / `repo_key` / `sort_order` / `mode` / `created_by_me` / `assignees`，且同样带 scene/stage/is_running/agent_statuses 富化字段。用户想"看看我有哪些 issue 在跑"时，用现有工具必须自己知道 owner/repo。

附带已知缺口（已在 GAPS.md）：`grape_get_issue_events` 对**归档**过的 issue 返回空（该端点只读 `events` 表，而 `/pipeline` 会先读 `event.json` 归档）。

**问题③ 状态全是文字 —— 数据很丰富，但被"整包 JSON 塞进一个 text block"浪费**

- 渲染实现：`src/tools/helper.ts:62` 里 `makeTool()` 对**全部 9 个工具**统一用
  `render → [{ type: 'text', text: JSON.stringify(value, null, 2) }]` —— 纯文本，无结构。
- 但数据本身足够画卡片。实测单条 issue 的字段：

  ```
  issue_number, title, status, task_status, stage, scene_id, scene_name,
  is_running, is_pr, owner_agent, events_count, created_at, completed_at,
  agent_statuses: [{agent, label, status, status_num}, ...],   ← 每节点状态数组
  latest_event:   {seq, event_type, agent_type, title}          ← 最新事件
  ```

  也就是说「每个 agent 到哪一步了」已经是**结构化数组**，只是被当字符串倒出来了。

- dsh 侧**本来就支持结构化渲染**（实测代码）：
  - `ToolDefinition.output.render(args, value): ContentBlock[]`；`ContentBlockMap` 含 `text/reasoning/image/file/tool-call/...` 且**可被插件扩展**（源码注释 "widens as plugins add entries"）。
  - **`ToolDefinition.presentCall?(args)` / `presentResult?(args, result)`** —— 官方给插件的展示钩子，返回结构化 view：`GenericCallView`、`TerminalCallView`、`DiffCallView`、`GenericResultView`、`TerminalResultView`、`DiffResultView`、`SearchResultView`(matches/paths)、`ReadResultView`、`WebResultView`。**纯函数、可回放**（session 回放也能正确渲染），**不需要客户端 bundle、不需要改 dsh**。
  - 对话与工具结果文本走 Markdown 渲染（`dsh-client-ui-primitives/markdown/*`、client-ui-tool 内含 markdown 标签）。
  - 官方 `dsh-tool-todo` 的 render 就只回**一行摘要**（`Updated todo list: 3 pending, ...`），把结构留给展示层 —— 值得照抄这个分寸。

---

## 二、方案 A：补齐 issue 能力（工具层）

### A1. 新增 `grape_create_issue`（走 unified entry）★ 最高优先

```
参数: owner(必), repo(必), title(必), description?, scene_id?, assignee?, is_subtask_mode?
端点: POST /api/issues/{owner}/{repo}
body: {repo_key?, title, description?, assignee?, scene_id?, is_subtask_mode?}
返回: {ok, issue_number, task_id, created, ...}
```

价值：一次调用 = 建 issue + 触发流水线。`issue_number` 可直接喂给 `wait_task` / `get_pipeline_info`，打通"从 0 到跑"的完整链路。
建议：`scene_id` 省略时由 Grape 走默认/推荐场景；工具描述里写清「什么时候用」（用户说"建个 issue/开个任务/让它跑这个需求"）。

### A2. 新增 `grape_list_my_issues`（走 `/api/issues/mine`）★

```
参数: status?(active|processing|awaiting_input|pending_review|completed), repo_key?, mode?, created_by_me?, assignees?
端点: GET /api/issues/mine
```

价值：**不用知道 owner/repo** 就能列出自己的 issue 状态 —— 这是"没办法查看"最直接的解法。

### A3. 修 `grape_list_issues` 的参数名（一行 bug）

```
- params: args.state ? { state: args.state } : undefined
+ params: args.status ? { status: args.status } : undefined
```
同时把 `sort_order` / `mode` / `assignees` 暴露成可选参数（接口已支持）。

### A4. 生命周期工具（按需，先问用户）

接口齐备（实测 openapi）：`/api/issues/{issue_id}/start`、`/cancel`、`/resume`、`/clarify`、`/confirm-done`、`/review-pass`、`/review-reject`、`GET,PUT /status`。

- `start` / `resume` 属"推进"，与"只触发、只观察"原一致，可加。
- `cancel` / `review-pass` / `review-reject` / `confirm-done` 属**干预决策**（影响流水线走向）→ 加之前先问用户，且建议配 dsh 的 `tools/pre-execute` 确认（dsh 支持 `approval/policy: ask`）。
- 注意：这些是 **Grape 域内动作**，不是"代理 GitCode 操作"（后者是设计上明确排除的）。

---

## 三、方案 B：状态展示改成结构化 UI（渲染层）

### B1. 最小改动、收益最大：render 输出 Markdown 而不是整包 JSON

保留模型侧 content 的全量 JSON（模型需要原始数据做判断），只改**给人看的 render**：

| 工具 | 建议渲染 |
|------|---------|
| `list_issues` / `list_my_issues` | Markdown 表格：`# / 标题 / 场景 / 阶段 / 运行中 / agent 进度`（用 `agent_statuses` 打勾/叉） |
| `get_pipeline_info` | 节点清单（每节点一行 + 状态徽标 + summary），末尾附整体结论 |
| `trigger_pipeline` | 单行结果：`已触发 seq=106（agent=vod）`，附 issue 链接 |
| `wait_task` / `get_task_status` | 单行终态 + 耗时 + 结论摘要 |
| `list_scenes` / `list_managed_repos` | 表格（场景名/节点数；仓库/角色/webhook 状态） |

### B2. 用官方 `presentCall` / `presentResult`（推荐做法）

在工具定义里加展示钩子，返回 dsh 的现成 view 类型（**无需客户端 bundle**）：

```ts
// src/tools/issues.ts 里每个工具追加
presentCall(args) {
  return { card: 'generic', title: `查询 ${args.owner}/${args.repo} 的 issue`, kind: 'search' }
},
presentResult(args, result) {
  return { card: 'generic', title: `Issue 列表（${result?.total ?? 0} 条）`, content: markdownBlocks(result) }
},
```

- `list_issues` / `list_my_issues` → 列表卡（也可考虑 `SearchResultView` 的 `matches` 形状）
- `get_pipeline_info` → 节点进度卡
- `trigger_pipeline` → `GenericCallView{kind:'execute'}` + `GenericResultView`
- 关键约束（源码注释明确）：**纯函数、只依赖 args/result**，因为 session 回放也会调用它。

### B3. 进阶：自定义 ContentBlock + 客户端插件（成本最高，按需）

- `ContentBlockMap` 可扩展 + `ConversationNodeDefinition`（从 `@deepseek-ai/dsh-client-ui-conversation/client` 导出，官方 `dsh-client-ui-goal` / `user-questions` / `workflow-run` 都这么做）→ 能做真正的 Grape 卡片（进度条、状态徽章、可点击跳转）。
- 代价：插件要**新增浏览器侧 bundle**（当前 `lib/client.js` 是 HTTP 客户端，**不是**客户端插件代码，插件零客户端代码），构建与分发链变复杂。
- 建议：**A1/A2/A3 + B1/B2 先落地**，B3 等 UI 需求明确后再投入。

---

## 四、实施顺序与验收

**阶段 1（修 bug + 补关键工具）**：A3（参数名，一行）→ A1（create_issue）→ A2（my_issues）
**阶段 2（展示）**：B1 → B2
**阶段 3（可选）**：A4 白名单动作、B3 自定义卡片

验收方式（沿用现有脚手架，均已具备）：

1. `npx tsc --noEmit` 类型检查
2. 模块加载 + 工具名单校验（工具数从 9 → 11，**记得同步人写数字**）
3. `node test-e2e.mjs readonly` 打真实 Grape（readonly 阶段不产生副作用）
4. 真实 dsh 对话跑一遍，用 **session 日志**证明工具被调用 + 目视确认渲染效果：
   ```bash
   zstd -d -c ~/.dsh/sessions/*/session-*/session.v4.jsonl.zstd > /tmp/sess.jsonl
   # 看 request/header 的 tools 列表 + tool/call、tool/result 事件
   ```

**增删工具必须同步的「人写数字」清单**（skill 已记，连中过两次）：
`README.md` 工具表 → `locale/en.json` → `locale/zh.json` → `cordis.patch.yml` 注释 → `src/index.ts` 顶部注释 → `apply()` 末尾的 `console.log('Registered N tools')`。

---

## 五、风险与边界

1. **`create_issue` 有真实副作用**（在仓库里建 issue 并触发流水线）。建议：
   - 描述里写清副作用，让模型只在用户明确要求时调用；
   - 不要给该工具加自动重试（避免重复建 issue）；
   - 可利用 dsh 的 `tools/pre-execute` + `approval/policy: ask` 要求确认。
2. **A4 的 cancel / review-pass / review-reject / confirm-done 属"决策干预"**，加之前先问用户。
3. **保持原有边界原则**：只触发、只观察，不干预流水线节点间 A2A 交接。
4. **`grape_get_issue_events` 对归档 issue 返回空**是 Grape 侧数据源差异（未修）。若要做事件的 UI 展示，需先解决取数，否则 UI 再好看也是空表。
5. 本方案中**未实测**的部分：`POST /api/issues/{owner}/{repo}` 的返回体细节（源码注释给了字段名，但没实际调过，因为会产生真实 issue）；`/api/issues/mine` 的真实响应结构（同因）。实施 A1/A2 时先各调一次确认字段。
