# Issue #6 需求文档（Spec）

> 依据 Issue #6 评论中的 Spec 与 VOD 结构化需求；基线分支 `dev-ch`，开发分支 `feat/issue-6`。

## 目标

右侧面板「已托管仓库」列表为空时，不再只显示一句「没有已托管的仓库」，而是：

1. 明确列出三类可区分原因：未托管到本组织 / 组织归属未设置（`org_id=0` 被组织过滤）/ 当前角色无读取权限；
2. 提供可折叠「诊断」区，展示本次查询的端点与参数、原始返回条数 / `total`、`org_id` 推断值；
3. 提供「一键复制诊断信息」，复制内容只含白名单字段，且经过脱敏，不含 token / key / Authorization / Cookie 等凭据；
4. 列表非空时 UI 与行为零变化。

## 现状与关键事实

- 面板「已托管仓库」列表实际位于 `src/client/GrapeBrowsePanel.tsx` 的 `RepoList`（不是 `GrapeFocusPanel`）。
- 数据链路：`RepoList` → `browse-store.fetchView('repos')` → 宿主 `GET /grape-panel-api/repos` → `grape repos managed --json-out` → 服务端 `GET /api/repos/managed`。
- 实测 `grape repos managed --json-out` 只返回 `{ repos: [...] }`，**没有** `total`、`org_id` 等元数据。
  - `total` 缺失时诊断显示「未知（接口未返回 total）」，不伪造；
  - `org_id` 缺失时显示「未知」并给出推断说明（空列表且平台确有托管时，通常意味着 `org_id=0` 被组织过滤）；
  - 若未来接口返回 `total` / `org_id` / `organization_id`，插件侧直接透传展示。

## Scope

### In Scope

- 空态原因提示（三类原因）。
- 可折叠诊断区（查询端点、插件代理与 CLI、参数、原始条数、`total`、角色分布、`org_id` 推断、生成时间）。
- 一键复制脱敏诊断文本（白名单组装 + 正则兜底脱敏）。
- `src/panel-api.ts` 的 `/repos` 响应补充 `diagnostics` 元数据透传（不改服务端协议语义）。

### Out of Scope

- 服务端 `managed_repos` 组织过滤逻辑（平台侧另行跟进）。
- 非空列表渲染与数据来源。
- 鉴权 / 角色模型改造。
- `GrapeFocusPanel.tsx` 的任何改动（避开与 #5 的冲突面）。

## 技术方案

1. 新增 `src/repo-diagnostics.ts`（宿主与客户端共用的纯函数模块，可被 `node --test` 直接测试）：
   - `REPO_EMPTY_REASONS`：三类原因文案；
   - `reposEmptyKind(repoCount, searching, hitCount)`：区分「无仓库 / 搜索无命中 / 非空」，保证非空列表行为不变；
   - `buildReposDiagnostics(data, opts)`：从原始响应计算白名单诊断字段（含 `total` / `org_id` 缺失兜底）；
   - `renderReposDiagnostics(diag)`：生成可复制文本；
   - `redactSensitiveText(text)`：对 token/key/Authorization/Cookie 等键值与 token 前缀形态兜底脱敏；
   - `withReposDiagnostics(data, opts)`：宿主侧给响应追加 `diagnostics`，保留原始 `repos` 与未来元数据。
2. `src/panel-api.ts`：`/repos` 返回 `withReposDiagnostics(raw)`；`force=1` 作为诊断参数透传。
3. `src/client/GrapeBrowsePanel.tsx`：
   - `RepoList` 用 `reposEmptyKind` 判断空态分支；空态渲染新组件 `RepoEmptyState`，搜索无命中维持原文案；
   - `States` 增加可选 `emptyContent`，仅空态替换展示，不触碰非空列表 DOM。
4. `test/repo-diagnostics.test.mjs`：覆盖三类原因、诊断字段、`org_id` 缺失/存在、脱敏断言、非空判定。

## 关键设计决策

| 决策 | 选项 | 选择 | 理由 |
|------|------|------|------|
| 诊断展示形式 | 独立弹层 / 可折叠内嵌 | 可折叠内嵌 | 无新依赖，改动最小，与现有面板视觉一致 |
| 脱敏策略 | 白名单字段 / 黑名单键 | 白名单字段 + 正则兜底 | 从源头不组装凭据，再用正则兜底未知键 |
| 元数据缺失 | 显示「未知」/ 自行推断 | 显示「未知」+ 推断说明 | 不伪造数据 |
| 改动落点 | GrapeFocusPanel / GrapeBrowsePanel | GrapeBrowsePanel | 该列表实际在这里；同时避开 #5 同文件冲突 |

## Acceptance Criteria

- [x] 空列表时可见三类「可能原因」提示，且能区分「未托管 / 组织过滤 / 无权限」；
- [x] 「诊断」可展开，包含查询端点与参数、原始返回条数 / `total`、`org_id` 推断值；
- [x] 「复制诊断信息」内容不含 token/key（含大小写与 Authorization/Cookie 头变体）；
- [x] 列表非空时 UI 与行为不变（回归用例覆盖判定函数）；
- [x] `npm run typecheck` 通过；
- [ ] `npm test` 在 Windows 与 Linux 均全绿（如有 skip，需在结论中写明数量与原因）。Windows 实机已全绿（91 pass / 1 skip，skip 为 POSIX-only 用例）；Linux 待 CI/后续环境复核。

## 测试策略

- `node --test test/*.test.mjs`，只测纯函数 seam（`src/repo-diagnostics.ts`），不引入 React 测试依赖。
- 先写失败测试（红），再实现（绿）。

## Boundaries

- Always：仅改插件侧；提交前跑 typecheck / test；复制内容必须脱敏。
- Ask first：新增依赖、修改服务端协议。
- Never：改服务端组织过滤逻辑；写死分支名；提交 token / 密钥。