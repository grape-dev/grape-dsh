# Issue #39 任务拆解（Task）

- [x] T1 宿主投影：编号归一走 `src/issue-number.ts` 共享口径，`issue_number` 输出字符串（缺失不伪造 0）。
- [x] T2 路由校验：number 白名单 `^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`，拒绝 `"0"`/空串，非法仍 400。
- [x] T3 浏览 store：`BrowseView.pipeline.number` 与 events/focus 取数改 string。
- [x] T4 观察 store + 存档：`Pin.number` 改 string，`addPin` 走共享校验，旧存档数字归一到共享口径。
- [x] T5 预览选择器：`PreviewIssue.number` 改 string，候选过滤走共享归一，排序兜底兼容字母数字。
- [x] T6 面板与引用链：浏览/实时面板、`@` 引用、自动 pin 的编号按字符串透传。
- [x] T7 测试：5 类用例（数字 / `IKXR3B` / `"0"` / 缺失 / 两平台归一）+ 400 回归 + 旧存档迁移。
- [x] T8 文档：`docs/issue-39/` 与 Gitee 编号形态说明。
- [x] T9 验证：`npm run typecheck` + `npm test` 全绿。
- [x] T10 复审 Required #1：抽 `src/issue-number.ts` 为编号口径唯一出处，宿主投影/路由、
      pins 存档与写入、预览选择、`@` 引用、自动 pin 全部改用共享函数（`"a b"` / `"../x"`
      在存档与预览候选均判非法）。
- [x] T11 复审 Required #2：补 `test/issue-number.test.mjs`（字母数字反解/降级 + 源码扫描，
      回退 `#(\d+)` 必红）与 `test/render-action.test.mjs`（确认行编号展示）。
- [x] T12 复审 Optional：动作确认行编号改字符串取值；无编号行禁用钻取与 pin。