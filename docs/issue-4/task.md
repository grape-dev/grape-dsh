# Task: Issue #4

- [ ] T1 新增/修正测试（红）：Windows 拉起 argv、POSIX skip、spawn 失败回写、mint 超时孤儿撤销、`listCredentials` 失败、`readServerState` unknown
- [ ] T2 `startLocalWorker` spawn 可注入 + `spawnDetached` 真实回写 started/error
- [ ] T3 `runOnboardTransaction` mint 移入 try + 超时按名称回查撤销
- [ ] T4 `listCredentials` 失败抛错 + `handleInstall` 显式失败处理
- [ ] T5 `/check` runtime-devices 30s TTL 缓存 + 仅真正拉起时 `recordAutoStart` + 缩进重排
- [ ] T6 版本 0.4.3
- [ ] T7 `docs/issue-2/spec.md` 判据与并发语义对齐
- [ ] T8 验证：typecheck、npm test（Windows skip 统计）、npm pack 0.4.3