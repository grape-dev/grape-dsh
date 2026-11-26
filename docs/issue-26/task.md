# Issue #26 Task：验收条款 → 代码位置 → 测试

| 验收条款 | 代码位置 | 测试 |
|---|---|---|
| 节点链按场景节点渲染，禁止写死 5 节点 | `src/pipeline-model.ts` `buildSceneChain`；`GrapeFocusPanel.tsx` `NodeChain` | `pipeline-view.test.mjs`：1/3/5 节点 |
| 场景 `skip` 节点显示为已跳过 | `buildSceneChain`（其他节点 skip 列表命中） | 「场景内 skipped」 |
| `enabled=false` 不进入链 | `buildSceneChain` | 「enabled=false 的节点不进入链」 |
| 同 tag 多次出现只占一格 + 重试 N 次 | `buildPipelineView` 聚合（seq 最大） | 「重复 segments」「文本渲染：重复节点只画一格」 |
| 场景外节点照常显示并标记 | `buildPipelineView`（`outsideScene`） | 「场景外节点」 |
| 整体状态按 `issue_task_status` / `review_status` / `issue_stage` | `deriveOverall` | 「整体状态映射表」 |
| `pending_review` 不退化为 pending | `focus.ts` `statusToNum` → 6；`pipeline-model` 徽标 | 「状态码：pending_review → 6」「5 节点 + pending_review」 |
| 顶层 `status` 不参与整体判定 | `deriveOverall`（仅事件级提示） | 「整体状态映射表」最后一条 |
| 进度 done ≤ total 且分母 = 格数 | `buildPipelineView` `done/total` | 各节点测试 + `done <= total` 断言 |
| 场景拉取失败退化为事件段顺序并标注 | `buildPipelineView`（sceneUnknown）；面板与文本提示 | 「场景拉取失败」「文本渲染：场景未知」 |
| 文本渲染按场景节点输出 | `render/pipeline.ts` `renderPipelineCard` | 两个文本渲染用例 |
| 面板缓存与 60s 加速轮询 | `panel-api.ts` `SCENE_TTL_MS` / `attachScene`；`pins-store.ts` 轮询不变 | 手动/真实数据验证（见 PR） |
| 版本补丁位 | `package.json` / `package-lock.json` → 0.5.2 | `npm run typecheck` / `npm test` |

## 验证记录

- `npm run typecheck`：通过（`tsc --noEmit` + `tsc -p tsconfig.client.json`）。
- `npm test`：190 tests / 189 pass / 1 skipped / 0 fail（基线 176 / 175 / 1 / 0，只增不减）。
- 真实数据对照见 PR 描述。