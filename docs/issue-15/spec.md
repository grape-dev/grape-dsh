# Issue #15 Spec：插件包改名（breaking，F9）

> 目标合入分支 `dev-ch`（基线 `c74a27a`）| 里程碑 v0.5.0 | 优先级 P1
> 完整原始 Spec 见 Issue #15 评论（id 201432844），本文为实现口径摘要。

## Objective

把插件包名从旧名整体改为 `@grape-dev/grape-dsh`，一次改净所有「身份点」，
把包名收敛为单一来源（`package.json.name` 为唯一真源），并补齐面向存量用户的迁移说明。
版本 bump 至 `0.5.0`（复审修订 R2：改名是 breaking，包名同时是 dsh module id）；breaking 影响由迁移文档承载。

## 身份点（必须同时改）

| 身份点 | 位置 | 处理 |
|---|---|---|
| npm 包名 | `package.json` → `name` | 改为 `@grape-dev/grape-dsh`（`version` 同步 bump 至 0.5.0） |
| dsh module id | `cordis.patch.yml` → `insert[].name` | 改为 `@grape-dev/grape-dsh`；`id: grape-tools` 不变 |
| 构建脚本 | `scripts/build-client.mjs` → `PKG_NAME` | 改为 `readFileSync` + `JSON.parse` 读 `package.json`，删除硬编码 |
| 客户端常量 | `src/client/index.tsx` → `GRAPE_PACKAGE_NAME` | 改为新名（`plugins.bundle.config` slot key 随之变化） |
| 日志前缀/字符串 | `src/**` | 旧日志前缀 → `[grape-dsh]`，统一不混用 |
| 测试期望 | `test/pack.test.mjs` 等 | fixture 默认名 + 产物名期望/正则 |
| 文档 | `README.md` / `*-DEPLOYMENT-GUIDE*.md` / `docs/*.md` | 机械替换（含示例产物名） |

## In Scope

1. `package.json` `name` + `version`（0.4.3 → 0.5.0）、`package-lock.json` 对应 name/version 字段。
2. `cordis.patch.yml` 的 `insert[].name` module id。
3. `scripts/build-client.mjs` 改为运行时读取 `package.json`（删除硬编码 `PKG_NAME`）。
4. `src/**` 全部旧名（日志前缀统一 `[grape-dsh]`，含 `src/client/index.tsx` 的 `GRAPE_PACKAGE_NAME`）。
5. `test/**` 旧名与产物名期望/正则。
6. docs 全文机械替换（含示例产物名）；`docs/RELEASE-RECORD.md` 仅追加「命名分界」说明，
   既有 0.4.3 行与 `docs/issue-13|14/task.md` 实测输出**逐字不改**。
7. 新增防漂移单测 `test/package-identity.test.mjs`：`package.json.name` / `cordis.patch.yml` module id /
   `scripts/build-client.mjs` 读取到的 `PKG_NAME` 三者一致；tarball 形状为
   `grape-dev-grape-dsh-<version>+<YYYYMMDD-HHMMSS>.tgz`。
8. 新增 `docs/MIGRATION-rename-to-grape-dsh.md`：`remove` / `add "file:<tgz>"` / `list` 三条命令、
   配置槽位实际行为、新旧并存结论。
9. `docs/issue-15/task.md`：「验收条款 → 代码位置 → 测试名」对照表 + grep 白名单。
10. pins 本地存档旧 key 一次性迁移（复审 R1）：`src/pins-persist.ts` + `test/pins-persist.test.mjs`，
    `pins-store.ts` 仅调用；旧值非法或写回失败时保留旧 key，不制造数据丢失。

## Out of Scope

- 不发布任何 profile；不改 `~/.grape/config.json`；不动平台（`grape-dev/grape`）代码。
- 不动 `main`；不改 `locale/`（当前 0 命中）；不新增依赖；不新增 `.ps1/.cmd/.bat`。
- 不顺手改写句子、不重排文档、不统一其他术语。
- 配置 slot 不新增迁移机制（仅随包名变化）；pins 本地存档的旧 key 兜底迁移属于数据保全，不属于配置迁移。

## Acceptance Criteria

- [ ] `git grep -c '<旧包名>'` 仅命中白名单：迁移文档、`docs/RELEASE-RECORD.md` 历史行及说明、
      `docs/issue-*/task.md` 历史实测输出、`src/pins-persist.ts`（迁移代码旧 key 常量）；
      `test/`、`package.json`、`cordis.patch.yml` 及其余 docs 0 命中。
- [ ] `npm run build` 后 `lib/client.js` 内 module id 为新名，旧名 0 命中。
- [ ] `npm run pack -- --dry-run` 计划产物名 `grape-dev-grape-dsh-0.5.0+<ts>.tgz`。
- [ ] `npm run typecheck` 与 `npm test` 全绿（含新增防漂移与 pins 迁移用例，不删测试、不弱化断言）。
- [ ] 迁移文档三条命令齐备，配置槽位与并存结论与实现一致；pins 旧 key 迁移语义与实现一致。
- [ ] `package.json` diff 仅 `name` + `version`；`locale/` 0 命中；不新增依赖与 `.ps1/.cmd/.bat`。

## Risks

| 风险 | 缓解 |
|---|---|
| 漏改身份点导致「装了不生效」 | 三处一致单测 + `build` / `pack --dry-run` 双自检 |
| 批量替换误伤历史证据 | RELEASE-RECORD 历史行、issue-13/14 task.md 列入禁改；grep 白名单逐条核对 |
| 存量 profile 配置槽位不跟随 | 迁移文档如实说明需在 Settings(Grape) 重建，不虚构自动迁移 |
| 替换面大导致 diff 噪声 | 只做字符串机械替换，不重排不改写 |