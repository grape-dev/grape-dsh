# Issue #6 实现方案（Plan）

## 概览

在「已托管仓库」列表空态增加三类原因提示、可折叠诊断区与脱敏复制；诊断计算抽成宿主/客户端共用的纯函数模块，`/repos` 代理响应补充 `diagnostics` 透传。非空列表路径保持原样。

## 架构决策

- **纯函数模块** `src/repo-diagnostics.ts`：放进 `tsconfig.json` 的 `src/**/*`（非 client），编译到 `lib/`，测试可直接 `import '../lib/repo-diagnostics.js'`，同时被 client bundle 引用（与 `focus.ts` 同模式）。
- **宿主侧透传**：`panel-api` 的 `/repos` 用 `withReposDiagnostics` 包裹，保留原始 `repos` 与潜在 `total/org_id`；不改 CLI 参数与服务端语义。
- **客户端就地兜底**：`buildReposDiagnostics` 优先复用响应中合法 `diagnostics`，缺失时从原始 `repos` 计算，保证老宿主也能展示诊断。
- **空态判定**：`reposEmptyKind()` 明确区分 `none / search / list`；`RepoList` 仅在 `list` 分支渲染新空态，`search` 分支维持「没有匹配的仓库。」。

## 任务拆解

### Phase 1：文档与测试契约

- [x] Task 1：spec / plan / task 文档
- [x] Task 2：写失败测试（`test/repo-diagnostics.test.mjs`）

### Phase 2：实现

- [x] Task 3：`src/repo-diagnostics.ts`（原因常量、空态判定、诊断构建/渲染、脱敏、响应包裹）
- [x] Task 4：`src/panel-api.ts` `/repos` 透传 `diagnostics`
- [x] Task 5：`GrapeBrowsePanel.tsx` 空态组件与 `States.emptyContent`

### Checkpoint

- [x] `npm run typecheck` 通过
- [x] `npm test` 通过（Windows 实机：91 pass / 1 skip，skip 为 POSIX-only 用例；Linux 由 CI/后续环境复核）
- [x] 手动检查：空列表可见三类原因；展开诊断字段齐全；复制文本无 token/key；非空列表无变化

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 与 #5 同改 `GrapeFocusPanel.tsx` | 中 | 本 Issue 不改该文件，列表逻辑落在 `GrapeBrowsePanel` |
| 响应无 `total`/`org_id` | 中 | 显示「未知」+ 推断说明，不阻塞 |
| 诊断文本误带凭据 | 高 | 白名单字段 + `redactSensitiveText` 正则兜底 + 单测断言 |
| 剪贴板 API 不可用 | 低 | `navigator.clipboard` 失败回退 `execCommand`，再失败给出可读提示 |

## 开放问题

- 无。

## 收尾（2026-11-17）

- 空态额外展示「当前账号 / 账号组织角色 / 账号托管权限」：宿主仅在列表为空时调用 `grape auth profile` 与 `grape orgs list`，收敛为白名单字段（用户名、组织名+角色、托管仓库数与 Admin 数，不含 email / token），用于区分「未托管 / 组织过滤 / 无读取权限」。
- `force=1` 改为按缓存 key 精确失效（仅刷新本次请求对应的路由），不再清空全部面板缓存。