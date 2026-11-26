# Issue #6 任务清单（Task）

- [x] Task 1：需求与方案文档
  - Acceptance：`docs/issue-6/spec.md`、`plan.md`、`task.md` 落盘
  - Verify：文件存在且与 Issue Spec 一致
  - Files：`docs/issue-6/*.md`

- [x] Task 2：失败测试先行
  - Acceptance：覆盖三类原因、诊断字段（端点/参数/条数/total/org_id）、脱敏、非空判定
  - Verify：`npm test` 在实现前对新增用例为红
  - Files：`test/repo-diagnostics.test.mjs`

- [x] Task 3：诊断纯函数模块
  - Acceptance：`buildReposDiagnostics` 对缺失 `total/org_id` 显示「未知」；`renderReposDiagnostics` 不含凭据；`reposEmptyKind` 非空返回 `none`
  - Verify：新增用例转绿
  - Files：`src/repo-diagnostics.ts`

- [x] Task 4：宿主 `/repos` 透传诊断
  - Acceptance：响应保留 `repos`，追加 `diagnostics`；非空行为不变
  - Verify：typecheck + 现有测试
  - Files：`src/panel-api.ts`

- [x] Task 5：空态 UI 与复制
  - Acceptance：空列表展示三类原因、可折叠诊断、复制按钮；搜索无命中与非空列表文案不变
  - Verify：typecheck / build / 手动检查
  - Files：`src/client/GrapeBrowsePanel.tsx`

- [x] Checkpoint：`npm run typecheck`、`npm test` 通过（Windows 91 pass / 1 skip，skip 为 POSIX-only）；Issue 评论与 PR 创建