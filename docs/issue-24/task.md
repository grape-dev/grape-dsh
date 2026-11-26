# Issue #24 任务拆解与验收对照（Task）

> 目标合入分支 `dev-ch-11`；开发分支 `feat/issue-24`。
> 本任务为零运行时改动的文档 + 静态 Skill 交付，不使用 TDD 红/绿拆分；以「结构校验 + 命令实测 + 回归」
> 作为验证手段。

## 切片

| # | 切片 | 交付物 | 验证方式 | 状态 |
|---|---|---|---|---|
| 1 | 过程文档 | `docs/issue-24/{spec,plan,task}.md` | 人工核对与 Spec 一致 | 完成 |
| 2 | README 新增小节 | `README.md` 的「Let an agent install it」 | 命令与本机 CLI 对齐 | 完成 |
| 3 | README 中文新增小节 | `docs/README.zh.md` 的「Agent 一键安装」 | 与英文逐条对应 | 完成 |
| 4 | 过期小节校准 | 两份 README 的 Highlights → 0.5.x、tarball → 0.5.2 | `grep 0.4.0` 归零 | 完成 |
| 5 | 安装 Skill | `skills/grape-dsh-install/**` | 结构 + frontmatter + 脚本语法 | 完成 |
| 6 | 版本 bump | `package.json` / `package-lock.json` / `RELEASE-RECORD.md` / `COMPATIBILITY.md` | 四处一致 0.5.2 | 完成 |
| 7 | 回归 | `npm run typecheck` / `npm test` | 基线 176 tests / 1 skip 不退化 | 完成 |
| 8 | 交付 | PR + Issue 评论 + A2A QA | 链路可达 | 完成 |

## 验收条款 → 位置 → 验证

| 验收条款 | 位置 | 验证 |
|---|---|---|
| 两份 README 新小节信息一一对应 | `README.md` / `docs/README.zh.md` | 逐条对照（见下表） |
| 提示词可整段复制 | 两份 README 代码块 | 块内无图片/占位符，命令完整 |
| 最短命令可跑 | `dsh plugin --profile <profile> add @grape-dev/grape-dsh` | 与本机 `dsh plugin --help` 语法一致 |
| 四条安装路径保留 | README「Install」 | npm / git / tarball / link 均在 |
| tarball 版本 0.5.2 | README 示例 | `grep grape-dsh-0.5.2.tgz` |
| Skill 结构合规 | `skills/grape-dsh-install/` | SKILL.md + references + scripts + templates + phase-1..6 |
| frontmatter 合规 | `SKILL.md` | name=目录名、description 带触发词、无 version、tags≤5 |
| 前置检查齐全 | `scripts/preflight.*` | Node>=18 / Python>=3.10 / grape>=0.3.3 / dsh |
| 验收项齐全 | `scripts/verify.*` | plugin 列表 + dump-config + `grape auth profile` |
| 失败停机回报 | SKILL.md + scripts | 命令原文 + 退出码 + 前 20 行 |
| 不打印 token | SKILL.md 安全规则 + scripts | 只判空/长度，不 echo 值 |
| 华为云门禁 N/A | SKILL.md + `references/cloud-credential-gate.md` | 明确不调 hcloud、不伪造命令 |
| 版本一致 0.5.2 | package*.json / RELEASE-RECORD / COMPATIBILITY | `grep` 三处一致 |
| 工具契约不变 | `src/**` 未改 | `git diff --stat` |
| typecheck/test | 工程 | 命令输出 |

## 双语文档对照

| 英文（README.md） | 中文（docs/README.zh.md） |
|---|---|
| Let an agent install it | Agent 一键安装 |
| paste the prompt / one-line command | 粘贴提示词 / 一条最短命令 |
| Agent-deployment runbook link | Agent 部署手册链接 |
| User deployment guide (EN + ZH) | 用户部署指南（中/英） |
| Install skill path | 安装 Skill 路径 |

## 验证记录（真实命令）

| 场景 | 命令 | 实际结果 |
|---|---|---|
| 版本一致 | `Select-String package.json/package-lock.json/RELEASE-RECORD/COMPATIBILITY` | `0.5.2`：package.json:3、package-lock.json:3/9、RELEASE-RECORD「当前源码版本」、COMPATIBILITY 当前组合 + 变更记录 |
| 过期小节 | `Select-String README.md docs/README.zh.md -Pattern 0.4.0` | 0 命中；`0.5.2` 各 2 处（亮点 + tarball） |
| 类型检查 | `npm run typecheck` | exit 0 |
| 全量测试 | `npm test` | 176 tests / 175 pass / 1 skip / 0 fail |
| 打包计划 | `npm pack --dry-run --json --ignore-scripts` | exit 0；entryCount 82；`skills/` 0 命中、`docs/issue-*` 0 命中 |
| Skill 结构 | `Get-ChildItem skills/grape-dsh-install -Recurse` | 20 文件；SKILL.md + references×5 + scripts×7 + templates + phase-1..6 |
| frontmatter | Python `yaml.safe_load` | keys `[description, name, tags]`；name=`grape-dsh-install`；tags=4；无 version |
| JSON | Python `json.load` 全部 JSON | 全部可解析 |
| bash 语法 | `bash -n` × 4 | exit 0 |
| PowerShell preflight | `powershell -File scripts/preflight.ps1` | exit 0；GATE 1 PASSED（node 26.13.1 / python 3.12.10 / grape 0.3.4 / dsh 0.2.2-rc.3） |
| Skill 测试集 | `bash scripts/test-cli-commands.sh` | 4 pass / 0 fail / 3 skip（TC-05 无 user key；TC-06/07 mutating） |
| 未执行 | `install.*` / `verify.*` | 会改动本机 dsh profile 且需 user key；已做语法检查，流程由 GATE 2/3 文档约束 |