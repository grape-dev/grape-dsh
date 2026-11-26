# Issue #15 方案设计（Plan）

## 方案概述

以 `package.json.name` 为唯一真源：

- `cordis.patch.yml` 静态同步（清单无法运行时推导），由新增单测守护；
- `scripts/build-client.mjs` 运行时 `readFileSync(new URL('../package.json', import.meta.url))` + `JSON.parse` 读取；
- `scripts/pack.mjs` 已从 `package.json` 读 `name`，不改，仅验证产物名随之为新名；
- 全仓只做旧名 → `grape-dsh` 字符串机械替换，保留历史白名单文件原样。

## 实现路径

1. **先立护栏**：新增 `test/package-identity.test.mjs`，断言目标身份为 `@grape-dev/grape-dsh`：
   - `package.json.name` == `cordis.patch.yml` 中 `id: grape-tools` 项的 `name`；
   - `build-client.mjs` 导出的 `PKG_NAME` 与 `package.json.name` 一致；
   - `build-client.mjs` 源码不含硬编码旧名；
   - `node scripts/pack.mjs --dry-run` 输出 `grape-dev-grape-dsh-<version>+<ts>.tgz`。
   先红（当前仍是旧名），再实现转绿。
2. **改身份点与版本**：`package.json.name`、`version` 0.4.3 → 0.5.0、`package-lock.json` 两处 name/version、
   `cordis.patch.yml` module id、`scripts/build-client.mjs` 改读 `package.json`（导出 `PKG_NAME` 供测试，
   直接执行时仍构建）。
3. **改 `src/**`**：机械替换旧名与日志前缀（含 `GRAPE_PACKAGE_NAME`、`GRAPE_TAB_ID`）；pins 的
   storage key 改写新 key，并保留旧 key 一次性迁移（见第 7 步）。
4. **改测试**：fixture 默认名、产物名期望与正则。
5. **改文档**：机械替换旧名与示例产物名；**不动** `docs/RELEASE-RECORD.md` 历史行、
   `docs/issue-13/task.md`、`docs/issue-14/task.md`。
6. **写迁移文档** `docs/MIGRATION-rename-to-grape-dsh.md`：卸载 / 安装 / 自查 + 配置槽位 + 并存结论。
7. **pins 存档迁移**（复审 R1）：key 常量 + 解析/迁移抽到 `src/pins-persist.ts`（storage 注入），
   `pins-store.ts` 只负责传入 `localStorage`；先红（迁移单测）后绿。
8. **自检五连**：`git grep` 白名单 → `npm run build` 查 `lib/client.js` → `npm run pack -- --dry-run` 查产物名 →
   `npm run typecheck && npm test` → pins 迁移单测。

## 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 包名真源 | `package.json.name` | 静态清单无法运行时推导；测试把漂移变成红 |
| 构建脚本 | 运行时读 `package.json` | 避免下次改名再漏；导出 `PKG_NAME` 便于单测断言 |
| 历史记录 | 保持原样 + 边界说明 | sha256 已对真实产物复算，改名即作废整张表 |
| 配置槽位 | 不做自动迁移 + 文档说明 | 不扩大范围、不编造行为；slot key 由包名推导，旧配置需手工重建 |
| 替换手法 | 最小机械替换 | diff 面压到最小，避免冲突与误伤 |
| 版本 | 0.5.0 | 复审 R2：改名 breaking 且包名即 module id，沿用 0.4.3 会对账混淆 |
| pins 存档 | 读旧 key 一次性迁移，写回成功才删旧 | 保全用户数据；坏值/写回失败保留旧 key，不静默清空 |

## 影响模块

| 模块 | 改动类型 |
|---|---|
| `package.json` / `package-lock.json` | name + version 字段 |
| `src/pins-persist.ts` | 新增：pins 存档 key 常量 + 解析/迁移（纯逻辑） |
| `cordis.patch.yml` | module id |
| `scripts/build-client.mjs` | 重构（读 package.json，导出 PKG_NAME） |
| `src/**` | 字符串/日志前缀/常量 |
| `test/**` | 期望与新防漂移用例 |
| `README.md`、`*-DEPLOYMENT-GUIDE*.md`、`docs/*.md` | 机械替换 |
| `docs/RELEASE-RECORD.md` | 仅追加命名分界说明 |
| `docs/MIGRATION-rename-to-grape-dsh.md`、`docs/issue-15/*` | 新增 |

## 测试 seam

- 单一来源一致性：直接读静态文件（`package.json`、`cordis.patch.yml`）+ 导入构建脚本导出的 `PKG_NAME`；
- tarball 形状：走真实 `scripts/pack.mjs --dry-run` CLI（复用实现，不另造命名规则）；
- 端到端产物：`npm run build` 后检查 `lib/client.js` 的 `__ModuleLoader__.load({ id })`；
- pins 存档迁移：`src/pins-persist.ts` 纯函数 + 注入的假 storage（新 key 优先 / 仅旧 key 迁移 / 坏值留证 / 写回失败留旧）。