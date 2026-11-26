# Issue #41 方案设计

## 数据流

```
IssueList 输入
  → normalizeIssueSearchQ（trim + 剥离前导 #）
  → 300ms 防抖得 searchQ（同一批更新把 page 重置为 1）
  → browse-store viewKey = issues:<platform>:<owner>/<repo>:q=<enc>:p=<n>
  → fetchView → GET /grape-panel-api/issues?owner=&repo=&q=&page=
  → panel-api 校验 q（归一/≤64/拒绝控制字符）→ 缓存键含 q+page
  → hostFetch.issuesList（URL 白名单拼 q/page/per_page=50）
      └─ 失败回退 CLI：issues list --q <q> --per_page 50 [--page N]
  → projectIssues 投影（保留 has_more，total 保留 null）→ 前端回填
```

## 测试 seam

| 切片 | seam | 断言 |
|------|------|------|
| 搜索词归一/键 | `src/issue-search.ts` 纯函数（编入 `lib/`） | trim/长度/控制字符/键后缀隔离 |
| 宿主 URL | `buildIssuesListUrl` / `hostFetchIssuesList` | 含 `q`/`page`/`per_page`，缺省不出现在 URL |
| 宿主代理 | `createPanelApiHandler(getConfig, deps)` HTTP 入口（既有 seam） | `q` 透传到宿主/CLI、缓存键按 q 隔离、非法 q 400 |
| 面板 | `viewKey`（经共享后缀） | 搜 A/搜 B/默认列表三种键互不相同 |

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 搜索词校验位置 | 新增 `issue-search.ts`，宿主与前端共用 | 一份口径，避免前端键与宿主校验漂移 |
| 前导 `#` | `normalizeIssueSearchQ` 在紧跟编号字符时剥离；键后缀也按归一后的词 | 占位符引导 `#编号`，但平台 q 是字面匹配（`q=#4341` → 0 条）；前端订阅键与取数键必须一致 |
| 搜索视图缓存 | 60s TTL 过期重取 + 搜索态手动「刷新」 | 会话内同一检索词可刷新，不被旧缓存钉死 |
| 错误态 | 搜索态始终渲染搜索框/清除搜索，错误区加权「清除搜索」 | 400/502 后用户能改词或退出搜索，「重试」不再是唯一出路 |
| 换词页码 | 防抖回调内同时 `setSearchQ` + `setSearchPage(1)` | 避免「新词 + 旧 page=2」先发一包再纠正 |
| 缓存粒度 | 按 `q`+`page` 分键（空 q 保持旧键语义） | 搜 A 再搜 B 不串；默认列表缓存不受影响 |
| 取数通道 | 沿用 hostFetch 优先 + CLI 兜底 | 与仓库既有 `/issues` 双通道一致 |
| 结果计数 | 返回条数 + `has_more` | 实测 `q` 响应 `total=null` |
| 翻页 | 搜索态用 `page` + `has_more` 的上一页/下一页；默认列表仍前端「加载更多」 | 服务端翻页可达 50 条之外的命中 |
| 本地过滤 | 防抖未落定/首包未回时保留为过渡 | 首屏不闪空；服务端结果回来前不断言「无结果」 |

## 兼容性

- `ensureIssuesLoaded(owner, repo, platform?)` 旧调用（preview-store）签名保持兼容，新增参数可选。
- 无 `q` 时 `viewKey` 仍为 `issues:<platform>:<owner>/<repo>`，默认列表缓存与预览逻辑不变。
- `projectIssues` 只新增 `has_more` 字段，其余字段口径不变。

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 只改 panel-api 漏改 host-fetch 白名单 | 单测断言 URL 含 `q` |
| `q` 响应无 `total`，文案按 total 恒 0 | 统一用返回条数 + `has_more`（无 total 依赖） |
| 新增搜索视图键与预览共用缓存 | 无 `q` 路径键保持旧形态，预览逻辑不受影响 |
| 每词一次请求 | 300ms 防抖 + 按 q 分键缓存（宿主 5min） |