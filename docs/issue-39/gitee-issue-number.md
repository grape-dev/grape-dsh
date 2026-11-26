# Gitee Issue 编号形态与面板兼容（Issue #39）

> 供后续接入其它代码平台时复用：**issue 编号是平台相关的不透明标识，不是整数**。

## 各平台编号形态（2026-11-24 实测）

| 平台 | `issue_number` / `number` 原始类型 | 示例 | 备注 |
|------|-----------------------------------|------|------|
| GitCode | 整数（Int） | `32` | 面板从此按数值排序/展示的习惯来源 |
| Gitee | 字母数字字符串 | `IKXR3B` | 大小写敏感；`parent_issue_number` 为 `"0"` 占位 |
| GitHub | 整数 | `42` | 预期同 GitCode |
| GitLab | 整数 iid | `7` | 预期同 GitCode |

`"0"` 不是合法 issue 编号：Gitee 用它表示「非子任务」的父编号占位，任何来源出现 `"0"`
都必须当作「无编号」，不得进入详情/流水线/pin 链路。

## 兼容约定（本插件）

1. **类型**：面板内部编号一律 `string`；GitCode 整数在宿主投影时 `String(v)` 归一。
   客户端 `BrowseView.pipeline.number`、`Pin.number`、`PersistedPin.number`、
   `PreviewIssue.number` 均为 `string`。
2. **归一**：字符串去首尾空白；数字转字符串；缺失 / 空 / `"0"` / 非法 → 空串（不伪造 `0`）。
3. **校验**：宿主路由 `number` 白名单 `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$` 且不等于 `"0"`；
   `owner/repo` 的 `SEGMENT_RE` 保持不变；非法参数仍返回 400。
   该白名单与归一函数**只在 `src/issue-number.ts` 定义一次**，宿主投影、路由、pins
   存档/写入、预览候选、`@` 引用与自动 pin 共用（`test/issue-number.test.mjs` 用源码
   扫描守护，回退成客户端内联 `#(\d+)` 会变红）。
4. **原样透传**：浏览钻取、pin 存储/去重/id、focus 与 tab id、官网深链 `#pipe/<number>`、
   接管/重派 payload 全部使用原始字符串编号，不做任何数字收敛。
5. **缓存**：面板缓存键与失败短缓存以字符串编号参与构造，字母数字编号不会塌成 `0` 而误命中。
6. **展示**：`#${number}` 展示不变（`#IKXR3B` / `#32`）。

## 本次改动点

| 文件 | 改动 |
|------|------|
| `src/issue-number.ts` | **新增（唯一口径）**：`ISSUE_NUMBER_RE` / `isValidIssueNumber` / `normalizeIssueNumber` / `parseIssueRef` / `formatIssueRefForModel` / `extractIssueNumberFromText` |
| `src/panel-api.ts` | 投影与路由改用共享口径（`isValidIssueNumber` 仍从本文件转导出）；`projectIssues` 输出字符串编号；路由 number 白名单 |
| `src/types.ts` | `GrapeIssue.number` / `issue_number` 放宽为 `string \| number`（原始 CLI 形态） |
| `src/client/browse-store.ts` | 浏览视图 / 事件 / focus 取数编号改 `string` |
| `src/client/pins-store.ts` | `Pin.number` 与 pin 校验改字符串；写入/切换改走 `isValidIssueNumber`（非法编号直接 `invalid`） |
| `src/pins-persist.ts` | 存档编号改字符串，旧数字存档读取时归一到共享口径 |
| `src/preview-select.ts` | `PreviewIssue.number` 改字符串，候选过滤与排序兜底兼容字母数字（候选编号归一改走共享口径） |
| `src/client/GrapeBrowsePanel.tsx` | 列表/详情/pin 切换按字符串编号，缺失输出空串；无编号行不可钻取、pin 置灰并说明原因 |
| `src/client/grape-mention.ts` | `@` 引用反解改走 `parseIssueRef` / `formatIssueRefForModel`，删除内联正则 |
| `src/client/GrapeToolView.tsx` | 创建 issue 后自动 pin 的编号解析改走 `extractIssueNumberFromText`，删除内联正则 |
| `src/render/action.ts` | 动作确认行编号改按字符串取值（`IKXR3B` 不再被 `parseInt` 吃掉），`"0"` 仍不展示 |
| `src/client/preview-store.ts` | 已核对**无需改动**：本就把编号按字符串透传 |
| `src/client/GrapeFocusPanel.tsx` | 已核对**无需改动**：本就把编号按字符串透传 |

## 后续新平台接入检查清单

- [ ] 确认 `issue_number` / `number` 的真实类型（整数还是字符串）。
- [ ] 若为字符串，直接复用本约定；若为整数，宿主投影时 `String()` 归一即可。
- [ ] 确认该平台是否存在「非编号」占位值（如 Gitee 的 `"0"`），加入拒绝列表。
- [ ] 补一条该平台编号形态的投影/路由测试，确保不回归。