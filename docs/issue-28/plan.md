# Issue #28 方案设计（Plan）

## 方案概述

把「选哪条 issue 作预览」做成**纯函数**（`src/preview-select.ts`），浏览器侧 store 只负责
取缓存、组装 state 与触发动作（`src/client/preview-store.ts`）。沿用仓库既有 seam：
`pins-store.ts` 把纯逻辑抽到 `pins-persist.ts` 后由 Node 单测覆盖，本次同构。

```
/issues 缓存 (browse-store.state) ──┐
当前仓库 (browse-store.stack)      ──┼─▶ preview-select.pickPreviewIssue (纯)
pin 数 (pins-store.getPins)        ──┘        │
                                             ▼
                                  preview-store (React hook + 动作)
                                             │
                                             ▼
                               GrapeFocusPanel（引导卡 / 预览卡 / + 添加）
```

## 实现路径

1. **先立契约（红）**：`test/preview-select.test.mjs`
   - 三态：无仓库 / 无 issue / 拉取失败；
   - 规则：processing 优先、其次 `latest_event.created_at` 最近、缺失时 seq 兜底；
   - 上限：pin 数 = 8 时返回 `full`（预览让位）；
   - 预览让位：`shouldShowPreview(0)=true`，`>=1` 为 false（点图钉后预览消失，正式 pin 追加）；
   - 静态护栏：`src/client/preview-store.ts` 不出现 `localStorage` / `PINS_STORAGE_KEY`（预览不落盘）。
2. **纯选择逻辑（绿）**：新增 `src/preview-select.ts`，无 React / DOM / 网络依赖。
3. **只读选择器**：`browse-store.ts` 新增 `currentRepo()` 与 `cachedIssues(owner, repo, platform?)`，
   只读 `stack` 与 `state`，不调用 `fetchView`。
4. **浏览器侧 store**：`preview-store.ts`
   - `usePreview()`：`usePins()` + `useBrowse()` 变化时重算，返回 `{ repo, pick, visible, focus }`；
   - `pinPreview(issue)`：走既有 `addPin`（持久化/上限提示复用既有语义）；
   - `openBrowse()`：`setMode('browse')`；
   - `focus` 只在对应 pipeline 已缓存时用 `pinToFocus` 组装，交给 `FocusBody` 渲染（不触发请求）。
5. **面板追加三块组件**（只追加，不动 NodeChain/状态映射）：
   - `EmptyGuideCard`：两种按钮 + 三种空态文案；
   - `PreviewCard`：虚线边框 +「自动」徽标 + `FocusBody`（有缓存）或紧凑摘要 +「固定为观察 / 换一条」；
   - `PinnedIssues` 标题行右侧「+ 添加」。
6. **自检**：`npm run typecheck`、`npm test`（176 → 只增不减）、增量敏感扫描。

## 关键取舍

- **不新增请求**：不做「预览也去拉 `/pipeline`」；预览卡有缓存则完整渲染，无缓存给紧凑摘要。
  这与 `#26` 的节点链改动解耦，也不会在首次打开实时时凭空 spawn 子进程。
- **不改 `pins-store` 导出**：预览只消费 `getPins/usePins/addPin/pinToFocus/MAX_PINS/setNotice`。
- **预览不参与排序/不落盘**：预览卡独立渲染，不进 `pins` 数组；测试静态断言 store 无 storage 写入。
- **上限让位**：`pickPreviewIssue` 在 `pinCount >= maxPins` 时返回 `full`；预览常显条件再叠加
  「无正式 pin」，双重保证不与 8 条正式卡争位置。

## 测试 seam

| 切片 | 公开接口 | 测试 |
|------|---------|------|
| 选择规则 | `pickPreviewIssue(input)` | `test/preview-select.test.mjs` |
| 预览显隐 | `shouldShowPreview(pinCount)` | 同上 |
| 不落盘 | `src/client/preview-store.ts` 源码 | 静态断言（沿用 package-identity 先例） |