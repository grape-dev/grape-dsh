# Issue #1 任务拆解与验证记录

## 任务拆解（3 个切片，单 PR）

| 切片 | 提交 | 内容 | 测试 |
|---|---|---|---|
| M1 探测 + 安装 | `feat(#1): 本机 Worker 检测/安装跨平台化` | `src/local-runtime.ts` 新增；`/check`、`/install-grape`、`/onboard` 凭据签发、`/revoke` 服务停止 | `test/local-runtime.test.mjs` |
| M2 接管 | 同上提交内的接管段（同文件顺序改动，见 PR 说明） | `resolveApiAuth` 守卫、token 文件 `finally` 回收、tmpdir 残留清理、删除内联 POSIX 脚本；R4 路径统一 `path.join`（`writeAll` / 技能物化 / abort 删 token）；`.gitignore` 屏蔽 `.grape-takeover-*` 落盘物 | 同文件 token/auth 用例 |
| M3 深链 | `feat(#1): 官网深链补仓库维度（A″-2）` | `grapeAppUrl(GrapeUrlTarget)`、3 处调用点 + 2 处 UI 兜底提示 | `test/focus.test.mjs` |

## 测试

```bash
npm run typecheck   # tsc --noEmit + tsc -p tsconfig.client.json → 0 error
npm test            # build + node --test test/local-runtime.test.mjs test/focus.test.mjs → 28 passed
```

新增用例覆盖（对应验收要求）：bin 错误路径、Python 3.9 版本过低、无 token、token 文件清理、同号不同仓库 URL 可区分、平台安装布局、服务管理平台分支。

## §9.3 静态自检（本机 Linux，`src/` 全量）

```bash
grep -rnE '2>/dev/null|/dev/null|/tmp/|/opt/|mkdir -p|ln -sf|systemctl|curl .*\|.*bash' src/
grep -rn "'python3'|\"python3\"" src/
```

| 命中 | 位置 | 判定 |
|---|---|---|
| `systemctl` | `src/local-runtime.ts:280` | ✅ 合规：`stopRuntimeAgent()` 的 Linux 分支（R6 要求的平台分支；Windows 分支走 `sc.exe`/`Stop-Service`） |
| `curl … \| bash` | `src/install-command.ts:24` | ⚠️ 遗留：worker **接入**安装器（`/onboard` 链路），属方案 B「全链路跨平台重写」范围，本次 Out of scope；Windows 侧该函数走 `install.ps1` |
| `'python3'` | `src/local-runtime.ts:73` | ✅ 数据表项：Python 启动器候选名（规范要求 win32 候选含 `python3`），**不是**被硬编码的调用点；调用一律 `runLocal(candidate, ['--version'])` |

其余模式（`2>/dev/null`、`/dev/null`、`/tmp/`、`/opt/`、`mkdir -p`、`ln -sf`）在 `src/` 中**零命中**。

## §9.2 双平台验证矩阵（如实记录）

> 本机环境：Linux（5.10.0 aarch64），Node 22.14.0，Python 3.14.6，grape CLI 0.3.3。
> **没有可用的 Windows 真机**，Windows 侧结论来自平台分支单测与路径断言，真机复核仍待补齐（如实标注，不作已通过处理）。

| 编号 | 检查项 | Windows | Linux |
|---|---|---|---|
| P1 | 面板检测到 grape CLI（`grapeAvailable: true`） | 逻辑通过（`runLocal` 数组传参 + `grape.exe` 候选；无真机） | ✅ 实测 `runLocal('grape',['--version'])` → `grape 0.3.3`，`ok:true`；错误路径用例 → `missing:true` 不误报 |
| P2 | 自动安装 grape CLI 成功 | 逻辑通过（`%LOCALAPPDATA%\grape-cli` + `Scripts\pip.exe` 路径断言；无真机） | ✅ 实测命令序列（本环境 `/opt` 为只读挂载，同一布局镜像到 `/tmp/grape-verify-opt/grape-cli`）：`python3 -m venv` → `venv/bin/pip install --quiet --no-cache-dir <tarball>` → `venv/bin/grape --version` = `grape 0.3.3` |
| P3 | 签发凭据（`credential create`）成功 | 逻辑通过（数组传参、设备名不再拼串） | ⚠️ 未真机执行：会产生真实凭据，避免污染账号；仅校验命令构造 |
| P4 | 接管接口返回 200 + prompt | 逻辑通过（auth 守卫 + `fetch`，无 shell） | ⚠️ 未在 GUI 触发：需 DSH 宿主 + 真实任务；代码路径与鉴权守卫已单测 |
| P5 | 吊销凭据成功 | 逻辑通过（平台服务停止分支单测） | ⚠️ 未真机执行：会吊销真实凭据 |
| P6 | 临时 token 文件落在 `os.tmpdir()` 且用后删除 | ✅ 单测：`cleanupStaleTakeoverTokens` 只清 `grape-takeover-*.tok`；接管失败 `finally` 删除 | ✅ 同左（真实 fs 用例，临时目录实测） |
| P7 | 不使用 `2>/dev/null` / `/tmp` / `mkdir -p` / `ln -sf` / `systemctl`（Windows 侧） | ✅ `src/` 静态自检零命中（残留在上表如实列出） | ✅ 同左 |
| P8 | 可执行名解析正确（`grape.exe` vs `grape`、`py`/`python` vs `python3`） | ✅ 单测：`grapeExecutable('win32')='grape.exe'`、候选首位 `py` | ✅ 单测 + 实测：`grapeExecutable('linux')='grape'`、首选 `python3` |

## §9.1b 深链验收

| 检查项 | 结果 |
|---|---|
| URL 含仓库维度 `#pipe/<n>?repo=<owner>/<repo>` | ✅ 单测 |
| 同仓库不同 issue 链接互不相同 | ✅ 单测 |
| 两仓库同号 issue 链接可区分 | ✅ 单测（`alice/proj` vs `bob/proj`） |
| 两个按钮目标 URL 一致 | ✅ 同一 `url` 变量；单测「重复构造一致」 |
| 概览 / 事件链接带仓库上下文 | ✅ 单测（`#dash?repo=`、`#event/<seq>?repo=`） |
| A″-3 兜底不静默跳错 | ✅ 浏览面板与焦点卡按钮旁提示「若官网未自动切到 owner/repo，请手动选择」 |
| `grapeAppUrl` 无平台分支、分隔符统一 `/` | ✅ 单测断言不含 `\` |

> `?repo=` 是否被 Grape 前端消费取决于 §5.9.5 Q2（前端能力），确认前以 A″-2 参数 + A″-3 提示并存，PR 描述中已声明依赖。

## §9.2 实测记录（本轮，Linux 侧可直接复跑）

```bash
npm test                                                       # 28 passed / 0 failed
npx tsc --noEmit && npx tsc -p tsconfig.client.json --noEmit   # 0 error
```

| 探针（`lib/local-runtime.js` / `lib/focus.js`） | 实测输出 |
|---|---|
| `runLocal('grape',['--version'])` | `{"ok":true,"version":"grape 0.3.3","missing":false}` |
| `runLocal('grape-does-not-exist-xyz',['--version'])` | `{"ok":false,"missing":true,"error":"spawnSync … ENOENT"}` |
| `runLocal('node',['-e',…,'a b *c'])` | `{"ok":true,"stdout":"a b *c"}`（参数不被 shell 解释，R1） |
| `findPython()` | `{"bin":"python3","version":"Python 3.14.6","ok":true}` |
| `findPython('linux', 假 3.9 探针)` | `{"bin":"python3","version":"Python 3.9.18","ok":false}` → 文案「版本过低」，不再是「未安装」误报 |
| `pythonLaunchers` | win32 `["py","python","python3"]`／linux `["python3","python"]` |
| `installLayout('linux')` | `/opt/grape-cli/.venv/bin/{python,pip,grape}` + 软链 `/usr/local/bin/grape` |
| `installLayout('win32', LOCALAPPDATA=…)` | `…\grape-cli\.venv\Scripts\{python.exe,pip.exe,grape.exe}` |
| `resolveApiAuth({}, {})` | `未配置 baseUrl：请在插件 config 填写…`（不再回落 `localhost:8000`） |
| `resolveApiAuth(config, env)` | `http://cfg:9000` + `cfg-tok`（config 优先、env 兜底） |
| `cleanupStaleTakeoverTokens(临时目录)` | `removed=1 left=["keep-me.txt"]`（只清 `grape-takeover-*.tok`） |
| `stopRuntimeAgent('linux'｜'win32', 探针)` | `systemctl :: stop runtime-agent.service`／`sc.exe :: stop runtime-agent` |
| `grapeAppUrl` 同号不同仓库 | `#pipe/8?repo=acme/a` ｜ `#pipe/8?repo=acme/b` ｜ `#pipe/8?repo=other/a` —— 三者互不相同 |

Windows 侧：`installLayout('win32')` / `pythonLaunchers('win32')` / `grapeExecutable('win32')` / `stopRuntimeAgent('win32')` 由注入平台参数的用例（`path.win32` 构造）与上表覆盖；**未在 Windows 真机执行**，此处如实标注为待补，不作「已通过」处理。