# Spec：浏览页签首屏性能（Issue #27）

> 目标分支：`dev-ch-11`（场景工作基线）。来源：Issue #27 与 Issue Agent 发布的 Spec 评论。

## 目标

把「浏览」页签首次加载托管仓库的耗时从 0.7–0.9 s（空账号约 2 s）降低到：

| 场景 | 目标 |
|------|------|
| 冷首屏（无内存缓存、无持久化） | ≤ 300 ms |
| 5 min 内热载 | ≤ 50 ms |
| 持久化首屏首字节 | ≤ 50 ms |
| 空账号首次 | ≤ 600 ms |

## 根因

- `src/panel-api.ts` 的 `CACHE_TTL_MS = 30_000`，未命中即 `spawn` 一次 `grape` Python CLI：解释器启动 ~0.3 s + 契约解析 ~30 ms + 每请求新建 `httpx.Client` 并加载 `certifi` 0.2–0.55 s。服务端直连仅 19–48 ms。
- `src/client/browse-store.ts` 的 `ensureRootLoaded()` 只有内存态，刷新/重启必然重走冷路径。

## 范围

### In Scope

1. 只读 GET（`repos managed` / `issues list` / `pipeline`）走宿主 Node fetch 快路径，进程级复用 keep-alive/TLS；鉴权缺失、接口不可用、字段不兼容、超时时自动回退 CLI，响应标 `source=host|cli`。
2. 结果缓存 TTL 30 s → 5 min（常量可配），失败结果 5–10 s 短缓存；保留 `force` 精确失效与同 URL in-flight 去重。
3. `localStorage` 快照（按 `baseUrl + 账号` 分键、带 schema 版本与保存时间），stale-while-revalidate，UI 标注数据时间。
4. 面板挂载/预热 `/repos`；空账号 `auth profile` 与 `orgs list` 改 `Promise.all`；预热与 pins 轮询错峰。
5. `/repos` 响应带 `timing`（`hostMs` / `cache` / `source`）并打一行宿主日志。
6. 文档补充浏览面板段落；`RELEASE-RECORD` 只补本条（不 bump 版本号）。
7. 外部建议（不在本仓实施）：CLI 侧复用单个 `httpx.Client` 或常驻 stdio —— 写入 PR 描述。

### Out of Scope

- 不改 `grape` CLI 仓库；不改 33 个 `grape_*` 工具的入参与行为。
- 不触碰 #26（`GrapeFocusPanel.tsx` / `pins-store.ts` / `src/render/*`）、#25（`local-runtime.ts` / `worker-onboard.ts` / `GrapeMachinePanel.tsx` / `index.ts` 的 `/check` 路由）、#24（README 安装章节与 `skills/`）。
- 不重复 bump 版本号。

## 验收标准

- [ ] 冷首屏 ≤300 ms；5 min 内热载 ≤50 ms；持久化首屏首字节 ≤50 ms；空账号首次 ≤600 ms
- [ ] 连点 3 次只触发 1 次请求/进程（in-flight 去重）
- [ ] 快路径故障自动回退 CLI，`source=cli` 且面板不报错
- [ ] `/repos` 响应含 `timing`，宿主有一行日志
- [ ] 持久化键按 `baseUrl + 账号` 隔离，schema 版本不符安全失效
- [ ] `npm run typecheck` 通过；`npm test` 通过（基线 176 tests / 1 skipped，只加不减）
- [ ] 新增 TTL、快路径回退、持久化失效三类单测
- [ ] 本机实测对比表进 PR 描述
