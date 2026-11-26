# Issue #26 Spec：流水线节点链 / 整体状态 / 进度口径对齐

> 目标合入分支 `dev-ch-11`（基线 `f535462`）| 里程碑 v0.5.2 | 优先级 P1
> 完整原始 Spec 见 Issue #26 评论（id 202085116），本文为实现口径摘要。

## Objective

插件面板与文本渲染的「节点链 / 整体状态 / 进度」改以 Grape 服务端业务字段为准，消除：

1. 面板显示「已完成」，Grape 侧仍在 qa/sre（顶层 `status` = 事件跑完，不代表需求完成）；
2. 节点链写死 5 格，1 节点/3 节点场景仍画 5 格；
3. 进度分子分母按事件段条数（重派会重复计数），分母与格数不一致。

## 口径（唯一真源：`src/pipeline-model.ts`）

### 1. 节点链以场景为准

- pin 的 issue → `scene_id`（`issues detail`）→ `grape scenes detail --scene_id <id> --repo <owner>/<repo>` 的 `nodes`；
- 按场景 `next` 链渲染，`next=done/空` 终止；`enabled=false` 不进入链；
- 节点出现在其他节点的 `skip` 列表 → 展示为「已跳过」；
- 场景拉取失败 → 退化为 `segments` 首次出现顺序，并标注「场景未知，按事件推断」；
- **禁止写死 5 节点**。

### 2. 整体状态以业务字段为准

| 服务端字段 | 展示语义 | 状态码 |
|---|---|---|
| `issue_task_status=completed` 或 `issue_stage=done` | 已完成 | 2 |
| `pending_review`（`issue_task_status` / `review_status`） | 待审核 | 6 |
| `active` / `processing` / `running` | 进行中 | 1 |
| `failed` | 失败 | 3 |
| `cancelled` / `canceled` | 已取消 | 4 |
| 场景内未跑过的节点 | 待开始 | 0 |
| 节点 skip / skipped | 跳过 | 5 |
| pipeline 顶层 `status` | 仅「本次事件是否跑完」附属提示，**不参与整体判定** | — |

服务端未返回业务字段时，才退化为按事件段推断，并在详情里注明「按事件推断」。

### 3. 节点聚合

- 同一 tag 多次出现（重派/重试）按 **seq 最大**那条取状态；
- 链上只占一格，并显示「重试 N 次」（N = 出现次数 - 1）；
- 场景外节点照常显示并标「场景外」。

### 4. 进度

- 分子 = 已 completed 的格数；
- 分母 = 渲染格数（= 场景节点去重数；无场景数据时为去重后的事件段数）；
- 不变式：`done ≤ total` 且 `total == 节点格数`；
- `pending_review` 会把当前阶段节点的**徽标**改为「待审核」，但进度不回退（进度回答「走到第几格」）。

### 5. 文本渲染与工具返回

- `render/pipeline.ts` 的流水线卡片按场景节点输出，同一 tag 不重复画框；
- `grape_get_pipeline_info` 的结果附带 `scene_id / scene_name / scene_nodes / node_count`；
- `issues pipeline` 本身已带 `issue_stage / issue_task_status / review_status`，不再依赖顶层 `status`。

### 6. 缓存与刷新

- 场景节点按 `repo + scene_id` 缓存 5 分钟（宿主代理层）；`issues detail` 的 `scene_id` 缓存 60 秒；
- issue 换场景 → `scene_id` 变化 → 缓存自然失效；
- 保留 60 秒加速轮询与 20 秒常规轮询。

## In Scope

`src/pipeline-model.ts`（新增）、`src/client/GrapeFocusPanel.tsx`、`src/client/pins-store.ts`、
`src/client/GrapeBrowsePanel.tsx`（浏览面板复用同一节点链）、`src/render/pipeline.ts`、`src/types.ts`、
`src/focus.ts`（状态码 6 = 待审核）、`src/panel-api.ts`（pipeline 结果补场景节点）、`src/tools/pipeline.ts`
与 `src/tools/helper.ts`（工具结果补场景节点）、测试、docs 与版本补丁位。

## Out of Scope

- 不改 Grape 服务端，不改 33 个 `grape_*` 工具的入参契约；
- 不改 #24 的 README 安装章节与 `skills/`；
- 不改 #25 的 `src/local-runtime.ts`、`src/worker-onboard.ts`、`src/client/GrapeMachinePanel.tsx`、
  `src/index.ts` 的 `/check` 路由。

## Acceptance Criteria

- [ ] #22 卡片显示「qa · 待审核（pending_review）」而非已完成，节点链 5 格、进度 4/5
- [ ] #21 只显示 1 个节点（vod），进度 1/1
- [ ] #25 显示 5 格，进度随 segments 推进（2 进行中 + 1 已完成）
- [ ] 模拟场景拉取失败：退化为 segments 顺序并标注「场景未知」，不退回写死 5 节点
- [ ] 重派场景：同节点只占一格且带重试徽标，分母与格数一致
- [ ] `npm run typecheck` 与 `npm test` 通过（基线 176 tests / 1 skipped，只增不减）
- [ ] 真实数据对照结论写入 PR