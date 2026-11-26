# Grape CLI 能力清单

> 来源：grape-cli 仓库（gitcode.com/grape-dev/grape-cli.git）实际代码，非推测。

## 命令体系

grape CLI 是契约驱动的——读取 Grape 服务端 OpenAPI 契约，`operationId` 自动生成命令树：

```
operationId: tasks_mine → grape tasks mine
operationId: gitrepo_issues_list → grape git-repo issues list
```

新增服务端 API → `grape refresh` → CLI 自动获得命令，零源码改动。

## 命令分组

### Core workflows（任务与交接）

```bash
grape tasks current --json-out                    # 查当前会话任务
grape tasks complete --json '{"task_id":7,"result_text":"...","next_step":"a2a_issue"}'
grape tasks wait --task-id 7 --timeout 120        # 轮询到终态
grape a2a handoff --json '{"agent":"coding","payload":{"repository":"o/r","account":"o/r","issue_number":7,"context":"..."}}'
```

### Agent Context（Issue/事件/知识，只读 dual）

```bash
grape issues list --owner o --repo r --json-out
grape issues detail --owner o --repo r --number 7 --json-out
grape issues events --owner o --repo r --number 7 --json-out
grape issues pipeline --owner o --repo r --number 7 --json-out
grape events detail --event_id <seq> --json-out
grape knowledge list --json-out
grape knowledge detail --knowledge_id <id> --json-out
grape knowledge stats --json-out
```

### Code & repositories（仓库操作，session-only）

```bash
grape git-repo repo --owner o --repo r --json-out
grape git-repo contents --owner o --repo r --json-out           # 根目录列表
grape git-repo contents --owner o --repo r --path README.md --raw  # 文件原文
grape git-repo tree --owner o --repo r --ref main --json-out
grape git-repo issues get --owner o --repo r --number 7 --json-out
grape git-repo issues comments create --owner o --repo r --number 7 --json '{"body":"..."}'
```

### Account & platform（需 grape_/JWT）

```bash
grape skills list --json-out
grape skills detail --skill_id <id> --json-out
grape repos managed --json-out
grape chat conversations --json-out
```

### CLI utilities

```bash
grape commands [pattern]          # 列出可调用命令；过滤：grape commands issues
grape refresh                     # 重拉最新契约
grape --help                      # 全部命令 + 分类
grape git <any git command>       # 原生 git passthrough，凭据进程内注入
```

## Token 体系

| Token 类型 | 前缀 | 环境变量 | 用途 |
|------------|------|----------|------|
| 会话级 | `tk_` | `GRAPE_SESSION_TOKEN` | session_only 命令（git-repo/tasks current） |
| 用户级 | `grape_` | `GRAPE_API_TOKEN` | user_only 命令（skills/chat/repos 管理） |
| dual | 任意 | 任意 | 两类都可（issues/events/knowledge 只读） |

优先级：`--token` 参数 > 环境变量 > `~/.grape/config.json`

## 输出格式

- 默认：pretty JSON（缩进 2）
- `--json-out`：单行 JSON（机器可读）
- `--raw`（仅 contents）：base64 解码为原始文件内容
- `--json @file.json`：从文件读 JSON body（避免 shell 转义）

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 1 | 通用/配置错误 |
| 2 | click 用法错误 |
| ≥400 | HTTP 状态码透传 |
| 130 | Ctrl+C 中断 |

## 契约加载优先级

1. `{base}/static/openapi.json` — 服务端固定下载 URL（公开）
2. `{base}/openapi.json` — 兼容未提供 static 的部署
3. 安装包内置快照 `src/data/openapi.json` — 离线兜底

## 安装

```bash
pip install git+https://gitcode.com/grape-dev/grape-cli.git
grape --version
```

要求 Python >= 3.10。
