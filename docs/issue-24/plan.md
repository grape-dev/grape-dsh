# Issue #24 方案设计（Plan）

## 方案概述

纯文档 + 新增静态 Skill 目录 + 版本补丁位变更，零运行时逻辑改动：

- README 双语新增同一结构的小节，命令与链接逐条对应；
- `skills/grape-dsh-install/` 按 creator 六阶段产物落盘（SKILL.md + references + scripts +
  templates + phase-N-summary.json），脚本只做检查/安装/验收，不做云操作；
- 版本 0.5.1 → 0.5.2，三处必需文件 + 兼容矩阵的「当前组合」同步。

## 实现路径

1. 读现状：两份 README、两份部署指南、`docs/RELEASE-RECORD.md`、`docs/COMPATIBILITY.md`。
2. 写 `docs/issue-24/{spec,plan,task}.md` 并提交。
3. 编辑 `README.md` / `docs/README.zh.md`：
   - 新增「Agent 一键安装 / Let an agent install it」；
   - `Highlights (0.4.0)` → `Highlights (0.5.x)`，按真实 release 记录改写；
   - tarball 示例 → `0.5.2`。
4. 新增 Skill：
   - `SKILL.md`：Overview / Prerequisites / Workflow / Core Commands / Parameter Confirmation /
     Verification / Failure Handling / Huawei Cloud credential gate (N/A) / Reference Documents；
   - `references/`：命令清单、验收方法、验收标准、排障、云门禁说明；
   - `scripts/`：`preflight.sh|ps1`、`install.sh|ps1`、`verify.sh|ps1`、`test-cli-commands.sh`；
   - `templates/test-vars.json`；`phase-1..6-summary.json`。
5. 版本 bump：`package.json`、`package-lock.json`（两处）、`docs/RELEASE-RECORD.md`、
   `docs/COMPATIBILITY.md`（当前组合 + 变更记录）。
6. 自检：`npm run typecheck`、`npm test`、命令真实可跑核对、frontmatter YAML 解析。
7. 自审查 + pre-pr 增量检查 → 建 PR（base `dev-ch-11`）→ Issue 评论 → A2A QA。

## 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 提示词位置 | README 靠前（What it is 之后） | agent/用户第一眼可见，不被安装细节淹没 |
| 提示词语言 | 各 README 用本语言、语义等价 | Issue 要求中英一一对应 |
| Skill 分发 | 仓库内路径 + 临时用法说明 | 未注册 registry，禁止写不可用命令 |
| Skill 脚本 | bash + PowerShell 双份 | 插件跨平台，README 也覆盖 Windows |
| 版本位 | patch 0.5.2 | Issue 明确语义化补丁位 |
| phase 摘要 | 保留 6 份 | Issue 明确要求交付 `phase-N-summary.json` |
| 华为云门禁 | 在 SKILL.md 与 references 显式说明 N/A | 不伪造 hcloud、不因无关门禁卡住 |

## 影响模块

| 模块 | 改动类型 |
|---|---|
| `README.md` / `docs/README.zh.md` | 新增小节 + 校准过期小节 + tarball 版本 |
| `skills/grape-dsh-install/**` | 新增 |
| `package.json` / `package-lock.json` | version 0.5.2 |
| `docs/RELEASE-RECORD.md` | 0.5.2 记录规则条目 |
| `docs/COMPATIBILITY.md` | 当前组合 + 变更记录 |
| `docs/issue-24/**` | 新增过程文档 |
| `src/**` / `test/**` / 工具契约 | 不改 |

## 测试 seam

- 文档层：命令逐条与本机 `dsh` / `grape` 实际 `--help`/`--version` 对齐；frontmatter 用 YAML 解析器验证。
- 工程层：`npm run typecheck` + `npm test`（确保新增目录不被扫描、基线不退化）。
- 打包层：`npm pack --dry-run --json` 确认 `skills/` 与 `docs/issue-*` 不进产物。