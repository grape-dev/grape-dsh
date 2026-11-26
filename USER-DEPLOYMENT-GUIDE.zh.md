# grape-dsh —— 用户部署指南

> 面向想在 DeepSeek Harness (dsh) 里使用 Grape 流水线工具的用户。
> 覆盖 Linux、macOS、Windows（原生 PowerShell）；Windows + WSL2 视为 Linux。

[English](USER-DEPLOYMENT-GUIDE.md) | **中文**

---

## 0. 平台支持

| 平台 | 状态 | 说明 |
|---|---|---|
| Linux（Ubuntu 22.04+、CentOS/RHEL） | 完全支持 | 基准平台 |
| macOS 12+ | 完全支持 | Node/Python 用 brew 装，其余步骤同 Linux |
| Windows 10/11 原生 | 支持 | 安装走 PowerShell（`install.ps1`），接管脚本写 `.ps1` |
| Windows + WSL2 | 支持 | 在 WSL 里按 Linux 步骤走 |

---

## 1. 前置条件

| 依赖 | 版本 | 用途 |
|---|---|---|
| dsh | >= 0.2.0 | 宿主运行时 |
| Node.js | >= 18（推荐 22） | dsh + 插件 |
| pnpm | >= 8 | dsh profile 依赖管理 |
| Python | >= 3.10 | grape CLI |
| grape CLI | >= 0.3.3 | 所有 `grape_*` 工具的传输层 |
| Grape 服务端 | 本机可达 | 平台本体 |

开始前先准备：

- Grape 访问地址，如 `http://<grape-host>:8000` 或 `https://www.grapedev.cn`
- Grape **用户级 API Key**（`grape_…`），在 Grape Web → 设置 → API Keys 创建
- 驱动 dsh 的 LLM API Key（DeepSeek / 中转站等）
- 仅接管需要：本机能访问 Grape 服务端，且本地有 `git` 和一个可用的 dsh 会话

---

## 2. 安装运行时依赖

### 2.1 Node.js

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs

node --version    # 期望 v22.x 或更高
```

macOS：`brew install node`。Windows：装 Node 22 LTS（MSI），新开 PowerShell 验证。

### 2.2 pnpm 与 dsh

```bash
sudo npm install -g pnpm
pnpm --version

sudo npm install -g @deepseek-ai/dsh
dsh --version
```

macOS/Windows 命令相同，去掉 `sudo`（Windows 用管理员 PowerShell）。

### 2.3 Python 与 grape CLI

```bash
python3 --version          # >= 3.10

# 系统级安装（最省事）
pip install grape --break-system-packages   # PEP 668 环境需要这个参数

# 或用 venv（受限主机推荐）
python3 -m venv ~/.grape-cli && ~/.grape-cli/bin/pip install grape
sudo ln -sf ~/.grape-cli/bin/grape /usr/local/bin/grape

grape --version
which grape
```

Windows 原生：

```powershell
py -3 --version
py -3 -m pip install grape
# grape.exe 在 %LOCALAPPDATA%\Programs\Python\Python3xx\Scripts
where.exe grape
# 不在 PATH 时，把 GRAPE_CLI_BIN 指向 grape.exe 全路径
```

---

## 3. 创建 dsh profile

> 本指南用独立 profile `grape`，它只在 `dsh grape` 里可见。装进 DeepSeek Harness 桌面端的话，
> 桌面端固定启动 `desktop` profile —— 把下文所有 `grape` 换成 `desktop`，不要另建。

```bash
dsh plugin --profile grape list     # 首次使用会创建 profile
```

> 首次创建得到的 profile 只有 `@deepseek-ai/dsh-base`，没有 app bundle，`dsh grape` 起不到 Web UI。
> 需要界面时先 `dsh --profile grape --from-default-profile web --dump-config`，再装插件。

---

## 4. 安装插件

### 4.1 npm（推荐）

```bash
dsh plugin --profile grape add @grape-dev/grape-dsh
```

发布的 npm 包里已包含编译产物 `lib/`，无需额外构建。

### 4.2 git 依赖（跟随仓库）

```bash
dsh plugin --profile grape add git+https://gitcode.com/grape-dev/grape-dsh.git
```

pnpm 11+ 会拦截 git 依赖的构建脚本。若报
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，在 `~/.dsh/profiles/grape/pnpm-workspace.yaml` 里加：

```yaml
allowBuilds:
  "@grape-dev/grape-dsh@git+https://gitcode.com/grape-dev/grape-dsh.git": true
```

然后重装：

```bash
cd ~/.dsh/profiles/grape && pnpm add git+https://gitcode.com/grape-dev/grape-dsh.git
```

### 4.3 dsh Web 界面报「无法从依赖变更中确定安装了哪一个包」

包已装进 `node_modules`，但 profile 没把它列进 bundles。编辑
`~/.dsh/profiles/grape/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@grape-dev/grape-dsh"
      ]
    }
  }
}
```

改完重启 dsh。上面两个问题只在 git 依赖安装时出现，npm 包不受影响。

---

## 5. 配置凭据

插件把这些传给 grape CLI（前两个也用于面板路由）：

```bash
GRAPE_BASE_URL=http://localhost:8000     # Grape 服务地址
GRAPE_API_TOKEN=grape_xxxxxxxx           # 用户级 API Key
GRAPE_TIMEOUT=30                         # 可选
GRAPE_CLI_BIN=/usr/local/bin/grape       # 可选（默认从 PATH 取 grape）
```

推荐集中到一个权限收紧的文件里，让 dsh 服务读取：

```bash
sudo install -d -m 700 /etc/grape-dsh
sudo tee /etc/grape-dsh/grape.env >/dev/null <<'EOF'
GRAPE_BASE_URL=http://localhost:8000
GRAPE_API_TOKEN=grape_xxxxxxxx
EOF
sudo chmod 600 /etc/grape-dsh/grape.env
```

dsh 若跑在 systemd 下，在 unit 里加 `EnvironmentFile=/etc/grape-dsh/grape.env`，然后
`systemctl daemon-reload && systemctl restart dsh-web`。

Key 从哪拿：Grape Web → **设置 → API Keys** → 创建用户级 key（`grape_` 前缀）。
**不要**用 `tk_` worker 会话 token 或 `tko_` 接管 token —— 它们只对单个任务有效，用户级接口会拒绝。

可选 LLM 提供方覆盖 —— `~/.dsh/profiles/grape/cordis.patch.yml`：

```yaml
- id: llm
  config:
    provider: deepseek
    baseUrl: https://api.deepseek.com
    apiKey: sk-xxx
    model: deepseek-chat
```

---

## 6. 验证

### 6.1 依赖清单

```bash
echo "node:      $(node --version 2>/dev/null || echo MISSING)"
echo "pnpm:      $(pnpm --version 2>/dev/null || echo MISSING)"
echo "dsh:       $(dsh --version 2>/dev/null || echo MISSING)"
echo "python:    $(python3 --version 2>/dev/null || echo MISSING)"
echo "grape CLI: $(grape --version 2>/dev/null || echo MISSING) at $(which grape 2>/dev/null || echo 'NOT IN PATH')"
echo "base URL:  ${GRAPE_BASE_URL:-NOT SET}"
echo "token:     ${GRAPE_API_TOKEN:+SET (${#GRAPE_API_TOKEN} chars)}"
```

### 6.2 服务连通性与 CLI 鉴权

```bash
curl -s "${GRAPE_BASE_URL}/health"
GRAPE_CLI_MODE=USER grape repos managed --json-out | head -c 200
```

### 6.3 插件已挂载

```bash
dsh --profile grape --dump-config 2>&1 | grep -i 'grape-tools'
```

### 6.4 产品内冒烟

启动 `dsh --profile grape`，然后问：

```
Grape 上托管了哪些仓库？
```

期望：模型调用 `grape_list_managed_repos`，出现工具卡片，结果渲染成表格。
再问「有哪些可用的流水线场景」验证 `grape_list_scenes`。

### 6.5 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `grape CLI not found` | 不在 PATH | `which grape`，或设 `GRAPE_CLI_BIN` |
| `authentication failed: token invalid` | key 错误/过期 | 到 Grape Web 重建 `grape_` key |
| `base_url unreachable` | 地址错/服务未起 | 检查 `GRAPE_BASE_URL`，`curl /health` |
| `HTTP 403: session token (tk_)` | 用了 worker token | 换成 `grape_` 用户 API Key |
| 工具完全不出现 | 插件没进 profile bundles | 见 4.3，或改用 npm 安装 |

---

## 7. 把本机注册为 Grape worker（可选）

只有需要**执行**流水线任务（而不只是观察）时才做。

1. 打开 dsh 侧栏 → Grape 面板 → **注册本机为 worker**。
2. 面板向 Grape 申请 worker 凭据（`rta_…`），并按你的系统给出安装命令：
   - Linux/macOS：`curl -sSL <base>/api/runtime/install | bash -s -- --token rta_… --server <base>`
   - Windows：`& ([scriptblock]::Create((irm <base>/api/runtime/install.ps1))) -Token rta_… -Server <base>`
3. 在本机终端执行该命令。安装脚本会在你的家目录下建独立 venv、写入凭据、后台启动 runtime agent
   并自动向 Grape 注册。
4. 验证：Grape Web → Workers/Engines 出现新引擎且 `status=online`，或
   `grape runtime list --json-out` 能看到本机。

说明：

- 安装脚本**不安装执行引擎**（opencode / hermes / codex 等），需自行安装，worker 启动时自动发现。
- 重复执行是安全的（幂等）：复用目录/venv，仅更新并重启 agent。
- 撤销：Grape Web → Workers → 吊销凭据，然后停掉本地 agent 进程。

---

## 8. 接管（Takeover）前置条件（可选）

接管让「人 + 本地 agent」在本地执行一个流水线节点，再把结果交回云端流水线。需要：

- Grape 服务端提供接管 API（`/api/takeover/sessions*`）；
- 插件 >= 0.4.0（本版本）且 dsh 侧栏能看到面板；
- 本机有 `git`（本地 agent 会在工作区里 clone / 提交 / 开分支）；
- 本地 agent 的 LLM 已配置（接管会开一个正常的 dsh 会话）。

流程：

1. 面板 → Issue 卡片 → 处于 `running` 的节点显示 **接管**。
2. Grape 取消云端任务、签发 `tko_` token（限定本仓库，12h）并返回完整 bundle。
3. 插件写工作区（`<workspace>/issues/<n>/<agent>/`，含技能包、项目图谱、按系统生成的脚本），
   然后自动开一个本地会话并送入渲染好的 prompt。
4. 本地 agent 载入 `.grape-takeover-env.sh|ps1`，干活；用
   `.grape-takeover-report.sh|ps1 "…"` 报进展，用
   `.grape-takeover-request-finish.sh|ps1 "结论" "证据"` 提交小结。
5. 你在面板点 **确认完成 · 派发下一节点**。Grape 记录结构化结论
   （`conclusion/actions/artifacts/next_step/issue_summary`）并派发下一节点；
   被接管的节点**绝不会**重跑。
6. 点 **放弃接管** 则把节点交还流水线，Grape 重新派发**当前**节点。

脚本由服务端按宿主 OS 渲染：

| 宿主 | 环境变量文件 | 进展 / 交材料脚本 |
|---|---|---|
| Linux / macOS | `.grape-takeover-env.sh`（`source …`） | `.grape-takeover-report.sh`、`.grape-takeover-request-finish.sh`（`sh …`） |
| Windows | `.grape-takeover-env.ps1`（`. .\…ps1`） | `…report.ps1`、`…request-finish.ps1`（`pwsh -ExecutionPolicy Bypass -File …`） |

token 处理：写入 `.grape-takeover-token`（0600），脚本通过 `GRAPE_AUTH_FILE` 引用，
**脚本正文里不含 token**。

---

## 9. 用 nginx 对外暴露 dsh（可选）

需要从外部访问 dsh Web 时，用反向代理，不要把 dsh 端口直接绑到公网。

```nginx
server {
    listen 443 ssl;
    server_name dsh.example.com;

    location / {
        proxy_pass http://127.0.0.1:3001;      # dsh web
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # SSE / websocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

带 `?token=` 的地址等同会话凭据，别留在 shell history 里。

---

## 10. 完整部署检查清单

```bash
#!/bin/bash
set -u
echo "1. node      : $(node --version 2>/dev/null || echo MISSING)"
echo "2. pnpm      : $(pnpm --version 2>/dev/null || echo MISSING)"
echo "3. dsh       : $(dsh --version 2>/dev/null || echo MISSING)"
echo "4. python    : $(python3 --version 2>/dev/null || echo MISSING)"
echo "5. grape CLI : $(grape --version 2>/dev/null || echo MISSING)"
echo "6. grape path: $(command -v grape || echo NOT_IN_PATH)"
echo "7. base URL  : ${GRAPE_BASE_URL:-NOT_SET}"
echo "8. token     : ${GRAPE_API_TOKEN:+SET(${#GRAPE_API_TOKEN})}"
echo "9. plugin    : $(dsh --profile grape --dump-config 2>/dev/null | grep -c 'grape-tools') (>=1 表示已挂载)"
echo "10. server   : $(curl -s -o /dev/null -w '%{http_code}' "${GRAPE_BASE_URL:-http://127.0.0.1:8000}/health")"
echo "11. cli auth : $(GRAPE_CLI_MODE=USER grape repos managed --json-out 2>&1 | head -c 60)"
```

每一行都应是版本号、`SET(n)`、`200` 或一段 JSON；否则按 §6.5 排查。

---

## 11. 平台注意事项

**macOS**

- Node/Python 建议用 Homebrew；在 venv 里不需要 `--break-system-packages`。
- 首次运行可能弹「访问桌面/文档」授权（TCC），工作区请放在家目录下、不要放受保护目录。
- dsh 可手动启动（`nohup dsh --profile grape &`），或用 `launchd` plist 常驻。

**Windows（原生）**

- 插件安装与命令都在 **PowerShell** 里执行，不要用 `cmd`。
- 接管脚本是带 UTF-8 BOM 的 `.ps1`，用
  `pwsh -ExecutionPolicy Bypass -File .\script.ps1` 运行。
- 没有 `systemd`：用计划任务或启动快捷方式让 dsh 常驻。
- `grape` 不在 PATH 时，把 `GRAPE_CLI_BIN` 指向 `grape.exe` 全路径。

**WSL2**

- WSL 内部就是 Linux，按 Linux 步骤走；注意 WSL 的进程默认不被 Windows 侧访问，
  需要显式暴露端口。