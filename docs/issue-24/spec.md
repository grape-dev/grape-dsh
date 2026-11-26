# Issue #24 需求文档（Spec）

> 来源：Issue #24 · Spec 评论 `202076012` · 开发基准 `dev-ch-11` · 2026-11-19

## 目标

让任意 agent（dsh / Claude Code / Codex / opencode）拿到本仓库后，无需人工解释即可自助装好
`@grape-dev/grape-dsh`：两份 README 提供可整段复制的提示词与最短命令，仓库内提供可被 agent
直接读取的安装 Skill。

## 现状（基于 `dev-ch-11` 核对）

- `package.json` / `package-lock.json` 版本为 `0.5.1`。
- `README.md`、`docs/README.zh.md` 均无「Agent 一键安装」小节，且仍有 `Highlights (0.4.0)` /
  `0.4.0 亮点` 与 tarball 示例 `grape-dev-grape-dsh-0.4.0.tgz`。
- 仓库根目录没有 `skills/`，安装 Skill 属新增交付。
- 已有 `AGENT-DEPLOYMENT-GUIDE.md`、`USER-DEPLOYMENT-GUIDE.md`、`USER-DEPLOYMENT-GUIDE.zh.md`，
  本任务需从 README 链向它们，不重写其内容。

## 范围

### In Scope

1. `README.md` 与 `docs/README.zh.md` 靠前位置新增「Agent 一键安装 / Let an agent install it」小节：
   可整段复制的提示词（检查 Node/Python → 安装插件 → 校验 → 回报能力）、最短命令
   `dsh plugin --profile <profile> add @grape-dev/grape-dsh`、安装 Skill 的调用方式，并链向
   `AGENT-DEPLOYMENT-GUIDE.md` / `USER-DEPLOYMENT-GUIDE(.zh).md` 与新增的安装 Skill。
2. 保留 npm / git / tarball / link 四条安装路径；tarball 示例版本更新为 `0.5.2`；
   `Highlights (0.4.0)` 等过期小节校准到 0.5.x；中英两份信息一一对应，交叉链接可点。
3. 新增 `skills/grape-dsh-install/`，遵循 huawei-cloud-skill-creator 规范：
   `SKILL.md`（frontmatter `name`/`description` 齐全，description 带触发词）+ `references/` +
   `scripts/` + `templates/` + `phase-1..6-summary.json`。
4. Skill 职责：幂等安装到指定 dsh profile；前置 Node>=18 / Python>=3.10 / grape>=0.3.3；
   安装后验收 `dsh plugin` 列表 + `grape auth profile` + 面板/工具出现；失败按 creator gate
   语义停机并回报命令原文、退出码、前 20 行输出；全程不打印 token；说明华为云凭据门禁为何不适用
   （不操作云资源、不伪造 hcloud 命令）。
5. 版本补丁位 bump `0.5.1 → 0.5.2`：`package.json`、`package-lock.json`、
   `docs/RELEASE-RECORD.md` 三处一致（`docs/COMPATIBILITY.md` 的「当前组合」同步校准）。

### Out of Scope

- 不改 `src/tools/**` 与 33 个 `grape_*` 工具的行为/对外契约。
- 不注册 npx skills registry；README 只写仓库内临时用法。
- 不删除既有文档链接，不做营销化改写。
- 不操作任何华为云资源，不生成 hcloud 命令。

## 期望行为

### 任务一 · README 中英同步

1. 在 `What it is` 之后、`Requirements` 之前插入「Agent 一键安装 / Let an agent install it」：
   - 提示词代码块可整段复制；
   - 一条最短命令；
   - Skill 调用方式（`skills/grape-dsh-install/SKILL.md`，未注册 registry 的临时用法）；
   - 链向 agent/user 部署指南。
2. 「Highlights」校准为 0.5.x 真实变更（改名、接管令牌回收、cwd 回退、Agent 安装体验）。
3. tarball 示例改为 `grape-dev-grape-dsh-0.5.2.tgz`。

### 任务二 · 安装 Skill

- 目录：`skills/grape-dsh-install/{SKILL.md,references/,scripts/,templates/,phase-N-summary.json}`。
- frontmatter：`name: grape-dsh-install`，`description` 含功能摘要 + 中英触发词，无 `version`，`tags` ≤5。
- 脚本：前置检查、幂等安装、验收（bash + PowerShell 双份）。
- 失败语义：停机，输出命令原文、退出码、前 20 行；不打印 token。
- 华为云凭据门禁说明：本 Skill 只装 dsh 插件、不调用 hcloud/云 API，故门禁不适用。

## 验收标准

- [ ] 两份 README 均含新小节，命令一致、信息一一对应、链接可点。
- [ ] 提示词可整段复制，README 中每条命令真实可跑。
- [ ] 四条安装路径保留，tarball 示例为 0.5.2。
- [ ] `skills/grape-dsh-install/` 结构合规，frontmatter 合法，触发词齐全。
- [ ] Skill 覆盖前置检查、幂等安装、三项验收、失败回报与 token 保护。
- [ ] Skill 说明华为云凭据门禁不适用，无伪造 hcloud 命令。
- [ ] 版本三处一致为 0.5.2。
- [ ] `npm run typecheck` 与 `npm test` 通过（基线 176 tests / 1 skip 不退化）。
- [ ] PR 描述贴出用户复制给 agent 的提示词原文。

## 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 双语 README 漂移 | 中 | 同小节逐条对照后自审查 |
| 写入未注册 registry 的命令 | 中 | 只写仓库内路径 + 现有 CLI 命令 |
| `package-lock.json` 漏改 | 低 | 三处版本一致性核对 |
| `skills/` 被构建/测试误扫描 | 低 | 纯 md/json/sh/ps1，不进 tsconfig 与 test glob |