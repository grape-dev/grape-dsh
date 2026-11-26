# 版本兼容矩阵（Compatibility Matrix）

本文件是 **grape-dsh 插件 / grape CLI / Grape 平台 API** 三者版本关系的唯一对照表。
三者发布载体与节奏都不同（插件 = 本地 tgz、CLI = PyPI、平台 = 服务端部署），
因此**不共用版本号**；出包、升级、排障都以本表为准。

- 发布产物对账：[`RELEASE-RECORD.md`](RELEASE-RECORD.md)
- 安装步骤：[`AGENT-DEPLOYMENT-GUIDE.md`](../AGENT-DEPLOYMENT-GUIDE.md)、[`USER-DEPLOYMENT-GUIDE.md`](../USER-DEPLOYMENT-GUIDE.md)

## 1. 当前组合（2026-11-20）

| 组件 | 版本 | 载体 / 获取方式 |
|---|---|---|
| `@grape-dev/grape-dsh` | **0.5.2** | npm（`dsh plugin --profile <p> add @grape-dev/grape-dsh@0.5.2`）或本地 tgz |
| grape CLI | **≥ 0.3.3**（本机实测 `0.3.3`） | `pip install grape` |
| Grape 平台 API | **v1**（路由当前未带版本前缀，形如 `/api/...`） | 服务端部署，`GET /api/health` 可达即视为在线 |
| dsh | **≥ 0.2.0**（本机实测 `0.2.2-rc.3`） | dsh 发行版 |
| Node.js | **≥ 18** | 插件构建与运行时 |
| Python | **≥ 3.10** | grape CLI 运行时 |

## 2. 兼容矩阵

| grape-dsh | 最低 grape CLI | 最低平台 API | 必需 capabilities | 备注 |
|---|---|---|---|---|
| `0.5.x` | `0.3.3` | v1 | —（平台尚未提供 `capabilities` 字段，见 §4） | 现行版本；接管（takeover）另需平台提供 takeover API |
| `0.4.x`（旧包名 `@grape-dev/dsh-grape`） | `0.3.3` | v1 | — | 包名即 dsh module id，与 `0.5.x` **不能共存**；升级须先 `remove` 旧包名再 `add` 新包名 |

> 改名分界：`0.4.3` 及以前 = `@grape-dev/dsh-grape`，`0.5.0` 起 = `@grape-dev/grape-dsh`。
> 迁移步骤见 [`MIGRATION-rename-to-grape-dsh.md`](MIGRATION-rename-to-grape-dsh.md)。

## 3. 版本策略（怎么 bump）

三个组件各自 SemVer，各自承诺「对下游破不破坏」：

| 组件 | major（破坏） | minor（新增） | patch（修复） |
|---|---|---|---|
| Grape 平台 | 删字段 / 改语义 / 加必填；同时暴露新的 `api_version` | 新端点、新 capability | 内部修复 |
| grape CLI | 命令、参数、`--json-out` 字段破坏 | 新命令、新增可选字段 | 修复 |
| grape-dsh | 面板行为破坏、**包名 / dsh module id 变更**、配置项改名 | 新工具、新面板、新能力 | 修复 |

硬规则：

1. **版本 bump 与改动同一个提交**：改名、删字段、改配置 key 都在同一个 PR 里 bump。
2. **一个版本号只对应一份内容**：内容不同就必须 bump（`0.5.0 → 0.5.1` 即因此产生）。
3. **预发布用 `-rc.N`**，不要用「同版本号 + 时间戳」表达语义差异（时间戳只区分构建）。
4. **`--json-out` 的输出字段属于 CLI 的公开契约**，删字段/改空值语义按破坏性变更处理。

## 4. 运行时判定：比能力，不比版本号

目标形态（平台侧改动见需求 F7）：

| 环节 | 现状 | 目标 |
|---|---|---|
| 平台 | `GET /api/health` 只返回 `server` / `agent_runtime` / `skill_consistency`，**无** `version`、`api_version`、`capabilities` | 增补 `version`、`api_version`、`capabilities[]`（如 `takeover_bundle.v2`、`worker.install.ps1`） |
| CLI | 只有文本 `grape --version` | 增补结构化版本（版本 + contracts 列表） |
| 插件 | `/check` 仅展示 grape CLI 版本，不做门禁 | 声明最低 CLI/API 要求，缺能力时给可读提示 |

插件侧的判定顺序（固定）：

1. 读平台 `capabilities` 与 CLI 版本（探测一次并缓存）；
2. **缺可选能力** → 走降级/回退路径（参考 `#9` 的 `404/405` 回落 legacy 端点）；
3. **缺必需能力** → 面板显示可读错误（「服务端不支持 X，请升级平台」），不抛 500；
4. 版本号**只用于提示升级**，绝不参与 `if (version >= ...)` 式的字符串比较。

## 5. 自检命令

```bash
grape --version                                   # 期望 >= 0.3.3
dsh --version                                     # 期望 >= 0.2.0
node --version                                    # 期望 >= v18
python -c "import sys;print(sys.version)"         # 期望 >= 3.10
curl -sS "$GRAPE_BASE_URL/api/health"             # 期望 {"server":"ok",...}
dsh --profile <profile> --dump-config | grep -A2 grape-tools   # 期望看到插件节点
```

安装/升级后如果面板报「grape CLI not found」，先确认 `GRAPE_CLI_BIN`（默认取 PATH 上的 `grape`）；
Windows 上以 `.cmd` / `.bat` 包装器提供的 CLI 会经 `cmd.exe /c` 调用，参数含 `&` / `^` / `%` 时不做原样透传保证。

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-18 | 建立本表：`grape-dsh 0.5.1` ↔ `grape-cli ≥ 0.3.3` ↔ `api v1`；平台 `capabilities` 待 F7 落地后补齐「必需 capabilities」列 |
| 2026-11-19 | 当前组合校准为 `grape-dsh 0.5.2`（Issue #24：Agent 一键安装 + 安装 Skill；无运行时契约变更） |
| 2026-11-20 | 当前组合校准为 `grape-dsh 0.5.2`（**修复 0.5.1 的设置保存失败**：`deviceName` 只加进了 TS 接口与设置面板输入框，运行时 `z.object` schema 未声明 → dsh 主机拒绝写入；0.5.2 在 schema 补声明并加回归测试「面板字段必须全部在 schema 里」） |
| 2026-11-20 | 当前组合校准为 `grape-dsh 0.5.1`（环境隔离与拉起修复：baseUrl/token 只认 `cordis.patch.yml`、`RUNTIME_SERVER_URL` 不一致视同无 worker、设备名可配置；**配置来源变更属 breaking**，依赖 `GRAPE_BASE_URL`/`GRAPE_API_TOKEN` 环境变量的部署升级后必须显式写 config） |