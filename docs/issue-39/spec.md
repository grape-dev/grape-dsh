# Issue #39 Spec：Gitee 仓库 Issue 编号为字符串，面板详情/观察全部失效

> 目标分支 `dev-ch-11` | 优先级 P1 | 类型 bug 修复
> 完整 Spec 见 Issue #39 评论区，本文为实现口径摘要。

## Objective

让插件面板对 GitCode（整数编号）与 Gitee（字母数字字符串编号，如 `IKXR3B`）统一工作，
修复详情 / 流水线 / 事件明细 404、pin 无法加入、深链与 focus/tab id 变 `#0` 的问题。

## 根因

面板整条链路把 issue 编号当 `number`：

1. `src/panel-api.ts` `projectIssues()` 用只认数字的 `numOr` → Gitee 字符串一律变 `0`；
2. 路由校验 `DIGITS_RE = /^\d{1,12}$/` 拒绝 `IKXR3B`（400）；
3. 客户端 `browse-store` / `pins-store` / `preview-select` / `grape-mention` / `GrapeBrowsePanel`
   的数字收敛、`number > 0` 判定与 `?? 0` 缺省，使编号变 `0`、pin 返回 `invalid`、深链变 `#pipe/0`。

## 方案

- 编号统一为**字符串**：`normalizeIssueNumber(v)` 归一（GitCode 整数 → `"32"`，Gitee 原样），
  缺失 / 空 / `"0"` / 非法 → `''`（不伪造 0）；该函数与白名单定义在 `src/issue-number.ts`，
  宿主投影/路由、pins 存档与写入、预览候选、`@` 引用与自动 pin 共用同一口径。
- 路由 number 白名单改为 `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`，并显式拒绝 `"0"`；
  `owner/repo` 的 `SEGMENT_RE` 不变，非法参数仍 400。
- 客户端全链路 `number` 改为 `string` 原样透传：浏览钻取、pin 存储/去重/id、
  focus/tab/深链、接管/重派 payload；`addPin` / `togglePinFor` 改走共享白名单校验。
- 缓存键与失败短缓存统一用字符串编号（天然不串号）。

## Acceptance Criteria

- [x] GitCode 整数与 Gitee 字母数字编号均可正常打开详情/流水线/事件明细；
- [x] `"0"`（如 `parent_issue_number`）不被视为合法编号，字段缺失输出空串；
- [x] pin/focus/tab/深链/接管 payload 按原始编号工作，非法参数仍 400；
- [x] 测试覆盖 5 类用例，GitCode 现有行为不回归；typecheck 通过；
- [x] `docs/` 记录 Gitee 编号形态与改动点（见 `gitee-issue-number.md`）。