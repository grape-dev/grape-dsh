# @grape-dev/grape-dsh

面向 **DeepSeek Harness (dsh)** 的 Grape DevOps 流水线工具插件 —— 在本地 agent 里触发、监控并接管
[Grape](https://gitcode.com/grape-dev/grape) 的多 agent DevOps 流水线。

[English](../README.md) | **中文**

---

## 这是什么

[Grape](https://gitcode.com/grape-dev/grape) 是一个多 agent 协作的 DevOps 平台，流水线节点
（VOD → Issue → Coding → QA → SRE）覆盖从需求受理到部署运维的全生命周期。

本插件把 Grape 以两种形态接进 dsh：

| 形态 | 内容 |
|---|---|
| **33 个面向模型的工具**（`grape_*`） | 流水线触发/状态、Issue 生命周期、事件、场景、仓库、技能、知识库、仪表盘、项目模板 |
| **侧栏面板 + 聚焦卡片** | 每个 Issue 的实时流水线卡片、节点链、接管操作、worker 注册入口 |

两种形态都通过 **grape CLI 子进程**（面板/接管路由走 Grape HTTP API）访问 Grape，
插件自身不保存任何密钥。

---

## Agent 一键安装

把下面整段复制给你的 coding agent（dsh / Claude Code / Codex / opencode）。它会检查工具链、
安装插件、验证结果，并回报 agent 拿到了哪些能力。

```text
在这台机器上为 DeepSeek Harness (dsh) 安装 grape-dsh 插件。全程非交互执行，任一门禁失败立即停止。

1. 前置检查 —— 报告精确版本：
   node --version          # 要求 >= 18
   python3 --version       # 要求 >= 3.10（Windows：py -3 --version）
   grape --version         # 要求 >= 0.3.3
   dsh --version           # 要求 >= 0.2.0
   缺少工具时，按 AGENT-DEPLOYMENT-GUIDE.md 里的平台配方安装后重跑本步。
2. 选 profile —— 选用户实际启动的那个，不要猜：
   读 DSH_PROFILE（读不到就问）。桌面端固定启动 `desktop`；装进 `grape` 在桌面端永远看不到，
   因为 `dsh grape` 是另一套浏览器 UI。
3. 安装 —— 已发布版本直接走 npm（0.5.0 起 tarball 含 lib/）：
   dsh plugin --profile <profile> add @grape-dev/grape-dsh@0.5.2
   未发布的分支/本地改动则源码构建 tarball 再安装 bundle：
   git clone --depth 1 https://gitcode.com/grape-dev/grape-dsh.git
   bash grape-dsh/skills/grape-dsh-install/scripts/install.sh <profile>
   （Windows：pwsh -File grape-dsh\skills\grape-dsh-install\scripts\install.ps1 -Profile <profile>）
   脚本维护稳定构建目录、编译 lib/、打包 tarball 并安装（等价于 plugin_manager install_bundle <tgz 绝对路径>），回显稳定的 tgz 路径；输出 "skipped: already-present" 表示该版本已安装。
4. 验证 —— 先重启该 profile（新装的包只在启动时加载），再要求三项全部通过：
   dsh plugin --profile <profile> list        # 含 @grape-dev/grape-dsh
   dsh --profile <profile> --dump-config      # `id: grape-tools` 恰好出现一次
   GRAPE_CLI_MODE=USER grape auth profile     # 返回用户 profile（需要 GRAPE_BASE_URL + GRAPE_API_TOKEN）
5. 回报 —— profile 名、node/python/grape/dsh 版本、grape-tools 是否挂载、dsh 会话暴露了哪些 grape_* 工具。不要打印任何 token 值。
任一门禁失败：停止并回报命令原文、退出码与前 20 行输出。
```

最短手工命令：

```bash
# 已发布版本（0.5.0 起 tarball 含 lib/）
dsh plugin --profile <profile> add @grape-dev/grape-dsh@0.5.2

# 未发布的分支/本地改动：构建 tarball 再安装
git clone --depth 1 https://gitcode.com/grape-dev/grape-dsh.git
bash grape-dsh/skills/grape-dsh-install/scripts/install.sh <profile>
```

Windows：`pwsh -File grape-dsh\skills\grape-dsh-install\scripts\install.ps1 -Profile <profile>`。
脚本会回显稳定的 tarball 绝对路径；在 dsh 会话内直接调用时，把该路径传给
`plugin_manager install_bundle`。

profile 还不存在时，要先用 shipped 模板建出带 app bundle 的 profile —— 只跑
`dsh plugin --profile <name> list` 得到的是只有 base、没有 UI 的空 profile：
`dsh --profile <name> --from-default-profile web --dump-config`。

同一套流程已封装为安装 Skill：**[skills/grape-dsh-install/SKILL.md](../skills/grape-dsh-install/SKILL.md)**。
它目前是仓库内路径、尚未发布到 skills registry —— 请从仓库检出中加载（按你的 agent 支持的方式，
用文件引用或直接给路径）。

完整门禁与排障：**[AGENT-DEPLOYMENT-GUIDE.md](AGENT-DEPLOYMENT-GUIDE.md)** ·
用户部署流程：[USER-DEPLOYMENT-GUIDE.zh.md](USER-DEPLOYMENT-GUIDE.zh.md) · [English](USER-DEPLOYMENT-GUIDE.md)

---

## 0.5.x 亮点

> 已发布版本：**0.5.0**（首个 npm 版本）→ **0.5.1**（环境隔离 + 拉起修复）→ **0.5.2**（运行时 schema 补声明
> `deviceName`；0.5.1 只在设置页加了输入框、主机侧 schema 没声明，导致点保存失败）。
> 下文括号里的 `0.5.1` / `0.5.2` 指 dev-ch 早期的**内部里程碑**（从未发布），与 npm 上同名版本不是同一份产物。

- **Agent 一键安装（0.5.2）** —— 可复制提示词 + 仓库内安装 Skill，把 agent 从「刚拿到仓库」
  带到「已验证的 profile」：前置检查、安装、`dsh plugin` / `grape auth profile` 校验、能力回报。
- **包名即 module id（0.5.0）** —— 包名为 `@grape-dev/grape-dsh`；旧包名 `@grape-dev/dsh-grape`
  安装后不能共存。迁移说明见
  [docs/MIGRATION-rename-to-grape-dsh.md](MIGRATION-rename-to-grape-dsh.md)。
- **接管加固（0.5.1）** —— 移除 DIAG 落盘诊断、宿主重启后恢复工作目录、释放接管令牌。
- **任务接管（Takeover）** —— 把一个正在跑的流水线节点交给「人 + 本地 agent」：Grape 取消云端任务、
  渲染完整上下文（技能包 / 项目图谱 / 历史日志 / 原始 prompt），插件在本地开一个 dsh 会话并送入 prompt，
  进展实时回流平台，`finish` 产出结构化结论并派发下一节点。
- **接管脚本由服务端按平台渲染** —— Linux/macOS 出 `.sh`，Windows 出带 UTF-8 BOM 的 `.ps1`；
  插件只负责落盘并把 `{{CWD}}` 换成本机工作目录。
- **面板内注册本机 worker** —— 自动签发 `rta_` 凭据，安装命令按平台选择
  （Linux/macOS → `install.sh`，Windows → `install.ps1`）。
- **跨平台** —— Linux、macOS、Windows 均可。路径判定、家目录、会话定位、压缩包解压都去掉了 POSIX 假设。
- **结构化结论** —— 接管完成写入与 worker 任务同构的
  `conclusion / actions / artifacts / next_step / issue_summary`，Grape 事件详情页渲染一致。

---

## 前置条件

| 依赖 | 版本 | 用途 |
|---|---|---|
| dsh | >= 0.2.0 | 宿主运行时 |
| Node.js | >= 18 | dsh 与插件运行时 |
| Python | >= 3.10 | grape CLI |
| grape CLI | >= 0.3.3 | 工具传输（`grape … --json-out`） |
| Grape 服务端 | 含接管 API | 接管、worker 注册、面板路由 |

还需要：Grape **用户级 API Key**（`grape_…`，在 Grape Web → 设置里创建）和 Grape 访问地址
（如 `http://localhost:8000` 或 `https://www.grapedev.cn`）。

---

## 安装

两种方式，**优先第一种**（除非你要逐条自己执行每条命令）。

### A. 交给 agent 安装（推荐，走 skill）

仓库自带安装技能：**[skills/grape-dsh-install/SKILL.md](../skills/grape-dsh-install/SKILL.md)**。
把它交给 agent（dsh / Claude Code / Codex / opencode），然后说：

```text
按 skills/grape-dsh-install/SKILL.md，把 @grape-dev/grape-dsh 安装到 dsh 的 <profile>。
按 preflight → install → verify 顺序执行；任一门失败就停下，并回报原始命令、退出码和前 20 行输出。
```

确定性的那一半是一条脚本：

```bash
git clone --depth 1 https://gitcode.com/grape-dev/grape-dsh.git
bash grape-dsh/skills/grape-dsh-install/scripts/install.sh <profile>
# Windows：pwsh -File grape-dsh\skills\grape-dsh-install\scripts\install.ps1 -Profile <profile>
```

脚本会自己编译 `lib/`、打包 tarball、安装 bundle，并打印稳定的 tgz 路径
（`skipped: already-present` 表示该版本已安装，重复执行安全）。
带 preflight/verify/汇报要求的整段 prompt 见上文「Agent 一键安装」；各道门的判定与实测失败修法见
**[AGENT-DEPLOYMENT-GUIDE.md](AGENT-DEPLOYMENT-GUIDE.md)**。

### B. 手动安装

```bash
# 1) 已发布版本（0.5.0 起 tarball 含 lib/）—— 最短路径
dsh plugin --profile <profile> add @grape-dev/grape-dsh@0.5.2

# 2) 未发布的分支/本地改动：源码构建 tarball 再安装
git clone --depth 1 https://gitcode.com/grape-dev/grape-dsh.git
cd grape-dsh && bash skills/grape-dsh-install/scripts/install.sh <profile>

# 3) 或安装已构建好的 tarball（内网/离线）
npm pack
dsh plugin --profile <profile> add file:/abs/path/grape-dev-grape-dsh-<version>.tgz
#    在 dsh 会话里等价做法：plugin_manager install_bundle "<tgz 绝对路径>"

# 4) git 依赖（可用，但可能撞 pnpm 的 prepare 脚本审批门 —— 优先用 tarball）
dsh plugin --profile <profile> add git+https://gitcode.com/grape-dev/grape-dsh.git

# 5) 本地开发（link）
cd /path/to/grape-dsh && pnpm link --global
cd ~/.dsh/profiles/<profile> && pnpm link @grape-dev/grape-dsh
```

需要可复现的 profile 时把版本钉住（`@0.5.2`）；当前已发布版本以
`npm view @grape-dev/grape-dsh version` 为准。
装完后按「配置」一节补 `grape-tools`，再验证：

```bash
dsh plugin --profile <profile> list        # 应包含 @grape-dev/grape-dsh
dsh --profile <profile> --dump-config      # 应包含 id: grape-tools
```

完整流程（前置条件 → 逐步验证 → worker 注册 → 排障）见
**[USER-DEPLOYMENT-GUIDE.zh.md](USER-DEPLOYMENT-GUIDE.zh.md)** · [English](USER-DEPLOYMENT-GUIDE.md)

### 发布说明（维护者）

`npm publish` 会先跑 `prepare` → `tsc`，所以必须在已装 devDependencies 的目录里发布：

```bash
npm ci && npm run build
npm pack --dry-run --json     # 先核对文件清单（lib/、skills/、docs/、LICENSE）
npm publish
```

---

## 配置

`baseUrl` / `token` / `deviceName` 都配在 profile 的 `cordis.patch.yml`（`grape-tools.config`）里。
**`baseUrl` 与 `token` 都只认这个文件**：插件不再读 `GRAPE_BASE_URL` / `GRAPE_SERVER_URL` /
`GRAPE_API_TOKEN`，也没有内置默认地址 —— 环境配错会直接报错，不会悄悄连到另一个环境、
也不会借用另一个环境的令牌。

```yaml
- id: grape-tools
  name: '@grape-dev/grape-dsh'
  config:
    baseUrl: 'https://beta.grapedev.cn:9443'  # 必填 —— 环境的唯一来源
    token: 'grape_xxx'                        # 必填 —— 只认 config（不读 GRAPE_API_TOKEN）
    deviceName: 'dsh-worker-001'              # 可选，必须以 dsh 开头（默认 dsh-<hostname>）
    bin: ''                                   # 可选 → GRAPE_CLI_BIN 或 PATH 中的 grape
    timeout: 30
```

环境隔离：本机 worker 在 `~/.grape/runtime.env` 里的 `RUNTIME_SERVER_URL` 必须与 `config.baseUrl` 一致。
不一致时面板判定**本环境没有 Worker**（显示「环境不匹配」），拒绝启动/重启该进程，唯一动作是
「接入本机」重新安装 —— 会重写 `runtime.env`，并按配置的设备名重新签发凭据。

设备名优先级（`/onboard` 唯一口径，服务端查询与签发/安装用同一个名字）：
`config.deviceName` → 本机 `runtime.env` 的 `RUNTIME_DEVICE_NAME` → `dsh-<hostname>`。
所以**新接入 / 改名以配置为准**；`runtime.env` 只是上一次安装的产物，不会盖过配置。
改名（配置名 ≠ 运行中名字）时必须先「注销本机」（会停掉旧进程），再「接入本机」——
运行中热改会让旧进程带着旧名字继续心跳，服务端出现两个身份。
服务端状态读不出来时（API Key 失效 / 网络不可达），本机已装 worker 会直接拒绝接入，
不会猜成「新机器」再签发一条凭据。

环境变量仍可用于独立的 CLI（`GRAPE_BASE_URL` / `GRAPE_API_TOKEN` / `GRAPE_TIMEOUT` / `GRAPE_CLI_BIN`），
但插件本身只从 config 解析 `baseUrl` 与 `token`。

---

## 工具（33 个）

| 分组 | 工具 |
|---|---|
| 流水线（5） | `grape_trigger_pipeline` `grape_get_task_status` `grape_wait_task` `grape_get_pipeline_info` `grape_get_pipeline_roadmap` |
| Issue（10） | `grape_list_issues` `grape_list_my_issues` `grape_get_issue_detail` `grape_create_issue` `grape_cancel_issue` `grape_resume_issue` `grape_start_issue` `grape_get_issue_events` `grape_list_repo_events` `grape_search` |
| 事件（1） | `grape_terminate_event` |
| 场景（3） | `grape_list_scenes` `grape_apply_scene` `grape_list_scenes_for_repo` |
| 仓库（5） | `grape_list_managed_repos` `grape_list_repos_member` `grape_get_repo_project_info` `grape_host_repo` `grape_sync_repos` |
| 技能（3） | `grape_list_skills` `grape_get_skill_detail` `grape_search_skills` |
| 知识库（2） | `grape_list_knowledge` `grape_get_knowledge_detail` |
| 仪表盘（2） | `grape_get_repo_dashboard` `grape_get_ops_overview` |
| 模板（2） | `grape_list_project_templates` `grape_create_project` |

设计边界：**只触发、只观察、可推进（用户决策）、不干预节点间交接**。A2A 交接留在 Grape 内部。
接管是唯一明确的例外：由用户授权，用本地会话替换云端任务。

---

## 流水线状态口径

面板**不再写死 5 个节点**：节点链来自该 issue 的**场景节点**
（`scenes detail --scene_id … --repo …`）；场景拉不到时退化为事件段首次出现顺序，并标注
「场景未知，按事件推断」。整体状态与进度以 Grape 业务字段为准，不读 pipeline 顶层 `status`。

| Grape 字段 | 展示 |
|---|---|
| `issue_task_status=completed` 或 `issue_stage=done` | 已完成 |
| `pending_review`（`issue_task_status` / `review_status`） | 待审核 |
| `active` / `processing` / `running` | 进行中 |
| `failed` / `cancelled` | 失败 / 已取消 |
| 场景内未跑过的节点 | 待开始 |
| 节点出现在其他节点的 `skip` 列表 | 已跳过 |

- 同一 tag 因重派/重试多次出现：取 `seq` 最大那条，链上**只占一格**并显示「重试 N 次」。
- 场景外节点照常显示并标「场景外」。
- 进度 = 已完成格数 / 渲染格数（场景节点去重），保证 `done ≤ total` 且分母 == 节点格数。
- pipeline 顶层 `status` 只作**事件级提示**（本次事件是否跑完），**绝不**用来显示「已完成」。

---

## 接管流程

```
面板 → Issue 卡片 → 在运行中的节点上点「接管」
  1. Grape 取消云端任务，签发 tko_ token（限定本仓库，12h）
  2. 服务端按宿主 OS 渲染 prompt + 资产
  3. 插件物化工作区，并自动开一个本地 dsh 会话送入 prompt
  4. 本地 agent 上报进展  →  .grape-takeover-report.sh|ps1
  5. 本地 agent 提交小结  →  .grape-takeover-request-finish.sh|ps1
  6. 用户点「确认完成 · 派发下一节点」→ Grape 写入结构化结论并派发下一节点（绝不重做本节点）
放弃接管 = 把节点交还流水线，Grape 重新派发「当前」节点。
```

---

## 本机 Worker 状态

面板不再把本机状态折叠成单一 `running` 布尔值。宿主把「本地事实」与「服务端
`runtime-devices` 行的 `health / last_seen_at / worker_version`」合成 12 种状态：

- **2×`RUNTIME_HEARTBEAT_INTERVAL` 窗口内以服务端心跳为准。** 服务端显示 `online` 时，
  本机探测失败只会显示「探测不可用 / 服务端在线」，不再判「未运行」，也不会触发自动拉起。
- **探测失败永不拉起。** 超时、`powershell`/`ps` 不可用、权限错误都是一等状态
  （`probe-failed`、`server-online-probe-failed`）。
- **拉起护栏。** 只要发现任一存活 agent 进程（含子进程与非 venv 解释器），或探测失败，
  拉起路由一律拒绝再拉第二份 worker。
- **拉起后核对。** 拉起后重新读取 `runtime.env`，核对 `RUNTIME_DEVICE_NAME` /
  `RUNTIME_SERVER_URL` / `RUNTIME_TOKEN` 与服务端设备行，并回写 pid、退出码与 stderr 摘要。
- **面板可诊断。** 设备卡新增可折叠「判定依据」与「复制诊断信息」按钮；复制文本已脱敏
  （`RUNTIME_TOKEN`、`tk_`、`grape_`、`tko_`、`rta_`、`Bearer`、`api_key` 等）。

状态机图与故障排查树见 `docs/local-worker-and-takeover-stop.md` 第八节。

---

## 架构

```
dsh agent（DeepSeek 模型）
  → 调用 grape_* 工具
    → execGrape() spawn `grape … --json-out`
      → grape CLI → Grape HTTP API（FastAPI）
    → 单行 JSON 解析 → 返回模型
    → presentCall / render / presentResult 渲染结构化卡片

dsh 侧栏面板（client 半边）
  → /grape-worker-api/*（插件宿主路由）
    → Grape 面板 / 接管 / worker 端点
```

---

## 开发

```bash
npm install
npm run typecheck    # 服务端半边 + client 半边
npm run build        # 编译到 lib/ 并打包 client
npm run dev          # watch 模式
```

## 许可证

MIT