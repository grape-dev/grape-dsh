# Issue #28 Spec：实时面板空态引导 + 自动预览

> 目标合入分支 `dev-ch-11`（基线 `f535462`）| 优先级 P1
> 完整原始 Spec 见 Issue #28 评论（id 202091004），本文为实现口径摘要。

## Objective

让「实时」页签在无观察项时不再空白：空态给出可点击引导直达「浏览」，并默认自动预览
一条当前仓库最近活跃的 issue（可固定为正式 pin、可换一条）。预览**绝不落盘**，
不污染 `pins` 存储；固定一次即可持久观察。

## In Scope

1. `src/client/GrapeFocusPanel.tsx` 仅**追加**三块组件：
   - 空态引导卡（主按钮 `setMode('browse')`；次按钮一键钉住当前仓库最近活跃 issue）；
   - 「观察中 (n)」右侧「+ 添加」；
   - 预览卡（虚线边框 +「自动」徽标，复用 `FocusBody` 渲染）。
2. 新增 `src/client/preview-store.ts`：预览状态与选择规则，**不落盘**，不改 `pins-store` 既有导出。
3. 纯选择逻辑抽到 `src/preview-select.ts`（沿用 `pins-persist.ts` 的「纯逻辑可单测」先例），
   `preview-store.ts` 只做浏览器侧组装。
4. `src/client/browse-store.ts`：新增只读「当前仓库」/「/issues 缓存」选择器，复用既有缓存，
   **不新增网络请求**。
5. 测试：选择规则三态（无仓库 / 无 issue / 失败）、预览不写 localStorage、8 条上限时预览让位、
   点图钉后预览让位（替换/追加语义）。

## Out of Scope / 并行约束（与 #24–#27 同跑）

- 不改 `NodeChain`、`PIPELINE_NODES`、`pinToFocus`、`pinSummary` 与节点状态映射（归 #26）。
- 不动 `panel-api.ts` / `browse-store` fetch 路径（#27）、`local-runtime` / `worker-onboard` /
  `MachinePanel` / `index.ts` 的 `/check`（#25）、README 安装章节与 `skills/`（#24）。
- 预览卡不参与拖拽排序、不新增 timer（复用 pins 现有 20s 轮询与 150ms 错峰语义）、不弹窗、
  不自动切 tab。
- 不新增网络请求：预览的 issue 选择来自 `/issues` 缓存；预览卡主体只在对应流水线已缓存时用
  `FocusBody` 渲染，否则给紧凑摘要（不触发拉取）。

## 选择规则（实现契约）

输入：当前仓库 `{owner, repo, platform?}`、该仓库 `/issues` 缓存数据/错误、当前 pin 数。

1. 未选仓库 → `no-repo`（空态文案「先去浏览选一个仓库」）。
2. 拉取失败（`error` 非空）→ `error`（空态文案「拉取失败 · 重试」）。
3. 仓库无 issue（列表为空/无合法编号）→ `no-issue`（「这个仓库还没有 issue」）。
4. pin 数达上限（`MAX_PINS`）→ `full`（预览让位，不显示）。
5. 有候选时：**优先 `status=processing`（或 `is_running=true`）**；同优先级按
   `latest_event.created_at` 最近优先，缺失/非法时按 `latest_event.seq`、issue 号兜底。

## Acceptance Criteria

- [ ] 空 pins 首次打开实时：立即见引导卡；主按钮直达浏览；次按钮把当前仓库最近活跃 issue 加入观察。
- [ ] 有 issue 时出现「自动」预览卡；localStorage 无该预览记录；刷新后正式 pin 仍在、预览按规则重选。
- [ ] 「固定为观察」后转正式 pin 并持久化，预览徽标消失、可拖拽。
- [ ] 浏览中点图钉：无正式 pin 时替换预览，有 pin 时追加，超 8 条有明确提示。
- [ ] 不新增网络请求；`npm run typecheck` 通过；`npm test` 基线 176 tests / 1 skipped，只加不减。

## 版本约定

沿用 `dev-ch-11` 分支最高版本（并行 #24/#25 已到 `0.5.2`），本 Issue **不重复 bump**；
`docs/RELEASE-RECORD.md` 只补 Issue #28 一条开发分支记录（未出包，不记录虚构产物）。