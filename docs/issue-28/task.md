# Issue #28 任务拆解与验收对照（Task）

> 目标合入分支 `dev-ch-11`；开发分支 `feat/issue-28`。
> TDD：先提交失败用例（`test/issue-28`），再提交实现使其通过（`feat/issue-28`）。

## 切片

| # | 切片 | 交付物 | 测试 seam | 状态 |
|---|------|--------|-----------|------|
| 1 | 失败用例先行 | `test/preview-select.test.mjs` | 纯选择器 + 静态不落盘断言 | 完成（`3738af2`，11 例先红） |
| 2 | 选择规则 | `src/preview-select.ts` | `pickPreviewIssue` / `shouldShowPreview` | 完成 |
| 3 | 只读缓存选择器 | `src/client/browse-store.ts`（`currentRepo` / `cachedIssues`） | 不新增请求（人工审查） | 完成 |
| 4 | 预览状态 | `src/client/preview-store.ts` | 静态不落盘 + 复用 pins 动作 | 完成 |
| 5 | 面板三块组件 | `src/client/GrapeFocusPanel.tsx` | 人工核对 + typecheck | 完成（空态引导卡 / 预览卡 / + 添加） |
| 6 | 回归 | `npm run typecheck` / `npm test` | 命令输出 | 完成（typecheck 通过；187 tests / 186 pass / 1 skip） |
| 7 | 文档与发布记录 | `docs/issue-28/*` + `docs/RELEASE-RECORD.md`（1 条） | 人工核对 | 完成 |

## 验收对照

| AC | 实现点 | 证据 |
|----|--------|------|
| 空 pins 立即见引导卡；主按钮直达浏览；次按钮钉住最近活跃 | `EmptyGuideCard` + `setMode('browse')` + `pinPreview` | typecheck / 人工核对 |
| 有 issue 出现「自动」预览卡；不写 localStorage | `PreviewCard` + 静态不落盘测试 | `preview-store.ts` 静态断言 |
| 固定为观察转正式 pin、可拖拽 | `pinPreview` → `addPin`（既有持久化/排序） | pins-store 既有语义 |
| 浏览点图钉：替换预览 / 追加 / 超 8 提示 | 预览 `pinCount>0` 即隐藏；`addPin` 上限返回 `full`；浏览图钉置灰 + tooltip | `shouldShowPreview` 测试 |
| 不新增请求；typecheck；tests 只加不减 | 预览不拉 `/pipeline`；基线 176 tests / 1 skipped | `npm test` 输出 |