# Issue #41 任务拆解

## 切片 A：后端 q 透传（host-fetch + panel-api）

1. 红：`test/issue-search.test.mjs`（归一/校验/键后缀）+ `test/host-fetch.test.mjs`（URL 含 q）
   + `test/panel-api.test.mjs`（q 透传、q 分键、非法 q 400、CLI 兜底参数）→ 提交失败测试。
2. 绿：新增 `src/issue-search.ts`；`src/host-fetch.ts` 加 `q/page/per_page` 字段与白名单；
   `src/panel-api.ts` 解析/校验 `q`、拼 `--q`/`--per_page 50`/`--page`、缓存键含 q、投影补 `has_more`。
3. 验证：`npm run typecheck`、`npm test`。

## 切片 B：前端服务端搜索（browse-store + IssueList）

1. 红：`viewKey` 对 q/page 隔离的断言（同 `issue-search` 键后缀用例，覆盖前端键形态）。
2. 绿：`browse-store.ts` 视图加 `q/page`、`viewKey` 含 q、`ensureIssuesLoaded(..., q, page, force)`、
   `useViewState`；`GrapeBrowsePanel.tsx` `IssueList` 300ms 防抖、loading、匹配计数、
   上一页/下一页、服务端返回前不下「无结果」结论、清空恢复默认列表。
3. 验证：`npm run typecheck`、`npm run build`、`npm test`。

## 切片 C：QA 复审修改（note 203679921）

1. Required #1：`normalizeIssueSearchQ` 剥离前导 `#`（仅紧跟编号字符）、键后缀按归一后口径；
   补 `#4341` 归一/键/host/CLI 兜底用例（先红）。
2. Required #2：搜索态（含错误态）始终渲染搜索框与清除入口；错误区加「清除搜索」。
3. Optional：搜索视图 60s TTL + 手动刷新；投影 `total` 保留 null；换词与页码重置同批更新；
   本页为空时保留翻页条（`searchPage>1 || has_more`）。
4. 验证：`npm run typecheck`、受影响用例、全量 `node --test --test-isolation=none`（与基线逐条对比）。

## 收尾

- 自审查（5 轴 + pre-pr 增量检查：无关内容黑名单、敏感信息扫描，范围 `origin/dev-ch-11...HEAD`）。
- 推送 `feat/issue-41`，建 PR（base `dev-ch-11`），Issue 评论告知。
- A2A 通知 QA 审查。
- 双平台实测：`grape-dev/grape`（`q=4341`、`q=Gitee`）与 `changhui922/hello-skill`（`q=IKXR3B`）。