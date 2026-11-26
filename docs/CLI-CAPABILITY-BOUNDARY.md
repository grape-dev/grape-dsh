# grape-dsh 插件能力边界分析：CLI 219 个命令的可纳入性评估

> 基于 grape CLI v0.3.3 内置契约快照（OpenAPI v2.1.0，219 个有效 operationId）。
> 全部结论由契约数据 + token scope 规则推导，非推测。

---

## 一、Token Scope 是第一道硬门禁

dsh 插件持有的是 `grape_` 用户级 API Key（`GRAPE_API_TOKEN`），配合 `GRAPE_CLI_MODE=USER`。
CLI 的 token 作用域规则（`src/registry.py:185-193`）：

| Scope | grape_ token 可用 | 说明 |
|-------|-------------------|------|
| dual | ✅ | 两类 token 都行 |
| user_only | ✅ | 用户级操作，session token 会 403 |
| session_only | ❌ 403 | 仅流水线内部 agent 的 tk_ 会话 token |

219 个命令的 scope 分布：

| Scope | 数量 | 占比 | dsh 可用？ |
|-------|------|------|-----------|
| user_only | 173 | 79% | ✅ |
| dual | 18 | 8% | ✅ |
| session_only | 28 | 13% | ❌ |

**结论：191 个命令在 token 层面可用，28 个 session_only 命令直接排除。**

---

## 二、Session_only 命令（28 个，硬排除）

全部是 `git-repo *`（24 个）+ `repos git credential` / `repos workspace` + `tasks current` / `tasks notify`。

这些是 Grape 流水线内部 agent 的专属能力——agent 持有 tk_ 会话 token（由 `event_pipeline.py` 在启动 agent 时注入 env），用来直接操作 GitCode 仓库 API（读文件、创建 PR、写评论等）。

dsh 是外部调用者，不是流水线节点，拿不到 tk_ token。这是服务端 token 模型的设计性限制，与传输方式（HTTP vs CLI）无关。

| 命令组 | 数量 | 用途 | 为什么 session_only |
|--------|------|------|---------------------|
| git-repo * | 24 | 仓库文件/分支/提交/issue/PR/评论的 CRUD | agent 需要直接操作 GitCode，用 Grape 内部注入的 GitCode bot token |
| repos git-credential | 1 | 获取一次性 git 凭据 | agent clone/push 时用 |
| repos workspace | 1 | 获取本地 workspace 路径 | agent 运行时的工作目录 |
| tasks current | 1 | 查当前会话任务 | agent 需要知道自己在哪个 task 里 |
| tasks notify | 1 | 任务分配/通知 | agent 间任务调度 |

**排除原因不是"不重要"，而是"不归 dsh 管"**。这些能力的消费者是流水线内部的 VOD/Issue/Coding/QA/SRE agent，不是 dsh 对话场景。dsh agent 如果需要读仓库文件，应该用自己的工具（terminal / read_file），不需要通过 Grape 绕。

---

## 三、191 个可用命令的分类评估

按"dsh 对话场景下是否需要"分为四档：

### A 档：当前已纳入（9 个）— 核心流水线能力

| 工具 | CLI 命令 | Scope | 理由 |
|------|---------|-------|------|
| grape_list_scenes | scenes market list | user_only | 发现可用场景 |
| grape_apply_scene | scenes apply | user_only | 切换仓库场景 |
| grape_list_managed_repos | repos managed | user_only | 发现纳管仓库 |
| grape_trigger_pipeline | a2a handoff | dual | 触发流水线 |
| grape_get_task_status | events detail | dual | 查任务状态 |
| grape_wait_task | (轮询 events detail) | dual | 等任务完成 |
| grape_get_pipeline_info | issues pipeline | dual | 查流水线节点进度 |
| grape_list_issues | issues list | dual | 列出 issue |
| grape_get_issue_events | issues events | dual | 查事件历史 |

### B 档：建议纳入（10 个）— 补齐 Issue 生命周期 + 查询能力

这些直接对应 IMPROVEMENTS.md 里已识别的改进项，且 grape_ token 可用。

| 拟增工具 | CLI 命令 | Scope | 理由 |
|---------|---------|-------|------|
| grape_create_issue | issues create | user_only | **unified entry**：建 issue + 自动触发流水线，打通"从 0 到跑" |
| grape_list_my_issues | issues mine | user_only | 不用知道 owner/repo 就能看自己的 issue |
| grape_get_issue_detail | issues detail | dual | 单个 issue 详情（含 stage/events/pipeline 聚合） |
| grape_cancel_issue | issues cancel | user_only | 取消 issue（停止流水线） |
| grape_resume_issue | issues resume | user_only | 恢复已取消的 issue |
| grape_start_issue | issues start | user_only | 打开 issue 会话（推进流水线） |
| grape_get_issue_status | issues status get | dual | 轻量状态查询（比 events detail 更轻） |
| grape_search | search global | user_only | 全局搜索 issue/repo/skill |
| grape_list_repo_events | events list | user_only | 仓库级事件列表（跨 issue） |
| grape_terminate_event | events terminate | user_only | 强制终止单个 event（比 cancel 更细粒度） |

**纳入原则：** 推进类（start/resume）与"只触发、只观察"原则一致——触发和推进都是把任务丢给 Grape 跑。终止类（cancel/terminate）属于干预决策，建议加但配确认提示。

### C 档：可选纳入（15 个）— 平台管理 / 上下文增强

dsh 对话中偶尔有用，但不是核心路径。按需纳入。

| 拟增工具 | CLI 命令 | Scope | 场景 |
|---------|---------|-------|------|
| grape_list_skills | skills list | dual | 查看可用 skill 列表 |
| grape_get_skill_detail | skills detail | dual | 查看某 skill 的 SKILL.md |
| grape_search_skills | skills search | user_only | 搜索 skill |
| grape_list_scenes_for_repo | scenes with pipeline | user_only | 查仓库可用的场景列表（替代已移除的 get_repo_scene） |
| grape_get_repo_dashboard | dashboard repo | user_only | 仓库级 dashboard（issue 统计/agent 状态聚合） |
| grape_get_ops_overview | dashboard ops overview | user_only | 全局运维概览 |
| grape_list_knowledge | knowledge list | dual | 项目知识列表 |
| grape_get_knowledge_detail | knowledge detail | dual | 知识条目详情 |
| grape_get_pipeline_roadmap | pipeline get | user_only | 仓库级流水线蓝图（不针对单个 issue） |
| grape_list_project_templates | project templates list | user_only | 可用项目模板 |
| grape_create_project | project template create | user_only | 从模板创建项目 |
| grape_get_repo_project_info | repos project info | dual | 仓库项目信息 |
| grape_list_repos_member | repos member | user_only | 我能操作的仓库列表 |
| grape_host_repo | repos host | user_only | 纳管新仓库 |
| grape_sync_repos | repos sync | user_only | 从 VCS 同步仓库列表 |

### D 档：不建议纳入（145 个）

| 命令组 | 数量 | 排除理由 |
|--------|------|---------|
| settings * | 35 | 平台配置管理（API Key/OAuth/通知/执行模式/凭据）。属管理员操作，不该暴露给 dsh agent。dsh 的 pre-execute 虽然能拦截，但工具描述里列 35 个 settings 命令会严重干扰模型选工具。 |
| scenes market * (create/update/delete/icon-upload/like/experience) | 10 | 场景市场管理操作。dsh agent 不应该创建/删除/编辑场景市场条目。 |
| scenes advanced options * | 2 | 场景高级配置，属场景开发/管理范畴。 |
| scenes create/update/delete | 3 | 场景 CRUD，属平台管理。 |
| scenes branches/branch_create/check_name | 3 | 场景分支管理，开发场景时用。 |
| scenes skills_for_agent | 1 | 查某 agent 类型的 skill，属平台运维调试。 |
| runtime * | 17 | 运行时管理（机器健康/会话/任务列表/标签/凭据/批量恢复）。属 SRE 运维范畴，dsh agent 不需要。 |
| chat * | 14 | Chat 对话功能。dsh 自己就是对话 agent，不需要调 Grape 的 chat API。功能重叠。 |
| events chat * (send/stream/submit/delete) | 4 | 事件级对话，agent 运行时用的交互通道。dsh 不在事件上下文里。 |
| events chat_task * | 2 | 事件对话的异步任务状态/流。同上。 |
| events knowledge_delete | 1 | 删除 issue 知识，属 agent 运行时操作。 |
| events redispatch | 1 | 重发事件，属运维调试。 |
| events thread | 1 | 事件对话线程，属 agent 运行时。 |
| task logs * | 3 | 任务运行时日志/消息/流。属 agent 调试，dsh 用 events detail 已经能看到结果。 |
| tasks complete | 1 | agent 自报完成。只有流水线内部 agent 会调。 |
| devstage * | 8 | 开发环境管理（DevStage）。独立功能域，目前 dsh 不涉及。 |
| feishu * | 3 | 飞书集成。独立功能域。 |
| agents * (detail/update/clean) | 3 | Agent 配置管理。属平台管理。 |
| auth * | 2 | 认证操作（登出/查 profile）。dsh 用 API Key，不走 JWT 登出。 |
| repos bot_token * | 2 | 仓库 bot token 管理。属安全敏感操作。 |
| repos create/remove/repair_host/sync/deploy_url * | 6 | 仓库生命周期管理。除 host/sync 外不常用。 |
| repos scene_recommend_config * | 2 | 场景推荐配置。属平台调优。 |
| repos check_name | 1 | 仓库名检查。创建仓库时的辅助。 |
| knowledge * (create/update/delete/refs *) | 7 | 知识 CRUD。dsh 只读知识就够了（C 档已纳入只读）。 |
| skills * (upload/delete/convert/download/like/categories/featured/stats/agent_stats/package_sub) | 10 | Skill 管理。dsh 只读 skill 就够了。 |
| issues * (clarify/confirm_done/status_put/upload_attachment/delete_attachment/clarifications) | 6 | Issue 高级操作。clarify/confirm_done 是 agent 运行时交互通道，dsh 不在 issue 会话里。status PUT 是强制改状态，有风险。 |
| issues pipeline_detail | 1 | 按 issue.id 查 pipeline（当前用 issues pipeline 按 owner/repo/number 查，已够用）。 |
| scenes list | 1 | 仓库自定义场景列表（实测返回空，不用）。 |
| scenes market applied/detail/categories/experience_check | 4 | 场景市场辅助查询。低价值。 |
| scenes market_apply | 1 | 通过 market_id 应用场景（当前用 scenes apply by owner/repo 已够用）。 |

---

## 四、能力边界总结

```
219 个 CLI 命令
  ├── 28 个 session_only → 硬排除（tk_ token 门禁，dsh 拿不到）
  └── 191 个 grape_ 可用
       ├── A 档：9 个（当前已纳入）         — 核心流水线触发/观察
       ├── B 档：10 个（建议纳入）          — Issue 生命周期 + 查询补齐
       ├── C 档：15 个（可选纳入）          — 平台管理 / 上下文增强
       └── D 档：145 个（不建议纳入）       — 管理配置 / 功能重叠 / 运维调试
```

**最大可行工具集 = A + B + C = 34 个**

但 34 个工具对模型选择是个负担——工具越多，模型选错的概率越大。建议：

| 阶段 | 工具数 | 范围 |
|------|--------|------|
| 当前 | 9 | A 档 |
| 第一期扩展 | 19 | A + B |
| 第二期扩展 | 34 | A + B + C |

---

## 五、设计原则约束

以下原则从原始设计文档继承，用于约束新增工具的边界：

1. **只触发、只观察、不干预节点间交接**：A2A handoff 是唯一触发入口，不暴露节点间 A2A 调度。cancel/terminate 属于"用户决策停止"，不是"干预节点间交接"，可以加但配确认。

2. **不代理 GitCode 操作**：session_only 的 git-repo * 命令全部排除。dsh agent 如果需要读仓库文件、创建 PR，应该用自己的工具（terminal/read_file/git），不通过 Grape 绕。

3. **危险操作配确认**：cancel/terminate/host_repo/create_project 等有副作用的操作，建议利用 dsh 的 `tools/pre-execute` + `approval/policy: ask` 要求确认。

4. **工具描述精确**：每个工具的 description 要写清"什么时候用"和"有什么副作用"，帮模型在 19-34 个工具里准确选择。

5. **增删工具必须同步"人写数字"**：README 工具表 → locale/en.json → locale/zh.json → cordis.patch.yml 注释 → src/index.ts 顶部注释 → apply() 末尾 console.log。

---

## 六、验证依据

| 结论 | 依据 |
|------|------|
| 219 个有效 operationId | grape CLI v0.3.3 内置 `src/data/openapi.json`，info.version=2.1.0 |
| 28 个 session_only | 契约 x-token-scope 字段统计 |
| grape_ + GRAPE_CLI_MODE=USER 可用 191 个 | CLI `src/registry.py:185-193` allowed_by_mode() + `src/config.py:64-66` USER 模式优先 GRAPE_API_TOKEN |
| 9 个当前工具全部在 191 个可用范围内 | 实跑验证（2026-10-15，4 个只读命令 200 OK） |
| issues create 是 unified entry | 契约 summary: "Create issue (unified entry)"，Grape 源码 `src/api/routes/issues.py:1343` 注释 |
| issues mine 不需要 owner/repo | 契约 path: `/api/issues/mine`，无 path 参数 |
| git-repo * 全部 session_only | 契约 x-token-scope=session_only，CLI `src/registry.py:174` gitrepo_ 前缀也强制 session_only |
| settings * 35 个全 user_only | 契约 x-token-scope 统计 |
