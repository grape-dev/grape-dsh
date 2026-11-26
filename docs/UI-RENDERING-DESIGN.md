# grape-dsh 插件 UI 渲染设计

> 基于 dsh 官方 presentation.d.ts 类型定义 + 官方工具源码实测（bash/web_search/str-replace-editor/todo）。
> 所有 view 类型均为纯函数，session 回放也能正确渲染，不需要客户端 bundle。

---

## 一、dsh 的三层渲染接口

每个 ToolDefinition 可以声明三个渲染相关的方法：

```
工具调用流程:
  模型决定调用工具
    → presentCall(args)        // 卡片：用户看到"正在做什么"
    → execute(args, signal)    // 执行：模型拿到完整 JSON 返回值
    → render(args, value)      // 文本：模型看到的内容（从 execute 返回值生成）
    → presentResult(args, result)  // 卡片：用户看到"做完了，结果是这样"
```

### 接口签名（从 presentation.d.ts 提取）

```typescript
// 工具开始执行前——给用户看的待处理卡片
presentCall?(args: unknown): ToolCallView | undefined

// 工具执行完成后——给用户看的结果卡片
presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined

// 模型看到的内容（必选）
render(args: unknown, value: JsonValue): ContentBlock[]
```

### 可用的卡片类型

**ToolCallView（待处理卡片）——3 种：**

| 类型 | card 值 | 关键字段 | 适用场景 |
|------|---------|---------|---------|
| GenericCallView | `generic` | title, kind, rawInput, content, locations | 默认，所有工具都能用 |
| TerminalCallView | `terminal` | title, description, cwd | 命令执行（bash） |
| DiffCallView | `diff` | title, diffs[{path, oldText, newText}] | 文件编辑 |

**ToolResultView（结果卡片）——6 种：**

| 类型 | card 值 | 关键字段 | 适用场景 |
|------|---------|---------|---------|
| GenericResultView | `generic` | title?, content? | 默认，可放 Markdown content |
| TerminalResultView | `terminal` | title?, output, exitCode, signal | 命令输出 |
| DiffResultView | `diff` | title?, diffs[] | 文件变更结果 |
| SearchResultView | `search` | title?, shape('matches'/'paths'), files/paths, truncated, total | 搜索结果 |
| ReadResultView | `read` | title?, path, offset, lines[], totalLines, lang | 文件读取 |
| WebResultView | `web` | title?, kind('search'/'fetch'), sources[], truncated | 网页搜索 |

### ToolCallKind（图标分类）

```
'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'
```

dsh UI 根据 kind 选择图标。Grape 工具全部用 `generic` 卡片，通过 kind 区分图标。

---

## 二、Grape 插件的渲染策略

### 核心原则

1. **presentCall**：全部用 `GenericCallView`，设 `title` + `kind`，让用户看到"正在做什么"
2. **presentResult**：大部分用 `GenericResultView` + Markdown content blocks；简单结果省略让 render 兜底
3. **render**：每个工具写专门的 Markdown 格式化函数，不再用 `JSON.stringify`

### render 与 presentResult 的分工

| 层 | 消费者 | 内容 | 格式 |
|----|--------|------|------|
| execute 返回值 | 模型 | 完整 JSON 对象 | CLI --json-out 的原始输出 |
| render | 模型 | 精简文本 | 一行摘要或关键字段（模型不需要重复完整 JSON） |
| presentResult | 用户 | 结构化卡片 | Markdown 表格/时间线/节点链 |

关键：render 给模型看的文本要精简（避免模型 context 膨胀），presentResult 给用户看的卡片可以丰富。

---

## 三、34 个工具的渲染配置

### A 档：核心流水线（9 个）

#### 1. grape_list_scenes

```
presentCall:  {card:"generic", title:"查询可用流水线场景", kind:"search"}
presentResult: {card:"generic", title:"场景列表（9 个）", content:[场景表格 Markdown]}
render:       "找到 9 个场景: default, hello-world, blog-publish, ..."
```

表格列：`| 名称 | 显示名 | 版本 | 节点数 | 仓库数 |`

#### 2. grape_apply_scene

```
presentCall:  {card:"generic", title:"切换仓库场景 → ${scene}", kind:"execute"}
presentResult: 省略（render 一行确认即可）
render:       "✅ 场景 '${scene_name}' 已应用到 ${owner}/${repo}"
```

#### 3. grape_list_managed_repos

```
presentCall:  {card:"generic", title:"查询纳管仓库", kind:"search"}
presentResult: {card:"generic", title:"纳管仓库（N 个）", content:[仓库表格 Markdown]}
render:       "找到 N 个纳管仓库: owner/repo1, owner/repo2, ..."
```

表格列：`| 仓库 | 角色 | 状态 | Webhook | 分支 |`

#### 4. grape_trigger_pipeline

```
presentCall:  {card:"generic", title:"触发流水线: ${repository} #${issue_number}", kind:"execute"}
presentResult: 省略
render:       "✅ 流水线已触发 | event_seq=${seq} | agent=${agent}"
```

#### 5. grape_get_task_status

```
presentCall:  {card:"generic", title:"查询任务状态 seq=${seq}", kind:"read"}
presentResult: {card:"generic", title:"${status_icon} ${status} | ${agent} | seq=${seq}", content:[状态摘要 Markdown]}
render:       "${status_icon} ${status} | agent=${agent} | seq=${seq}\n${summary}"
```

#### 6. grape_wait_task

```
presentCall:  {card:"generic", title:"等待任务完成 seq=${seq}（超时 ${timeout}s）", kind:"execute"}
presentResult: {card:"generic", title:"${status_icon} ${status} | ${duration}s | seq=${seq}", content:[结果摘要]}
render:       "${status_icon} ${status} | agent=${agent} | ${duration}s\n${summary}"
```

#### 7. grape_get_pipeline_info

```
presentCall:  {card:"generic", title:"查询流水线进度 ${owner}/${repo} #${number}", kind:"read"}
presentResult: {card:"generic", title:"流水线: ${scene_name}", content:[节点链 Markdown]}
render:       "Pipeline: ${scene_name}\n  vod ✅ → ...\n  sre ⬜ pending\n阶段: ${stage}"
```

节点链格式：
```
vod    ✅ completed   76.5s   重新部署当前的项目
issue  ⬜ pending
coding ⬜ pending
qa     ⬜ pending
sre    ✅ completed   45.0s   部署完成
阶段: vod | 运行中: ✅
```

#### 8. grape_list_issues

```
presentCall:  {card:"generic", title:"查询 Issue ${owner}/${repo}", kind:"search"}
presentResult: {card:"generic", title:"Issue 列表（N 条）", content:[issue 表格 Markdown]}
render:       "找到 N 条 issue: #7 重新部署(运行中), #6 重新部署(待审核), ..."
```

表格列：`| # | 标题 | 场景 | 阶段 | 运行中 | agent 进度 |`

agent 进度列用紧凑格式：`vod✅ sre✅ issue⬜ coding⬜ qa⬜`

#### 9. grape_get_issue_events

```
presentCall:  {card:"generic", title:"查询事件历史 ${owner}/${repo} #${number}", kind:"read"}
presentResult: {card:"generic", title:"事件历史（N 条）", content:[时间线 Markdown]}
render:       "N 条事件:\n  seq=106 vod completed 76.5s\n  seq=105 sre completed 45.0s"
```

---

### B 档：Issue 生命周期 + 查询（10 个）

#### 10. grape_create_issue

```
presentCall:  {card:"generic", title:"创建 Issue: ${title}", kind:"execute"}
presentResult: 省略
render:       "✅ Issue #${number} 已创建，流水线已触发 | task_id=${task_id} | event_seq=${seq}"
```

#### 11. grape_list_my_issues

```
presentCall:  {card:"generic", title:"查询我的 Issue", kind:"search"}
presentResult: {card:"generic", title:"我的 Issue（N 条）", content:[issue 表格 Markdown]}
render:       "找到 N 条 issue: #7 重新部署(运行中), ..."
```

表格同 grape_list_issues。

#### 12. grape_get_issue_detail

```
presentCall:  {card:"generic", title:"查询 Issue 详情 ${owner}/${repo} #${number}", kind:"read"}
presentResult: {card:"generic", title:"Issue #${number}「${title}」", content:[详情摘要 Markdown]}
render:       "Issue #${number}「${title}」\n  状态: ${status} | 阶段: ${stage} | 场景: ${scene_name}\n  运行中: ${is_running} | 事件数: ${events_count}"
```

详情摘要格式：
```
**Issue #7「重新部署当前的项目」**
- 状态: processing | 阶段: vod | 场景: Hello World 部署
- 创建: 2026-09-18 | 运行中: ✅ | PR: 无
- 事件数: 4 | 最新事件: seq=106 (vod, completed)

**Agent 进度:**
- VOD ✅ completed — 重新部署当前的项目
- SRE ✅ completed — 部署完成
- Issue ⬜ pending
- Coding ⬜ pending
- QA ⬜ pending
```

#### 13. grape_cancel_issue

```
presentCall:  {card:"generic", title:"取消 Issue #${number}", kind:"delete"}
presentResult: 省略
render:       "✅ Issue #${number} 已取消"
```

#### 14. grape_resume_issue

```
presentCall:  {card:"generic", title:"恢复 Issue #${number}", kind:"execute"}
presentResult: 省略
render:       "✅ Issue #${number} 已恢复"
```

#### 15. grape_start_issue

```
presentCall:  {card:"generic", title:"启动 Issue #${number}", kind:"execute"}
presentResult: 省略
render:       "✅ Issue #${number} 已启动"
```

#### 16. grape_get_issue_status

```
presentCall:  {card:"generic", title:"查询 Issue 状态 #${number}", kind:"read"}
presentResult: 省略（轻量查询，render 一行够了）
render:       "${status_icon} ${status} | 阶段: ${stage} | #${number}"
```

#### 17. grape_search

```
presentCall:  {card:"generic", title:"搜索: ${query}", kind:"search"}
presentResult: {card:"generic", title:"搜索结果（N 条）", content:[结果表格 Markdown]}
render:       "找到 N 条结果: ..."
```

#### 18. grape_list_repo_events

```
presentCall:  {card:"generic", title:"查询仓库事件 ${owner}/${repo}", kind:"read"}
presentResult: {card:"generic", title:"仓库事件（N 条）", content:[时间线 Markdown]}
render:       "N 条事件:\n  seq=106 vod completed\n  seq=105 sre completed"
```

#### 19. grape_terminate_event

```
presentCall:  {card:"generic", title:"终止事件 seq=${seq}", kind:"delete"}
presentResult: 省略
render:       "✅ 事件 seq=${seq} 已终止"
```

---

### C 档：平台管理 / 上下文增强（15 个）

#### 20. grape_list_skills

```
presentCall:  {card:"generic", title:"查询 Skill 列表", kind:"search"}
presentResult: {card:"generic", title:"Skill 列表（N 个）", content:[表格 Markdown]}
render:       "找到 N 个 skill: vod-strict, issue-advance, implementation, ..."
```

表格列：`| 名称 | 分类 | Agent | 状态 |`

#### 21. grape_get_skill_detail

```
presentCall:  {card:"generic", title:"查询 Skill 详情: ${skill_id}", kind:"read"}
presentResult: 省略（内容是 SKILL.md 文本，render 直接返回）
render:       返回 skill 的 SKILL.md 内容（截断到合理长度）
```

#### 22. grape_search_skills

```
presentCall:  {card:"generic", title:"搜索 Skill: ${query}", kind:"search"}
presentResult: {card:"generic", title:"搜索结果（N 个）", content:[表格 Markdown]}
render:       "找到 N 个 skill: ..."
```

#### 23. grape_list_scenes_for_repo

```
presentCall:  {card:"generic", title:"查询仓库可用场景 ${owner}/${repo}", kind:"search"}
presentResult: {card:"generic", title:"可用场景（N 个）", content:[表格 Markdown]}
render:       "找到 N 个可用场景: ..."
```

#### 24. grape_get_repo_dashboard

```
presentCall:  {card:"generic", title:"查询仓库 Dashboard ${owner}/${repo}", kind:"read"}
presentResult: {card:"generic", title:"Dashboard: ${owner}/${repo}", content:[摘要 Markdown]}
render:       "仓库 ${owner}/${repo}:\n  Issue 总数: N | 运行中: M | 已完成: K\n  Agent 状态: ..."
```

#### 25. grape_get_ops_overview

```
presentCall:  {card:"generic", title:"查询运维概览", kind:"read"}
presentResult: {card:"generic", title:"运维概览", content:[摘要 Markdown]}
render:       "运维概览:\n  仓库: N | 运行中 Issue: M | 在线 Agent: K"
```

#### 26. grape_list_knowledge

```
presentCall:  {card:"generic", title:"查询知识库", kind:"search"}
presentResult: {card:"generic", title:"知识列表（N 条）", content:[表格 Markdown]}
render:       "找到 N 条知识: ..."
```

#### 27. grape_get_knowledge_detail

```
presentCall:  {card:"generic", title:"查询知识详情: ${knowledge_id}", kind:"read"}
presentResult: 省略
render:       返回知识条目内容（截断）
```

#### 28. grape_get_pipeline_roadmap

```
presentCall:  {card:"generic", title:"查询仓库流水线蓝图 ${owner}/${repo}", kind:"read"}
presentResult: {card:"generic", title:"流水线蓝图: ${owner}/${repo}", content:[节点链 Markdown]}
render:       "Pipeline roadmap:\n  vod → issue → coding → qa → sre"
```

#### 29. grape_list_project_templates

```
presentCall:  {card:"generic", title:"查询项目模板", kind:"search"}
presentResult: {card:"generic", title:"项目模板（N 个）", content:[表格 Markdown]}
render:       "找到 N 个模板: ..."
```

#### 30. grape_create_project

```
presentCall:  {card:"generic", title:"从模板创建项目: ${template_id}", kind:"execute"}
presentResult: 省略
render:       "✅ 项目已创建 | repo=${repo} | template=${template_id}"
```

#### 31. grape_get_repo_project_info

```
presentCall:  {card:"generic", title:"查询项目信息 ${owner}/${repo}", kind:"read"}
presentResult: 省略
render:       "项目 ${owner}/${repo}:\n  场景: ${scene} | 知识条目: N | ..."
```

#### 32. grape_list_repos_member

```
presentCall:  {card:"generic", title:"查询我可操作的仓库", kind:"search"}
presentResult: {card:"generic", title:"可操作仓库（N 个）", content:[表格 Markdown]}
render:       "找到 N 个仓库: ..."
```

#### 33. grape_host_repo

```
presentCall:  {card:"generic", title:"纳管仓库 ${repo}", kind:"execute"}
presentResult: 省略
render:       "✅ 仓库 ${repo} 已纳管"
```

#### 34. grape_sync_repos

```
presentCall:  {card:"generic", title:"同步仓库列表", kind:"execute"}
presentResult: 省略
render:       "✅ 仓库列表已同步 | 新增: N | 更新: M"
```

---

## 四、Markdown 格式化函数清单

需要实现的格式化函数（每个返回 ContentBlock[] `{type:"text", text: markdown}`）：

| 函数名 | 输入 | 输出格式 | 用于哪些工具 |
|--------|------|---------|-------------|
| `renderSceneTable` | scenes 数组 | Markdown 表格 | list_scenes, list_scenes_for_repo |
| `renderRepoTable` | repos 数组 | Markdown 表格 | list_managed_repos, list_repos_member |
| `renderIssueTable` | issues 数组 | Markdown 表格 + agent 进度紧凑列 | list_issues, list_my_issues |
| `renderIssueDetail` | issue 对象 | 键值对 + agent 进度列表 | get_issue_detail |
| `renderPipelineNodes` | pipeline 对象 | 节点链 + 阶段 | get_pipeline_info, get_pipeline_roadmap |
| `renderEventTimeline` | events 数组 | 时间线（每事件一行） | get_issue_events, list_repo_events |
| `renderTaskStatus` | event 对象 | 状态行 + 摘要 | get_task_status, wait_task |
| `renderSkillTable` | skills 数组 | Markdown 表格 | list_skills, search_skills |
| `renderKnowledgeTable` | knowledge 数组 | Markdown 表格 | list_knowledge |
| `renderSearchResults` | search 结果 | 混合格式 | search |
| `renderDashboard` | dashboard 对象 | 键值对摘要 | get_repo_dashboard, get_ops_overview |
| `renderTemplateTable` | templates 数组 | Markdown 表格 | list_project_templates |
| `renderActionConfirm` | action 结果 + 工具名 | 一行确认 | trigger/create/cancel/resume/start/host/sync/apply/terminate |

---

## 五、状态图标映射

```
completed  → ✅
failed     → ❌
cancelled  → 🚫
running    → 🔄
pending    → ⬜
processing → 🔄
pending_review → 🔍
```

dsh UI 按 Markdown 渲染 content blocks，emoji 在终端和浏览器都能显示。

---

## 六、代码组织

```
src/
├── index.ts                 — 插件入口（注册 34 个工具）
├── cli-client.ts            — execGrape() 子进程调用（替代 GrapeClient）
├── types.ts                 — 类型定义
├── render/
│   ├── index.ts             — 统一导出
│   ├── helpers.ts           — 共享工具函数（状态图标、截断、格式化）
│   ├── tables.ts            — 表格类渲染（scene/repo/issue/skill/knowledge/template）
│   ├── pipeline.ts          — 流水线类渲染（节点链/蓝图）
│   ├── events.ts            — 事件类渲染（时间线）
│   ├── status.ts            — 状态类渲染（task status/issue status）
│   └── action.ts            — 动作类渲染（一行确认）
├── tools/
│   ├── helper.ts            — makeToolFromConfig() 声明式工厂函数
│   ├── pipeline.ts          — 6 个流水线工具
│   ├── issues.ts            — 10 个 issue 工具
│   ├── scenes.ts            — 3 个场景工具
│   ├── repos.ts             — 5 个仓库工具
│   ├── events.ts            — 3 个事件工具（含 search）
│   ├── skills.ts            — 3 个 skill 工具
│   ├── knowledge.ts         — 2 个知识工具
│   ├── dashboard.ts         — 2 个 dashboard 工具
│   └── project.ts           — 2 个项目模板工具
```

每个工具的配置对象约 10-15 行，包含：
- name / description / parameters
- cliCommand（拼 args 函数）
- renderType（渲染分类）
- presentCall 配置
- presentResult 配置（可选）

---

## 七、验证依据

| 结论 | 依据 |
|------|------|
| presentCall/presentResult 是纯函数 | presentation.d.ts: "Pure and side-effect-free: a UI may call it during live streaming AND a session-log replay" |
| GenericResultView 的 content 字段接受 ContentBlock[] | presentation.d.ts: GenericResultView.content?: ContentBlock[] |
| dsh UI 会按 Markdown 渲染 ContentBlock 的 text | dsh-client-ui-tool/lib/client.js 里 tool 卡片渲染走 markdown 组件 |
| 官方 web_search 用 GenericCallView + WebResultView | dsh-tool-web/lib/index.js: presentSearchCall 返回 {card:"generic"}, presentSearchResult 返回 {card:"web"} |
| 官方 bash 用 TerminalCallView + TerminalResultView | dsh-tool-bash/lib/index.js: presentBashCall 返回 {card:"terminal"} |
| 官方 str-replace-editor 用 DiffCallView，无 presentResult | dsh-tool-str-replace-editor/lib/index.js: presentEditorCall 返回 {card:"diff"} |
| 官方 todo 只用 render 一行摘要，无 presentCall/presentResult | dsh-tool-todo/lib/index.js: render 返回 "Updated todo list: N pending..." |
| ToolCallKind 决定图标 | presentation.d.ts: "Category of a tool call, used by a UI to pick an icon or treatment" |
| presentResult 省略时保持 pending 标题 + 渲染原始结果 | presentation.d.ts: "omitting the method keeps the pending title and renders the raw result content" |
