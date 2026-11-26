# Issue #15 任务拆解与验收对照（Task）

> 目标合入分支 `dev-ch`；开发基线 `c74a27a`（`!15 merge feat/issue-14 into dev-ch`）；开发分支 `feat/issue-15`。
> TDD：先提交失败用例（`test(#15)`），再提交实现使其通过（`feat(#15)`）。
> 复审修订（R2）：改名是 breaking（包名同时是 dsh module id），版本号 bump 至 `0.5.0`。
>
> **移植说明（dev-ch-11）**：本分支（`dev-ch-11`）从 `815c268` 另起，没有 `#7`/`#10`/`#12`/`#13`/`#14` 的代码，
> 因此 `scripts/pack.mjs`、`scripts/check-compat.mjs`、`docs/RELEASE-RECORD.md`、`docs/issue-13|14/` 在这一支上不存在。
> 改名本身（身份点收敛 + pins 旧 key 迁移 + 0.5.0）按上游实现原样移植；涉及上述缺失文件的验收项改写为
> `npm pack --dry-run --json` 取真实产物名，验证记录见文末「dev-ch-11 复验」。

## 切片

| # | 切片 | 交付物 | 测试 seam | 状态 |
|---|------|--------|-----------|------|
| 1 | 失败用例先行 | `test/package-identity.test.mjs`（三处身份一致 + tarball 形状 + 无硬编码） | 静态文件 + `scripts/build-client.mjs` 导出 + `pack.mjs --dry-run` | 完成（先红后绿） |
| 2 | 身份点 | `package.json` / `package-lock.json` / `cordis.patch.yml` / `scripts/build-client.mjs` | 同上 | 完成 |
| 3 | 运行时代码 | `src/**` 字符串、日志前缀、`GRAPE_PACKAGE_NAME` | build 后 `lib/client.js` module id | 完成 |
| 4 | 测试期望 | `test/**` fixture/产物名/正则 | `npm test` | 完成 |
| 5 | 文档 | 全量机械替换（历史文件禁改） | `git grep` 白名单 | 完成 |
| 6 | 迁移说明 | `docs/MIGRATION-rename-to-grape-dsh.md` | 人工核对三条命令 | 完成 |
| 7 | 回归 | `npm run build` / `npm run typecheck` / `npm test` / `pack --dry-run` | 命令输出 | 完成 |
| 8 | pins 存档迁移（复审 R1） | `src/pins-persist.ts` + `src/client/pins-store.ts` 接入 | `test/pins-persist.test.mjs`（storage 注入） | 完成（先红后绿） |
| 9 | 版本 bump（复审 R2） | `package.json` / `package-lock.json` → `0.5.0` | `pack --dry-run` 产物名 | 完成 |

## 验收条款 → 代码位置 → 测试名

| 验收条款 | 代码位置 | 测试名 |
|----------|----------|--------|
| `package.json.name` == `cordis.patch.yml` module id | `package.json` / `cordis.patch.yml` | `package.json.name、cordis.patch.yml module id、build 脚本 PKG_NAME 三者一致` |
| build 脚本 `PKG_NAME` 由 `package.json` 推导（无硬编码） | `scripts/build-client.mjs` | `build-client.mjs 的 PKG_NAME 由 package.json 推导，不硬编码包名` |
| `build` 后 `lib/client.js` module id 为新名 | `scripts/build-client.mjs` / `lib/client.js` | 验证记录（命令核对；`id: "@grape-dev/grape-dsh"`） |
| `pack` 产物名 `grape-dev-grape-dsh-<version>.tgz`（上游另有 `+<ts>` 后缀，本支无 `pack.mjs`） | `package.json.name` / `npm pack` 内置命名 | `npm pack --dry-run 计划产物名 = grape-dev-grape-dsh-<version>.tgz` |
| pins 旧 key 迁移兜底（新 key 优先 / 仅旧 key 迁移后删旧 / 双值以新为准 / 坏值留证 / 写回失败留旧） | `src/pins-persist.ts` / `src/client/pins-store.ts` | `test/pins-persist.test.mjs`（7 条用例） |
| 版本号 bump `0.5.0`（历史 0.4.3 记录行不改；本支无 `docs/RELEASE-RECORD.md`） | `package.json` / `package-lock.json` | `npm pack --dry-run` 产物名 + `git diff` 人工核对 |
| 迁移文档 `remove` / `add "file:<tgz>"` / `list` 三条命令 | `docs/MIGRATION-rename-to-grape-dsh.md` | 人工核对（见验证记录） |
| `docs/issue-15/task.md` 出对照表 + 白名单 | 本文件 | — |
| 不删测试、不弱化断言；typecheck/test 全绿 | `test/**`、`src/**` | `npm run typecheck` / `npm test` |
| `package.json` diff 仅 `name` + `version`；locale 0 命中；无新依赖/脚本 | `package.json` / `locale/` | `git diff` + `git grep` 白名单 |
| 历史实测输出逐字不改 | 上游 `docs/RELEASE-RECORD.md` / `docs/issue-13|14/task.md`（本支无这些文件，不适用） | — |

## grep 白名单（`dsh-grape` 仅允许出现在）

1. `docs/MIGRATION-rename-to-grape-dsh.md` —— 迁移说明需要写旧名与旧 pins 存储 key。
2. `docs/issue-15/task.md` —— 本文件（验收条款/白名单描述需引用旧名）。
3. `src/pins-persist.ts` —— 复审 R1 迁移代码里的旧 pins 存储 key 常量（只读一次，不写回）。

> 上游 `docs/RELEASE-RECORD.md`、`docs/issue-13/task.md`、`docs/issue-14/task.md` 也是白名单文件，
> 但`dev-ch-11` 这一支没有它们，故不在本支白名单内。

除以上文件外，`test/`、`scripts/`、`package.json`、`package-lock.json`、`cordis.patch.yml`、
`locale/`、其余 `docs/`、根目录 md 均 0 命中；`src/` 仅 `src/pins-persist.ts` 的旧 key 常量命中。

## 验证记录（真实命令）

| 场景 | 命令 | 实际结果 |
|------|------|---------|
| 依赖安装 | `npm ci --no-audit --no-fund` | 32 packages（`prepare` 执行 tsc） |
| 失败用例先行 | `node --test test/package-identity.test.mjs`（实现前） | 红：`does not provide an export named 'PKG_NAME'` |
| 防漂移单测 | `node --test test/package-identity.test.mjs` | 3 tests / 3 pass / 0 fail |
| 构建 | `npm run build` | exit 0；`lib/client.js` 289.1 KB，`id: "@grape-dev/grape-dsh"`；旧名命中 0 |
| 打包计划 | `npm run pack -- --dry-run` | exit 0；计划产物 `grape-dev-grape-dsh-0.5.0+20261117-173146.tgz` |
| 类型检查 | `npm run typecheck` | exit 0 |
| 全量测试 | `npm test` | 299 tests / 298 pass / 1 skipped / 0 fail |
| 兼容检查 | `node scripts/check-compat.mjs --strict` | exit 0；扫描 56 文件 / 17715 行，豁免 4 条（未登记 0 条） |
| pins 迁移单测 | `node --test test/pins-persist.test.mjs` | 7 tests / 7 pass / 0 fail（实现前为红：`lib/pins-persist.js` 不存在） |
| grep 白名单 | `git grep -c 'dsh-grape'` | 仅白名单：`docs/MIGRATION-rename-to-grape-dsh.md:6`、`docs/RELEASE-RECORD.md:5`、`docs/issue-13/task.md:3`、`docs/issue-14/task.md:4`、`docs/issue-15/task.md`（本文件）、`src/pins-persist.ts:3`（迁移代码）；`test/`、`scripts/`、`package*.json`、`cordis.patch.yml`、`locale/`、其余 docs 均 0 |
| 旧 pins key 命中 | `git grep -n '<旧包名>.pins.v1'` | 仅 `src/pins-persist.ts`（迁移读取常量）与 `docs/MIGRATION-rename-to-grape-dsh.md`（迁移说明）；`test/` 及其他文件 0 |
| locale | `git grep -c 'dsh-grape' -- locale` | 0 命中 |
| 身份点 diff | `git diff -- package.json package-lock.json` | `package.json`：`name`（前次改名）+ `version` 0.4.3 → 0.5.0；`package-lock.json`：两处 name/version 同步；无新增依赖/脚本 |
| 迁移命令 | 对照 `docs/MIGRATION-rename-to-grape-dsh.md` | `remove` / `add "file:<tgz>"` / `list` 三条命令齐备；配置槽位 keyed by 包名需手工重建，新旧不可并存 |
| 脚本类文件 | `git status --porcelain` 过滤 `.ps1`/`.cmd`/`.bat` | 无命中 |

## dev-ch-11 复验（2026-11-18，移植后实测）

> 分支 `feat/rename-grape-dsh`，基线 `dev-ch-11 @ 7f9bad2`。
> 移植方式是取上游 `9199e4f^..c10f134`（#15 全系列）的累积 diff，3-way 应用到本支；
> 冲突仅 4 个文件：`AGENT-DEPLOYMENT-GUIDE.md`、`docs/TESTING-CHECKLIST.md`（上游 #13/#14/#10 的新增内容，本支无 → 保留本支正文 + 机械改名）、
> `src/index.ts`、`test/local-runtime.test.mjs`（上游 #7/#5 的新增逻辑，本支无 → 保留本支正文 + 机械改名）。
> **没有把 #7/#10/#12/#13/#14 的任何功能带进来。**

| 场景 | 命令 | 实际结果 |
|------|------|---------|
| 类型检查 | `npm run typecheck` | exit 0 |
| 构建 | `npm run build` | exit 0；`lib/client.js` 232.9 KB（238,539 B），module id `id: "@grape-dev/grape-dsh"` |
| 全量测试 | `npm test` | **182 tests / 181 pass / 1 skip / 0 fail** |
| 打包计划 | `npm pack --dry-run --json --ignore-scripts` | exit 0；`grape-dev-grape-dsh-0.5.0.tgz`，80 files |
| 身份点 | `package.json` / `package-lock.json` | `@grape-dev/grape-dsh` / `0.5.0`（两处同名同版本） |
| grep 白名单 | `git grep -c 'dsh-grape'` | 仅 3 个文件：`docs/MIGRATION-rename-to-grape-dsh.md:6`、`docs/issue-15/task.md:3`、`src/pins-persist.ts:3` |
| locale | `git grep -c 'dsh-grape' -- locale` | 0 命中 |
| 构建产物旧名 | `Select-String -Path lib\*.js -Pattern dsh-grape` | 4 处，全部是 pins 旧 key 常量 `dsh-grape.pins.v1` 与其注释（迁移只读，不写回） |
| 防漂移单测 | `node --test test/package-identity.test.mjs` | 3 tests / 3 pass / 0 fail |
| pins 迁移单测 | `node --test test/pins-persist.test.mjs` | 7 tests / 7 pass / 0 fail |

与上游的差异（本支无对应能力，故改写）：

- 产物名没有 `+<timestamp>` 后缀 —— 上游那个后缀由 `scripts/pack.mjs` 生成，本支没有该脚本；
  `test/package-identity.test.mjs` 改为向 `npm pack --dry-run --json` 取真实产物名，不另造第二套命名规则。
- 无 `check:compat` 门禁（`scripts/check-compat.mjs` 属于 #10，本支未移植）。