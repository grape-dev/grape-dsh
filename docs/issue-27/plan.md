# 方案设计：浏览页签首屏性能（Issue #27）

## 架构

```
GrapeBrowsePanel.tsx
  └─ browse-store.ts ──┬─ browse-snapshot.ts（纯逻辑：key/schema/序列化，可单测）
                       └─ /grape-panel-api/*
                              └─ panel-api.ts（缓存 / 去重 / timing / 回退）
                                   ├─ host-fetch.ts（Node 内置 fetch 快路径）
                                   └─ cli-client.ts（回退，行为不变）
```

## 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 快路径传输 | Node 内置 `fetch`（undici 全局 dispatcher 自带连接池与 TLS 复用） | 零新增依赖，进程内复用；`fetch` 不可用即回退 CLI |
| 缓存时长 | `CACHE_TTL_MS = 300_000`，可由 `GRAPE_PANEL_CACHE_TTL_MS` 覆盖 | 面板数据低频变动；环境变量满足「可配」 |
| 失败缓存 | `FAILURE_TTL_MS = 8_000` | 防抖连点，又不长期卡住故障态 |
| 持久化 | `localStorage`，键 `grape-dsh.browse.v1:{baseUrl}:{account}`，值 `{schema, savedAt, data}` | 刷新/重启后首字节出图；schema 不符即丢弃 |
| 最新快照指针 | `grape-dsh.browse.latest.v1` 存 `{baseUrl, account}` | 模块加载时无需先知道 baseUrl 即可找回快照 |
| 回退策略 | 捕获 `HostFetchError`（no-token/no-fetch/bad-base-url/http/schema/timeout/network）→ CLI | 面板行为与现状一致，结果等价 |
| 预热 | idle（`requestIdleCallback`）+ 400 ms 延迟 | 与 pins 恢复轮询（0/150/300 ms）错峰；不阻塞首屏 |
| 账号分键 | 空仓库时从诊断 `viewer.username` 取得并记忆；未知用空串（仅按 baseUrl 分键） | 不为取账号额外发请求；账号是纯展示分键，不承担鉴权 |

## 实现路径

1. `src/host-fetch.ts`：`hostFetchReposManaged` / `hostFetchIssuesList` / `hostFetchPipeline`，统一 `requestJson`（Bearer 鉴权、AbortController 超时、2xx 校验、结构白名单校验、`hostMs` 计时、错误码），token 不入错误消息。
2. `src/panel-api.ts`：缓存项扩展为 `{at, ok, value, source, hostMs, message}`；`run()` 顺序：force 失效 → 命中（成功 TTL / 失败短缓存）→ in-flight → host → CLI 回退；成功/失败都写缓存。`/repos` 空列表时 `Promise.all` 并行取 auth profile 与 orgs list。响应附 `timing`，宿主打一行日志。
3. `src/browse-snapshot.ts`：纯逻辑，`snapshotKey` / `parse` / `serialize` / `loadLatest` / `save`，无 React 与 DOM 依赖。
4. `src/client/browse-store.ts`：模块加载时 hydrate 根快照；`ensureRootLoaded` 先渲染旧数据再后台 revalidate（静默，不置 loading）；成功拉取后写快照；`prewarmRoot()` idle 预热。
5. `src/client/GrapeBrowsePanel.tsx`：仓库列表展示「数据时间」；挂载时 `ensureRootLoaded`。
6. 测试：
   - `test/host-fetch.test.mjs`：URL/鉴权映射、结构不符回退信号、非 2xx、超时、token 不泄露。
   - `test/panel-api.test.mjs`：TTL 命中/过期/force、host→CLI 回退（source=cli）、失败短缓存、timing 字段、in-flight 去重。
   - `test/browse-snapshot.test.mjs`：键隔离、schema 版本失效、损坏 JSON 失效、roundtrip。

## 测试 seam

- 宿主：`createPanelApiHandler(getConfig, deps?)`，`deps` 注入 `exec` / `hostFetch` / `now` / `cacheTtlMs` / `failureTtlMs`，用最小 req/res 桩验证 HTTP 语义。
- 客户端持久化：抽到纯模块 `src/browse-snapshot.ts`，注入 `StorageLike`，与 `pins-persist.ts` 同型。
