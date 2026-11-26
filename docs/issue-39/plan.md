# Issue #39 方案设计（Plan）

## 方案概述

以「编号即字符串」为唯一口径，从宿主投影 → 路由校验 → 客户端全链路一次性收敛，
并在客户端各消费点把数字判定换成非空判定。

## 实现路径

1. `src/issue-number.ts`（新增，**编号口径唯一出处**）
   - `ISSUE_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/`；
   - `isValidIssueNumber()`（白名单 + 拒绝 `"0"`）/ `normalizeIssueNumber()`（缺失、空、
     非法归空串）；
   - `parseIssueRef()` / `formatIssueRefForModel()` / `extractIssueNumberFromText()`
     （`@` 引用反解与创建后自动 pin 的编号解析，纯函数、可单测）。
   `panel-api.ts` 的投影与路由改引用它（`isValidIssueNumber` 仍从 panel-api 转导出），
   `projectIssues()` 的 `issue_number` 改为字符串（GitCode 整数 `String(v)`）；
   路由 `number` 参数改用同一白名单（原 `DIGITS_RE` 删除），非法仍 400。
2. `src/types.ts`：`GrapeIssue.number` / `issue_number` 放宽为 `string | number`，
   如实描述两平台原始数据（面板投影统一为 string）。
3. `src/client/browse-store.ts`：`BrowseView.pipeline.number`、`eventsKey/ensureEvents/
   eventsFor/fetchPipelineFocus` 改 `string`。
4. `src/client/pins-store.ts`：`Pin.number` / `pinId` / `hasPin` / `addPin` / `togglePinFor`
   改 `string`，加入/切换校验改走 `isValidIssueNumber`（非法编号直接 `invalid`）。
5. `src/pins-persist.ts`：`PersistedPin.number` 改 `string`，读取时把旧存档数字归一到
   共享口径（`"0"` / 空 / 非法视为损坏存档）。
6. `src/preview-select.ts`：`PreviewIssue.number` 改 `string`，候选过滤走共享归一，
   编号排序兜底：纯数字按数值、字母数字按字典序。
7. `GrapeBrowsePanel.tsx` / `grape-mention.ts` / `GrapeToolView.tsx`：编号按字符串透传；
   `@` 引用与自动 pin 的编号解析改走共享模块（不再内联正则）；无编号的行不可钻取、
   pin 置灰。`preview-store.ts` / `GrapeFocusPanel.tsx` **已核对无需改动**（本就按字符串透传）。
8. `src/render/action.ts`：动作确认行编号改按字符串取值（`parseInt` 会吃掉 `IKXR3B`），
   `"0"` / 空 / 非法仍不展示。
9. 测试：5 类用例（数字 / 字母数字 / `"0"` / 缺失 / 两平台归一）+ 400 回归 +
   编号口径单点（含源码扫描：白名单只在一处、客户端不得内联数字正则）+ 动作确认行展示。
10. 文档：`docs/issue-39/gitee-issue-number.md` 记录 Gitee 编号形态与改动点。

## 关键设计决策

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 编号类型 | number / string | string | Gitee 字母数字只能由 string 承载，GitCode 可无损转字符串 |
| 缺失处理 | 归零 / 空串 | 空串 | 避免 `number=0` 触发 404 与错误缓存命中 |
| 校验 | 仅数字 / 字母数字白名单 | 字母数字白名单 + 拒绝 `"0"` | 兼容 Gitee，同时保留 400 防线 |
| 缓存键 | 数字 / 字符串 | 字符串 | 两平台同号不串、字母数字不塌成 0 |

## 影响范围

宿主投影与路由、客户端浏览/观察/预览/引用/接管全链路、pins 存档、文档与测试。
CLI / 服务端 / 工具通道不在范围内（已正常）。