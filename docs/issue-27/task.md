# 任务拆解（Issue #27）

- [x] T1 文档：本目录 spec/plan/task
- [x] T2 红：`test/browse-snapshot.test.mjs`（持久化失效/键隔离）+ `src/browse-snapshot.ts`
- [x] T3 红：`test/host-fetch.test.mjs`（URL/鉴权/超时/结构校验）
- [x] T4 红：`test/panel-api.test.mjs`（TTL / 回退 source=cli / 失败短缓存 / timing / 去重）
- [x] T5 绿：`src/host-fetch.ts` 快路径实现
- [x] T6 绿：`src/panel-api.ts` 缓存/回退/timing/并行空账号
- [x] T7 绿：`src/client/browse-store.ts` 快照 hydrate + SWR + 预热
- [x] T8 绿：`src/client/GrapeBrowsePanel.tsx` 数据时间标注
- [x] T9 实测对比表 + docs/RELEASE-RECORD
- [x] T10 typecheck + npm test 全绿（206 tests / 205 pass / 1 skip）
