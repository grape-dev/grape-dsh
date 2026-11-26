# 能力缺口与待办

> grape-dsh 插件设计过程中发现的 Grape 平台能力缺口，记录待 Grape 侧决策。

## 缺口 1：无法查询仓库「当前激活的流水线场景」

### 现状

| 能力 | 状态 | dsh 工具 |
|------|------|---------|
| 列出可用场景 | ✅ | `grape_list_scenes` |
| 切换场景 | ✅ | `grape_apply_scene` |
| 查询仓库当前用的场景 | ❌ | （无，曾设计 `grape_get_repo_scene` 已移除） |

### 根因

Grape 的「仓库绑定单一场景」模型已经退役：

- `managed_repos.dev_scene` 字段**已退役**（`src/api/routes/dashboard.py:1077` 注释：「dev_scene 已退役，始终为空」）
- 前端现在的做法：返回仓库可见场景列表 `_scenes`，自动选第一个作为「当前场景」
- 没有 REST 端点返回「当前激活场景」这个语义

### 影响

- dsh 插件去掉了 `grape_get_repo_scene` 工具（10 → 9 个），因为没有可靠数据源
- 模型想知道「这个仓库现在跑的是什么流水线」时，只能靠 `grape_get_pipeline_info`（查具体 issue 的流水线节点）反推

### 可能的解法（需 Grape 侧决策，非本插件范围）

1. 给 `GET /api/repos/managed` 返回加一个 `current_scene` 字段（读 `managed_repos.dev_scene`，或按前端「选第一个」逻辑推导）
2. 恢复 `dev_scene` 语义，重新成为「仓库当前激活场景」的权威字段
3. 新增专用端点 `GET /api/repos/{owner}/{repo}/scene` 返回当前场景

### 记录时间

2026-10-13

---

## 缺口 2：`grape_get_issue_events` 对「已归档」issue 返回空

### 现象

- `GET /api/issues/{owner}/{repo}/{number}/events`（插件 `grape_get_issue_events` 用）对 issue #6 返回 `{"events": [], "total": 0}`
- 但同一 issue 的 `GET /api/issues/{owner}/{repo}/{number}/pipeline`（插件 `grape_get_pipeline_info` 用）却能返回完整分段（vod 段 seq 65 的结论全文）
- 对 issue #7 则两边都有数据（events 表里有 seq 103/104/105）

### 根因

两个端点的**数据源不同**：

| 端点 | 数据源 | 归档 issue |
|------|--------|-----------|
| `/events` | `events` 表，按 `issue_id` 分组（`_group_events_by_issue`） | ❌ 空 |
| `/pipeline` | 先 `_pipeline_from_archive`（读 `event.json` 归档），再降级到 events 表 | ✅ 有 |

实测本地 DB：`events` 表总共只有 4 行（`gitcode:wdmike/snake-game-0915` 只有 `#7` 的 3 行 seq 103-105）；issue #6 的历史只存在于 event.json 归档（`/root/grape-workspaces/gitcode/wdmike/snake-game-0915/issues/6/event.json`）。

### 影响

模型用 `grape_get_issue_events` 排查「这个 issue 的流水线做了什么」时，对早期/归档 issue 会得到「无事件」的错误印象。`grape_get_pipeline_info` 不受影响。

### 可能的解法（需 Grape 侧决策，非本插件范围）

1. `/events` 端点补一条归档回退（`_pipeline_from_archive` → 转成 events 列表）
2. 或让插件 `grape_get_issue_events` 改走 `/api/issues/{issue_id}/pipeline`（但那个端点按 `issue.id` 而非 `issue_number` 定位，插件当前拿不到 id）

### 记录时间

2026-10-13

---

## 缺口 3：`grape_list_managed_repos` 描述与实际返回不符

工具 description 写着「including their current pipeline scene」，但 `GET /api/repos/managed` 实际只返回：
`repo_key / full_name / role / webhook_ok / branch / status / has_bot_token` —— **没有 scene 字段**。

这会诱导模型以为拿到了场景信息而编造。两种处理：
1. 改 description（去掉 "current pipeline scene" 说法）
2. 或在 Grape 侧给该端点加 `current_scene` 字段（与缺口 1 是同一个需求）

本缺口与缺口 1 同根：Grape 没有「仓库当前场景」的权威数据源。

### 记录时间

2026-10-13
