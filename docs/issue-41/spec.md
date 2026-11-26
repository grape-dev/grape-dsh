# Issue #41 Spec：浏览页 issue 搜索改为服务端检索

> 目标合入分支 `dev-ch-11` | 优先级 P2 | 类型：缺陷修复（功能补齐）
> 完整 Spec 见 Issue #41 评论 203661743，本文件为实现口径摘要。

## Objective

浏览页 issue 列表的搜索框改为**服务端检索**：把查询词透传平台 `q`（标题 + 编号全量匹配），
不再只在已加载的 20 条里做前端字面过滤。搜索 `4341` 应命中 #4341，搜索 `Gitee` 应返回
跨全量的多条命中，搜 A 再搜 B 不得命中 A 的缓存。

## 根因

1. `src/panel-api.ts` 的 `/issues` 路由只解析 `status / sort_order / mode / assignees`，
   请求参数 `q` 被丢弃，CLI `--q` 从未被调用；缓存键不含 `q`。
2. `src/host-fetch.ts` 的 `IssuesListQuery` 与 `buildIssuesListUrl` 白名单同样没有 `q`
   （第二道关口，只改 panel-api 仍透传不出去），`hostFetchIssuesList` 也未拼 `q`。
3. `src/client/browse-store.ts` 的 `ensureIssuesLoaded` / `viewKey` 没有 `q` 维度，
   没有服务端搜索取数入口。
4. `src/client/GrapeBrowsePanel.tsx` 的 `IssueList` 用本地 `useState('')` + `includes()`
   过滤 20 条，并把「本地无匹配」直接呈现为「无结果」。

平台能力已具备（实测 `grape issues list --q`），本单不改平台接口、不改默认首页条数、不 bump 版本号。

## 关键实测口径

- `q` 语义为**标题 + 编号**匹配（不搜正文/评论），可与 `--status` / `--per_page` / `--page` 组合。
- **`q` 查询响应的 `total` 为 `null`**；「匹配 N 条」只能用**本次返回条数**，翻页依据 `has_more`。
- `has_more` / `page` / `per_page` 由平台返回（如 `per_page=50` 时 `has_more` 可 true），
  CLI 与宿主快路径均支持 `page` / `per_page`。

## Scope

### In Scope

- `src/issue-search.ts`（新增）：搜索词归一/校验（trim、**剥离前导 `#`（仅当其后为编号字符）**、
  ≤64、拒绝控制字符与 `-` 开头）、`q`/`page` 视图键后缀的单一事实来源，宿主校验与前端视图键共用。
- `src/host-fetch.ts`：`IssuesListQuery` 增加 `q` / `page` / `per_page` 并入 URL 白名单。
- `src/panel-api.ts`：`/issues` 接受并校验 `q`；拼 `--q`、搜索时 `--per_page 50` 与 `page`；
  缓存键含 `q`（编码后）与 `page`；投影补 `has_more`，**`total` 保留 number/null 原值**。
- `src/client/browse-store.ts`：`issues` 视图增加 `q` / `page`，`viewKey`／在途键／缓存键含 `q`，
  `ensureIssuesLoaded(..., q, page, force)` 支持服务端搜索取数；搜索视图 60s TTL 过期重取；
  新增 `useViewState`。
- `src/client/GrapeBrowsePanel.tsx` `IssueList`：输入 300ms 防抖走服务端；请求中 loading；
  显示「匹配 N 条」；`has_more` 时提供上一页/下一页；服务端返回前不把本地空匹配判成「无结果」；
  清空搜索恢复默认 20 条列表（首页行为不变）；**搜索态（含错误态）始终保留搜索框与清除入口**；
  换词与页码重置合并为一次状态更新；本页为空时仍保留翻页条；搜索态提供手动「刷新」。
- `test/`：搜索词归一/键隔离（含 `#4341`）、host-fetch URL 含 `q`、panel-api `q` 透传、缓存键隔离、
  非法 `q` 400。

### Out of Scope

- 不改默认首页条数与首页取数行为；不改平台 `/api/issues` 接口；不扩展 `q` 语义；不 bump 版本号。

## Acceptance Criteria

- [ ] `GET /grape-panel-api/issues?owner=grape-dev&repo=grape&q=4341` 返回 #4341；
- [ ] `q=#4341` 归一为 `q=4341` 并命中 #4341（平台 q 为字面匹配，`#` 前缀不能原样透传）；
- [ ] 搜索报错（400/502/403）时搜索框与「清除搜索」仍可用，可改词或退出搜索；
- [ ] `q=Gitee` 返回多条命中并显示「匹配 N 条」；`has_more` 为真时可用下一页继续翻；
- [ ] 搜不存在的词：服务端返回后才显示「无匹配」，与「前 20 条里没有」可区分；请求中显示 loading；
- [ ] 搜 A 再搜 B 结果不串（缓存键/视图键含 `q`）；清空搜索恢复默认列表；
- [ ] 非法 `q`（>64 / 含控制字符）返回 400，且不影响其他参数；
- [ ] `host-fetch.ts` 单测断言 URL 含/不含 `q`；
- [ ] 单测覆盖 `q` 透传、缓存键隔离、非法 `q` 400；`npm test` 全绿；`npm run typecheck` 通过；
- [ ] GitCode（`grape-dev/grape`）与 Gitee（`changhui922/hello-skill`）两平台各验证一次。