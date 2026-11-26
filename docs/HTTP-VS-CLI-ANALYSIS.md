# grape-dsh 传输层方案对比：HTTP vs Grape CLI

> 基于实跑验证（2026-10-15），非推测。所有结论均有代码级或实测依据。

---

## 一、方案概述

| 维度 | 当前方案（HTTP） | 拟改方案（CLI） |
|------|-----------------|----------------|
| 传输方式 | `fetch()` 直调 Grape HTTP API | `spawn('grape', [...args, '--json-out'])` 子进程 |
| 依赖 | 零外部依赖（Node.js 内置 fetch） | Python >= 3.10 + grape CLI（`pip install -e /root/grape-cli`） |
| 输出 | 已解析 JSON 对象 | stdout 字符串 → `JSON.parse` |
| 端点维护 | 源码硬编码 9 个端点路径 | CLI 契约驱动，`grape refresh` 自动跟进新接口 |
| 代码量 | `src/client.ts` 162 行通用客户端 | 需重写为 `execGrape()` + 每个工具独立拼 args |

---

## 二、代价分析

### 代价 1：丧失统一请求抽象，每个工具拼 args 逻辑独立

**原因：** HTTP 版有一个 `GrapeClient.request(method, path, {params, body})` 通用方法，9 个工具全部走这个入口，参数传递格式统一（query 参数用 `params`，JSON body 用 `body`）。CLI 版每个命令的参数格式各不相同，没有统一抽象层。

**实测参数差异：**

| 工具 | CLI 参数格式 | 与其他工具的差异 |
|------|-------------|----------------|
| list_scenes | `scenes market list --json-out` | 无参数，仅 flag |
| apply_scene | `scenes apply --owner o --repo r --json '{"scene_id":"..."}' --json-out` | path 参数 + JSON body 混合 |
| list_managed_repos | `repos managed --json-out` | 无参数 |
| trigger_pipeline | `a2a handoff --json '{"agent":"...","payload":{...}}' --json-out` | 整个 body 是一个 JSON 字符串 |
| get_task_status | `events detail --seq 106 --json-out` | path 参数名是 `--seq`（不是 `--event_id`） |
| list_issues | `issues list --owner o --repo r --json-out` | 两个 path 参数 |
| get_pipeline_info | `issues pipeline --owner o --repo r --number n --json-out` | 三个 path 参数 |
| get_issue_events | `issues events --owner o --repo r --number n --json-out` | 三个 path 参数（同上但命令不同） |

**影响：** 需要为 9 个工具各写一段 args 拼装逻辑，且参数名来自 CLI 契约生成（operationId → click 参数），不可预测。HTTP 版新增工具只需加一行 `client.request(method, path, {params, body})`，CLI 版需要查 `grape <cmd> --help` 确认参数名和格式后单独编写。

**代码级依据：** CLI 的参数名由 `src/registry.py:278-285` 自动生成：path 参数 → `--<name>`，query 参数 → `--<name>`，requestBody → `--json`。但参数名 `<name>` 来自 OpenAPI 契约的 parameter definition，不同端点的参数名不同（如 events detail 是 `seq`，issues 是 `owner/repo/number`），无法在插件层统一推导。

---

### 代价 2：wait_task 轮询每 3 秒冷启动一个 Python 进程

**原因：** 当前 wait_task 在同进程内用 `client.pollUntilTerminal()` 轮询 `fetch('/api/events/detail/{seq}')`，每次轮询是一次轻量 HTTP 请求（~10-50ms）。改 CLI 后，每次轮询需要 spawn 一次 `grape events detail --seq <seq> --json-out`，Python 解释器冷启动 + click 框架初始化 + httpx 连接建立 + 契约缓存读取，实测首次约 300ms，后续约 150-200ms/次。

**量化影响：**

| 场景 | HTTP 版 | CLI 版 | 差额 |
|------|---------|--------|------|
| 单次查询 | ~50ms | ~200ms | +150ms |
| wait_task 2 分钟（每 3s 轮询，~40 次） | ~2s 总轮询开销 | ~8s 总轮询开销 | +6s |
| wait_task 5 分钟（~100 次） | ~5s | ~20s | +15s |

**为什么 CLI 的 `tasks wait` 用不上：**
1. `grape tasks wait --task-id <id>` 走的是 `GET /api/tasks/{id}/status`（user_only 端点），参数是 `task_id`（agent_tasks 表主键），不是 `event_seq`（events 表序列号）。当前 trigger_pipeline 返回的是 seq，插件层拿不到 task_id。
2. 即便能拿到 task_id，`tasks wait` 内部也是轮询，只是把轮询逻辑从插件层移到了 Python 侧——spawn 一次进程在进程内循环，比反复 spawn 40 次好，但这需要改 CLI 源码增加 `events wait` 命令，不是纯调 CLI 了。

**代码级依据：** CLI `src/cli.py:15-41` 的 `wait_command()` 调 `api.request("GET", f"/api/tasks/{task_id}/status")`，确认走 tasks 端点而非 events 端点。当前插件的 trigger_pipeline 调 `POST /api/a2a`，返回 `{status, seq, agent}`，不含 task_id。

---

### 代价 3：错误解析多一层（退出码 + stderr → Error message）

**原因：** HTTP 版的错误处理在同进程内，直接读 HTTP status code 和 response body，构造精确的错误信息。CLI 版的错误通过退出码 + stderr 文本传递，需要解析才能得到结构化信息。

**错误来源对照：**

| 错误类型 | HTTP 版 | CLI 版 | 信息质量 |
|---------|---------|--------|---------|
| Token 无效 (401) | `Grape API 401: token invalid (POST /api/a2a)` | exit=401, stderr: `Error: authentication failed: token invalid or expired; re-inject GRAPE_SESSION_TOKEN / GRAPE_API_TOKEN` | CLI 版信息更丰富（含行动指引） |
| 参数错误 (422) | `Grape API 422: Field required: body (POST /api/scenes/apply/o/r)` | exit=422, stderr: `Error: HTTP 422: Field required: body (POST /api/scenes/apply/o/r)` | 基本一致 |
| 命令不存在 | N/A | exit=2, stderr: `Usage: grape ...\nError: No such option '--xxx'` | CLI 独有，需处理 |
| CLI 自身错误 | N/A | exit=1, stderr: `Error: base_url unreachable: ...` 或 `Error: Missing token: ...` | CLI 独有，需区分是 CLI 问题还是 Grape 问题 |
| 网络超时 | `Grape API request timeout (GET /api/events/detail/106)` | exit=1, stderr: `Error: request timeout (> 30s; increase with --timeout): ...` | 基本一致 |

**影响：** 需要在 `execGrape()` 里写一段错误解析逻辑：读 exit code，如果是 ≥400 就从 stderr 提取 HTTP 错误信息，如果是 1/2 就判断是 CLI 自身错误还是用法错误。好消息是 CLI 的 `CliError`（`src/client.py:9-12`）已经把 HTTP 错误信息包装得比较完善（含状态码 + 消息 + 端点路径 + 行动指引），不会出现裸 Python traceback。

**代码级依据：** CLI `src/client.py:82-101` 的 401/≥400 错误处理，会在 message 里附加 hint（如 `re-inject GRAPE_SESSION_TOKEN`、`session token (tk_) only; check repo write permission`）。`src/cli.py:278-280` 的 `main()` 把 `CliError` 转成 `stderr: Error: <message>` + exit code。

---

### 代价 4：环境依赖多一个 Python + grape CLI 安装

**原因：** HTTP 版只依赖 Node.js 内置的 `fetch`（Node 18+ 自带），零外部依赖。CLI 版需要：

1. **Python >= 3.10**：dsh 运行环境必须装 Python
2. **grape CLI 安装**：`pip install -e /root/grape-cli` 或 `pip install git+https://gitcode.com/grape-dev/grape-cli.git`
3. **httpx 依赖**：grape CLI 依赖 `httpx>=0.24` 和 `click>=8.0`，pip install 时自动拉取
4. **GRAPE_CLI_MODE=USER**：必须设置此环境变量，否则 CLI 默认 ALL 模式，token 优先级是 session > api（`src/config.py:74-76`），可能用到错误的 token

**部署影响：**
- dsh 如果以 systemd service 运行，systemd unit 的 PATH 可能不含 `/usr/local/bin/grape`，需要在 unit 里指定 `PATH=` 或在 spawn 时用绝对路径 `/usr/local/bin/grape`
- 如果 grape CLI 装在 venv 里，spawn 时要么用 venv 的 python 绝对路径，要么确保 venv 已激活且 dsh 继承了正确的 PATH
- grape CLI 的契约缓存（`~/.grape/openapi-*.json`）需要 dsh 运行用户有写权限

**代码级依据：** 本次实测中，`pip install -e /root/grape-cli` 因 PEP 668 限制需要 `--break-system-packages`，生产环境推荐用 venv 或 pipx。CLI 入口点 `/usr/local/bin/grape` 由 `pyproject.toml` 的 `[project.scripts] grape = "src.cli:main"` 注册。

---

## 三、好处分析

### 好处 1：不再自己维护 HTTP 端点路径和参数名

**原因：** HTTP 版在 `src/tools/*.ts` 里硬编码了 9 个端点路径和参数结构。如果 Grape 服务端新增 API 或修改端点路径，需要手动改插件源码。CLI 版的命令树由 OpenAPI 契约自动生成（`src/registry.py:408-417` 的 `build_groups()`），服务端新增接口 → `grape refresh` → CLI 自动获得新命令，插件只需在 args 里用新命令名。

**量化影响：**
- 当前 9 个工具的端点路径分散在 4 个文件中（scenes.ts / repos.ts / pipeline.ts / issues.ts），每个文件硬编码了 path、method、body 结构
- Grape 服务端契约 v2.1.0 有 219 个有效 operationId，CLI 自动生成了全部命令，插件目前只用了 9 个
- 如果后续要加 `grape_create_issue`（IMPROVEMENTS.md A1）或 `grape_list_my_issues`（A2），HTTP 版需要查 OpenAPI 确认端点路径和 body schema 后手写代码；CLI 版只需 `grape issues create --help` 确认参数名后加一行 args 拼装

**代码级依据：** CLI `src/registry.py:44-66` 的 `parse_operations()` 遍历 OpenAPI paths，按 operationId 生成命令树；`src/contracts.py:80-116` 的 `load_contract()` 按优先级加载契约（缓存 > 远端 > 内置快照），`grape refresh` 强制拉取最新远端契约并更新缓存。

---

### 好处 2：`--json-out` 输出格式干净可靠

**原因：** HTTP 版的 `GrapeClient.request()` 需要自己处理 response 解析（`resp.text()` → `JSON.parse` → fallback to text）。CLI 版的 `--json-out` flag 保证输出是 `json.dumps(data, ensure_ascii=False, indent=None)` 的产物——单行压缩 JSON，无换行、无缩进、无 warning 混入。

**实测验证：**
- `grape repos managed --json-out` → 纯单行 JSON，无多余输出
- `grape scenes market list --json-out` → 纯单行 JSON（9 个场景的完整数据，虽然很长但格式正确）
- `grape issues list --owner wdmike --repo snake-game-0915 --json-out` → 纯单行 JSON（7 条 issue 完整数据）
- `grape events detail --seq 106 --json-out` → 纯单行 JSON（含 payload、agent_logs 等嵌套结构）
- 所有命令的 stderr 在正确配置环境变量后均为空（无 warning、无 logging）

**代码级依据：** CLI `src/registry.py:367-368` 的 `_run()` 函数：`click.echo(json.dumps(data, ensure_ascii=False, indent=None if kw.get("json_out") else 2))`。`--json-out` 时 `indent=None` 产出单行 JSON。`click.echo` 输出到 stdout，CLI 的 warning/error 输出到 stderr（`src/config.py:70-73` 的 warning 和 `src/cli.py:279` 的 Error 均走 `sys.stderr`/`click.echo(..., err=True)`）。

---

### 好处 3：CLI 的错误包装已经比较完善

**原因：** HTTP 版需要自己在 `GrapeClient.request()` 里解析 HTTP 错误（`src/client.ts:104-110`）。CLI 版的 `ApiClient`（`src/client.py:82-101`）已经对 401/403/404/≥400 做了分类处理，附加了行动指引（如 `re-inject GRAPE_SESSION_TOKEN`、`session token (tk_) only`），插件层只需读 stderr + exit code。

**CLI 错误包装示例（实测）：**
- 401: `authentication failed: token invalid or expired; re-inject GRAPE_SESSION_TOKEN / GRAPE_API_TOKEN`
- 403 (git-repo): `HTTP 403: ... (git-repo API: session token (tk_) only; check repo write permission)`
- 403 (user_only scope): `{error}; use GRAPE_API_TOKEN / Web JWT — session token (tk_) is rejected for this scope`
- 404 (git-repo contents): `HTTP 404: ... (path not found; try --path '' to list root)`
- 超时: `request timeout (> 30s; increase with --timeout): {url}{path}`
- 连接失败: `base_url unreachable: {base_url} ({detail})`

**代码级依据：** CLI `src/client.py:82-101` 的错误处理逻辑，按 status code 分类附加 hint。`src/registry.py:351-357` 对 user_only scope 的 403 追加英文行动指引。这些 hint 在 HTTP 版里需要插件自己实现。

---

### 好处 4：可以利用 CLI 的 `--json @file.json` 传复杂 body

**原因：** HTTP 版传 JSON body 用 `JSON.stringify(body)` 放在 fetch 的 body 里。CLI 版可以用 `--json @file.json` 从文件读取 body，避免在命令行参数里传递超长 JSON 字符串。

**适用场景：**
- `a2a handoff` 的 payload.context 如果是很长的任务描述（多段文本、含换行和特殊字符），`--json @file.json` 比 `--json '{"context":"...很长的文本..."}'` 更安全
- `scenes create` / `issues create` 等 body 字段较多的端点

**代码级依据：** CLI `src/registry.py:205-217` 的 `_read_json_arg()` 支持 `@file.json`（读文件）和 `@-`（读 stdin），在 `src/registry.py:333-340` 的 `_run()` 里被调用。Node.js spawn 时可以先把 body 写到临时文件，然后传 `--json @/tmp/xxx.json`，或者用 stdin 管道传 `--json @-`。

**注意：** 当前 9 个工具的 body 都不算复杂（最复杂的是 a2a handoff，5 个字段），`JSON.stringify` 直接传字符串参数已经够用。这个好处在后续新增工具（如 create_issue 带长 description）时更有价值。

---

## 四、综合对比矩阵

| 维度 | HTTP | CLI | 差异说明 |
|------|------|-----|---------|
| **工具覆盖** | 9/9 | 9/9 | 无差异 |
| **代码统一性** | 高（GrapeClient.request 统一入口） | 低（9 个工具各拼 args） | CLI 需更多样板代码 |
| **wait_task 性能** | ~2s/2min | ~8s/2min | CLI 多 6s 冷启动开销 |
| **错误信息质量** | 中（需自己解析 HTTP body） | 高（CLI 已包装含行动指引） | CLI 略优 |
| **端点维护** | 手动改源码 | grape refresh 自动跟进 | CLI 显著优 |
| **环境依赖** | 零 | Python + grape CLI | HTTP 显著优 |
| **输出可靠性** | 需自己处理 text/JSON fallback | --json-out 保证纯 JSON | CLI 略优 |
| **新增工具成本** | 查 OpenAPI + 手写 request | 查 --help + 拼 args | 差异不大，CLI 略简单 |
| **部署复杂度** | 低（npm 包自包含） | 中（需装 Python + CLI + 契约缓存） | HTTP 显著优 |
| **token 管理** | 插件层注入 Bearer header | 传 --token 或环境变量 | 差异不大 |
| **取消/超时** | AbortController → fetch abort | proc.kill('SIGTERM') | HTTP 更干净 |

---

## 五、验证依据

| 结论 | 验证方式 | 时间 |
|------|---------|------|
| 9 个工具全部有对应 CLI 命令 | `grape commands` + 内置 openapi.json 219 个 operationId 对照 | 2026-10-15 |
| grape_ token + GRAPE_CLI_MODE=USER 可用 | 实跑 4 个只读命令全部 200 | 2026-10-15 |
| --json-out 输出为纯单行 JSON | 实跑 repos managed / scenes market list / issues list / events detail | 2026-10-15 |
| events detail 参数名是 --seq 不是 --event_id | `grape events detail --help` 确认 | 2026-10-15 |
| a2a handoff body 格式是 --json '{"agent":"...","payload":{...}}' | `grape a2a handoff --help` 确认 | 2026-10-15 |
| scenes apply 是 --owner --repo --json '{"scene_id":"..."}' | `grape scenes apply --help` 确认 | 2026-10-15 |
| CLI 错误包装含行动指引 | `src/client.py:82-101` 源码确认 | 2026-10-15 |
| tasks wait 走 tasks 端点不是 events 端点 | `src/cli.py:29` 源码确认 | 2026-10-15 |
| CLI 版本 0.3.3，契约版本 2.1.0 | `grape --version` + openapi.json info.version | 2026-10-15 |
