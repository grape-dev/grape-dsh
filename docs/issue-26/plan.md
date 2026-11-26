# Issue #26 Plan：流水线视图模型收敛

## 设计要点

1. **新增纯函数模块 `src/pipeline-model.ts`**（host + client 共用）：
   - `projectSceneNodes`：投影 `scenes detail` 的 nodes；
   - `buildSceneChain`：按 `next` 链 / `skip` / `enabled` 构造节点链；
   - `extractSegments` / `extractStatusFields` / `extractSceneNodes`：从任意 pipeline 数据取值；
   - `deriveOverall`：业务状态映射（含 `pending_review → 6`）；
   - `buildPipelineView` / `derivePipelineViewFromData`：聚合节点、重试次数、场景外标记、进度不变式。
2. **面板**：`GrapeFocusPanel.tsx` 删除 `PIPELINE_NODES` 固定骨架，`NodeChain` 直接渲染传入节点；
   `pins-store.ts` 的 `pinToFocus` / `pinSummary` 改为消费视图模型。
3. **浏览面板**：`GrapeBrowsePanel.tsx` 的 `PipelineDetail` 复用同一视图模型，保证两处一致。
4. **文本渲染**：`render/pipeline.ts` 按视图模型画框，同一 tag 只画一格；状态码 6 显示「待审核」。
5. **数据补全**：
   - `panel-api.ts` 在 `/pipeline`、`/focus` 返回前补 `scene_id / scene_name / scene_nodes / node_count`；
     `issues detail` 60s 缓存、`scenes detail` 300s 缓存（repo+scene key）。
   - `tools/pipeline.ts` 的 `grape_get_pipeline_info` 通过 `ToolConfig.enrich` 补同样字段。
6. **版本**：`0.5.1 → 0.5.2`（与 #24 同目标版本；若 #24 先合入则沿用，不重复 bump）。

## 测试 seam

- 公开 seam：`derivePipelineViewFromData`（面板/文本共用）与 `renderPipelineCard`（文本输出）。
- 单测直接 import `lib/pipeline-model.js` / `lib/render/pipeline.js`（与现有测试一致，测试前 `npm run build`）。
- 覆盖：1/3/5 节点、skipped、enabled=false、重复 segments、pending_review、场景外节点、
  场景拉取失败退化、状态映射表、文本渲染格数与「场景未知」提示。

## 风险与回滚

- 场景接口失败不影响主链路：只少 `scene_nodes` 字段，UI 显示「场景未知」，仍可用事件段推断。
- 缓存 TTL 与 force 刷新解耦：force 只刷新 pipeline，不风暴式重拉场景。
- 回滚：还原 `pipeline-model.ts` 及相关文件即可，无数据迁移、无服务端契约变更。