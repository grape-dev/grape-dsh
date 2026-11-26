# 发布记录（Release Record）

本文件记录本仓库在 **`main` 线上真实产出并安装过的 tgz**：每条记录都要能用同一份产物复算 sha256。
它是部署侧（[`AGENT-DEPLOYMENT-GUIDE.md`](../AGENT-DEPLOYMENT-GUIDE.md)）与发布侧的对账表。

> 分支边界：`dev-ch` 上更早的产物（`0.4.3+20261117-162200`、`0.5.0+20261117-182129`）记录在
> **dev-ch 分支的同名文件**里，历史行不重复搬运到本表；本表只记录从 `main` 出包并安装过的产物。
>
> **当前源码版本：`0.5.4`**（`dev-ch-11` / `main @ 27d5c53`，作为 npm 发布版本）：
> - 版本口径（2026-11-25 用户决定）：`0.5.5`–`0.5.8` 是**本地内部构建版本号，从未发布 npm**；
>   当前源码（含 0.5.5–0.5.8 全部内容与 2026-11-25 的 8 项面板交互优化）统一以 **`0.5.4`**
>   发布，与 `main` 上的版本号一致。下方 0.5.5–0.5.8 各条只是内部构建留痕，**不代表 npm 版本**。
> - npm `0.5.4` 的产物：由合并后的 `main @ 27d5c53` 出包
>   `grape-dev-grape-dsh-0.5.4+20261125-223332.tgz`（402200 B / 140 文件，sha256
>   `B84ED7E73282E42AB3A4149D3A1F06D013A773400B203BFFC6DB9D9E798E27DE`），**发布时直接发该 tgz**；
>   与历史内部构建 `0.5.4+20261125-131756`（sha `1666cd…`）同名不同内容，不复用旧行。
> - `0.5.8`：「进入对话」深链 hash 改为整体 encodeURIComponent
>   （`#chat/issue%3A4%3Agitcode%3Aowner%2Frepo`），与官网真实地址一致；已从
>   `dev-ch-11 @ 5d93f55` 出包 `grape-dev-grape-dsh-0.5.8+20261125-161003.tgz`（sha256
>   `af642feae13d820bcbb32064b86d8a52a03cd4aaafb612511d9371066f80a1ab`），已安装 `desktop`
>   profile；**替换已装包需重启 DSH 生效**；尚未发布 npm。
> - `0.5.7`：修复 `/scenes?scene_id=<UUID>` 被 32 字过滤器误拒（复制需求无场景下拉 + 重复报错）；
>   过滤参数上限放宽到 64 与建单 `SCENE_ID_RE` 对齐；复制表单不再重复展示顶层错误；已从
>   `dev-ch-11 @ dc349e1` 出包 `grape-dev-grape-dsh-0.5.7+20261125-160244.tgz`（sha256
>   `ab5002bca90959bbe6130774f82e337d883b8945300e9e651c3eae4631470820`），已安装 `desktop`
>   profile；**替换已装包需重启 DSH 生效**；尚未发布 npm。
> - `0.5.6`：合并 Issue #43（接管建会话并发去重 / reload 创建态门禁 / 重复会话取消）并带上
>   #40–#43 非阻塞优化（建单无编号关表单、搜索筛选「仅当前页」提示、复制需求 Issue 链接、
>   reload 提示文案）后的源码版本；已从 `dev-ch-11 @ 3f6ca3e` 出包
>   `grape-dev-grape-dsh-0.5.6+20261125-154245.tgz`（sha256
>   `cf199c1e0414d6ad6080434faab5b82f1121412ffcf261605fe22152fc897c8d`），已安装 `desktop`
>   profile；**替换已装包需重启 DSH 生效**；尚未发布 npm。
> - `0.5.5`：合并 Issue #42（需求卡片 4 个操作按钮：进入对话 / 复制需求 / 确认完成 / 移交流水线；
>   含 `/task` 视图、`scene_id`、移交目标当前场景标记）后的源码版本；已从 `dev-ch-11 @ c52de58`
>   出包 `grape-dev-grape-dsh-0.5.5+20261125-144614.tgz`（sha256
>   `a9ea27e918ecfb5c7126408cc5d2104e10ee8dd072217595b8cfad03d92e38cf`），已安装 `desktop`
>   profile；**替换已装包需重启 DSH 生效**；尚未发布 npm。
> - `0.5.4`：合并 Issue #40（浏览页快捷创建需求 / 创建并接管 + `/grape-worker-api/*` 同源守卫）与
>   Issue #41（浏览页 Issue 搜索走服务端 `q`，含分页与匹配计数）后的源码版本；已从
>   `dev-ch-11 @ ae69406` 出包 `grape-dev-grape-dsh-0.5.4+20261125-131756.tgz`（sha256
>   `1666cd322296125d89af674835940069140cb673651010fae7fa094ea2081606`），已安装 `desktop`
>   profile；**替换已装包需重启 DSH 生效**；尚未发布 npm。
> - `0.5.3` 已从 `main`（`7227eed`，含 `!36`）出包并发布到 npm 官方源（`@grape-dev/grape-dsh@0.5.3`，dist-tag `latest`，
>   issue #38），下表已追加**真实**的 tgz 文件名与 sha256。本版修复 worker 新接入/改名按 `config.deviceName`
>   注册（查询与安装同一目标名）。
> - `0.5.1` 已从 `main`（`9c368aa`）出包并发布到 npm 官方源（`@grape-dev/grape-dsh@0.5.1`，dist-tag `latest`，
>   issue #36），下表已追加**真实**的 tgz 文件名与 sha256。
> - `0.5.2` 已从 `main`（`690472e`）出包并发布到 npm 官方源（`@grape-dev/grape-dsh@0.5.2`，dist-tag `latest`，
>   issue #37），下表已追加**真实**的 tgz 文件名与 sha256。该版本修复 0.5.1 的**设置保存失败** —— `deviceName`
>   只进了 TS `Config` 接口与设置面板输入框，运行时 `z.object` schema 未声明，dsh 主机拒绝写入；本版在 schema
>   补声明，并加回归测试（`test/config-schema.test.mjs`：面板会写的字段必须全部在运行时 schema 里）。
> 历史：dev-ch-11 早期的 `0.5.1`/`0.5.2` 内部里程碑未发布 npm，与本表不是同一份产物。

## 记录规则

- **只记录真实产物**：`commit`、`tgz` 文件名、`sha256` 必须来自实际构建与打包的结果；
  禁止手填占位、禁止抄旧行改日期、禁止记录未生成过的 tgz。
- **sha256 必须可复算**：把记录的 tgz 放回任意机器，用下文任一命令算出的值都要与本表一致。
- **tgz 不入库**：产物由部署者保存（同一版本至少保留「当前 + 上一个可用」两份）；本表只记录其
  文件名与摘要，不记录绝对路径。
- **一次安装/回滚一行**：`安装 profile` 填实际 profile 名；仅出包未安装时填「未安装（仅出包）」。
- 本文件不改 `version`、不发布到 registry、不代替构建：打包口径见 §「如何生成一条记录」。

## 记录表

| 日期 | 版本 | commit（短 hash + 分支） | tgz 文件名 | sha256 | 安装 profile | 校验结论 | 备注 |
|------|------|--------------------------|-----------|--------|--------------|----------|------|
| 2026-11-18 | 0.5.0 | `83a071e`（`main`） | `grape-dev-grape-dsh-0.5.0+20261118-132555.tgz` | `ae1216e8be5b6cfc73ae765005f1964888bdc49f08cc4740f9142f6f3f897776` | `desktop` | 80 个文件；必需项齐全；`src/`/`test/`/`node_modules/` 0 命中；PowerShell 与 Node 两种 sha256 写法一致 | 由 `!18` 合并后的 main 输出（`npm pack` + 重命名）；208416 字节；与 `+051459`/`+051535` 摘要相同（同一内容三次出包，以 `+132555` 为准） |
| 2026-11-18 | 0.5.1 | `77dcfd0`（`main`） | `grape-dev-grape-dsh-0.5.1+20261118-141717.tgz` | `36af3f67de399f31f8b52ab2cb5cea3162897b49773ff8ce88b25f0611c44718` | `desktop` | 82 个文件；`_diag(` / `_diagUrl` / `grape-dsh-takeover.log` 精确检查 **0** 命中；`localizeRestoredCwd` / `takeover-release` / `removeTakeoverToken` 均在产物内；`npm test` 176（175 pass / 1 skip） | `0.5.0 → 0.5.1`：移除 DIAG 落盘诊断、宿主重启后 cwd 回退、接管令牌回收；214166 字节；树与 `17d0b21`（版本 bump 提交）相同 |
| 2026-11-19 | 0.5.2 | `feat/issue-25`（基线 `dev-ch-11 @ f535462`） | `grape-dev-grape-dsh-0.5.2+20261119-145924.tgz` | `716c46e7e3e4308fcf8b0bd3b8f82cfda517e324097b2440eafd849be01ad281` | 未安装（仅出包） | 82 个文件；`package/(src|test|node_modules)/` 检查 **0** 命中；`package/lib/local-runtime.js` 含 `classifyWorkerState`；`npm test` 185（184 pass / 1 skip） | Issue #25：Worker 12 态状态机、服务端 2×heartbeat 优先、探测失败不拉起、拉起护栏与拉起后核对、面板判定依据与脱敏复制；226051 字节 |
| 2026-11-19 | 0.5.2 | `983f4f7`（`dev-ch-11`，含 #25–#28 合并与 10 个审查修复） | `grape-dev-grape-dsh-0.5.2+20261119-123059.tgz` | `1ecd4441e41a5b860f47e8a14be161856ac026ac749f5bea0bd3052f664fdd4b` | `desktop` | 98 个文件；`typecheck` 通过；`npm test` 255（254 pass / 1 skip）；产物含 `scene_unknown` / `bare` / `cacheScope`；安装目录为真实目录 v0.5.2 | 四条需求整合包：Worker 状态机、场景节点链、浏览首屏快路径、实时预览；289408 字节；装完需重启 DSH 生效 |
| 2026-11-20 | 0.5.0（首个 npm 发布版本） | `e12523d`（`main`，含 `!32`） | `grape-dev-grape-dsh-0.5.0.tgz`（npm registry） | `509dd3b77018705b2116ddfb78c08f0328d887262d2d0ee95989e998a3555439` | 未安装（npm 发布） | 扫描 PASS（技能基线 0.5.0）；认证预检 `npm whoami` 通过；`dist.integrity` 与产物 sha512 一致；发布包 `lib/*` 与 `e12523d` 本地构建逐文件 sha256 相同（`package.json` / `cordis.patch.yml` 仅 CRLF→LF 差异） | 114 文件 / 299092 字节；`@grape-dev/grape-dsh@0.5.0`，dist-tag `latest`；由场景 `plugin-publish-npm`（issue #35）产出；旧包 `@grape-dev/dsh-grape` 停在 0.4.2 |
| 2026-11-20 | 0.5.1 | `9c368aa`（`main`，含 `!34`） | `grape-dev-grape-dsh-0.5.1.tgz`（npm registry） | `478060888cf8025f9b7f182c1e59c35a85e20d754c272503fe958cc57e365d8f` | 未安装（npm 发布） | 扫描 PASS（技能扫描器 exit 0，仅 info `no-engines-dsh`）；认证预检 `npm whoami` 返回 `zrr000212`；`dist.integrity`（`sha512-UtCdVr1H6928E…9CiuefHxeCU1A==`）与产物 sha512 一致；`dist-tags.latest` 指向 `0.5.1` | 114 文件 / 308.1 kB；`@grape-dev/grape-dsh@0.5.1`，dist-tag `latest`；由场景 `grape-dsh-publish-npm`（issue #36）产出；`engines.dsh` 缺失（dsh 无法版本兼容检查） |
| 2026-11-20 | 0.5.2 | `690472e`（`main`，含 `!35`） | `grape-dev-grape-dsh-0.5.2.tgz`（npm registry） | `34d0e89bcaaaa0402660848e6051badf2e920c3e3b2264c87efde1614bcb4219` | 未安装（npm 发布） | 扫描 PASS（技能扫描器 exit 0，仅 info `no-engines-dsh`）；认证预检 `npm whoami` 返回 `zrr000212`；`dist.integrity`（`sha512-7FZlWdWwGGKB8ZWc…Rbayaqc3VB7Iw==`）与产物 sha512 一致；`dist-tags.latest` 指向 `0.5.2`（发布后 registry 有短暂缓存延迟，已重试确认） | 114 文件 / 308.6 kB；`@grape-dev/grape-dsh@0.5.2`，dist-tag `latest`；由场景 `grape-dsh-publish-npm`（issue #37）产出；修复 0.5.1 设置保存失败（`deviceName` 运行时 schema 声明）；`engines.dsh` 缺失（dsh 无法版本兼容检查） |
| 2026-11-23 | 0.5.3 | `7227eed`（`main`，含 `!36`） | `grape-dev-grape-dsh-0.5.3.tgz`（npm registry） | `b47b35aafa57bd4822d226ce6e942ab19e4eacec6d482b97d8db49adc4b5aeeb` | 未安装（npm 发布） | 扫描 PASS（技能扫描器 exit 0，仅 info `no-engines-dsh`）；认证预检 `npm whoami` 返回 `zrr000212`；`dist.integrity`（`sha512-y9XAgUynvCby8MfSI69StbUl8/bFwdTi95BJXqhJBEsJsAkM8f1NeP+NQ4tMj5+rPQEz6zcb1nsWq6gC9blQzQ==`）与产物 sha512 逐字一致；`dist-tags.latest` 指向 `0.5.3`（发布后 registry 约 1 分钟缓存延迟，已重试确认） | 114 文件 / 311.7 kB；`@grape-dev/grape-dsh@0.5.3`，dist-tag `latest`；由场景 `grape-dsh-publish-npm`（issue #38）产出；修复 worker 新接入/改名按 `config.deviceName` 注册；`engines.dsh` 缺失（dsh 无法版本兼容检查） |
| 2026-11-25 | 0.5.4 | `ae69406`（`dev-ch-11`） | `grape-dev-grape-dsh-0.5.4+20261125-131756.tgz` | `1666cd322296125d89af674835940069140cb673651010fae7fa094ea2081606` | `desktop` | 132 个文件；`typecheck` 0；`npm test` 396（395 pass / 1 skip）；产物含 #40 创建/接管与 #41 搜索代码；sha256 本机复算一致 | 由 `dev-ch-11` 0.5.4 出包；369261 字节；安装到 `desktop` profile（`file:` 依赖），**需重启 DSH 生效**；未发布 npm |
| 2026-11-25 | 0.5.5 | `c52de58`（`dev-ch-11`） | `grape-dev-grape-dsh-0.5.5+20261125-144614.tgz` | `a9ea27e918ecfb5c7126408cc5d2104e10ee8dd072217595b8cfad03d92e38cf` | `desktop` | 138 个文件；`typecheck` 0；`npm test` 443（442 pass / 1 skip）；产物含 #42 `/task` 视图、4 按钮、scene_id、当前场景标记；sha256 本机复算一致 | 由 `dev-ch-11` 0.5.5 出包；391058 字节；安装到 `desktop` profile（`file:` 依赖），**需重启 DSH 生效**；未发布 npm |
| 2026-11-25 | 0.5.6 | `3f6ca3e`（`dev-ch-11`） | `grape-dev-grape-dsh-0.5.6+20261125-154245.tgz` | `cf199c1e0414d6ad6080434faab5b82f1121412ffcf261605fe22152fc897c8d` | `desktop` | 140 个文件；`typecheck` 0；`npm test` 467（466 pass / 1 skip）；产物含 #43 接管双会话修复 + #40–#43 非阻塞优化；sha256 本机复算一致 | 由 `dev-ch-11` 0.5.6 出包；402139 字节；安装到 `desktop` profile（`file:` 依赖），**需重启 DSH 生效**；未发布 npm |
| 2026-11-25 | 0.5.7 | `dc349e1`（`dev-ch-11`） | `grape-dev-grape-dsh-0.5.7+20261125-160244.tgz` | `ab5002bca90959bbe6130774f82e337d883b8945300e9e651c3eae4631470820` | `desktop` | 140 个文件；`typecheck` 0；`npm test` 468（467 pass / 1 skip）；修复 UUID scene_id 被 32 字过滤器误拒 + 复制表单重复错误；sha256 本机复算一致 | 由 `dev-ch-11` 0.5.7 出包；402298 字节；安装到 `desktop` profile（`file:` 依赖），**需重启 DSH 生效**；未发布 npm |
| 2026-11-25 | 0.5.8 | `5d93f55`（`dev-ch-11`） | `grape-dev-grape-dsh-0.5.8+20261125-161003.tgz` | `af642feae13d820bcbb32064b86d8a52a03cd4aaafb612511d9371066f80a1ab` | `desktop` | 140 个文件；`typecheck` 0；`npm test` 468（467 pass / 1 skip）；进入对话深链 hash 改为 encodeURIComponent；sha256 本机复算一致 | 由 `dev-ch-11` 0.5.8 出包；402446 字节；安装到 `desktop` profile（`file:` 依赖），**需重启 DSH 生效**；未发布 npm |
| 2026-11-26 | 0.5.4 | `27d5c53`（`main`，含 `!44`） | `grape-dev-grape-dsh-0.5.4.tgz`（npm registry） | `B84ED7E73282E42AB3A4149D3A1F06D013A773400B203BFFC6DB9D9E798E27DE` | 未安装（npm 发布） | 140 个文件；`typecheck` 0；`npm test` 468（467 pass / 1 skip）；内容含 #42 四按钮 / #43 接管去重 / 0.5.7 场景 UUID / 0.5.8 深链编码 + 8 项面板交互优化 | 由 `main @ 27d5c53` 出包（本地同内容 `grape-dev-grape-dsh-0.5.4+20261125-223332.tgz`）并直接发该 tgz；dist-tag `latest` → `0.5.4`；`0.5.5`–`0.5.8` 为内部构建、未发布 |

### 开发分支待发布条目（无 tgz，仅登记）

> 本节只登记「已合入开发分支、尚未从 `main` 出包」的变更，**不填 tgz/sha256**
> （无真实产物，避免伪造摘要）。出包后在 §记录表 补真实行。

| 日期 | 版本 | 变更 | 状态 |
|------|------|------|------|
| 2026-11-19 | 0.5.1（不重复 bump） | Issue #27：浏览页签首屏快路径（宿主 fetch + 5min TTL + localStorage SWR + 空账号并行） | 待出包（PR #26，待合入 dev-ch-11） |
| 2026-11-19 | 0.5.1（不重复 bump） | Issue #28：实时面板空态引导卡 + 当前仓库最近活跃 issue 自动预览（可固定为正式 pin，预览不落盘） | 待出包（待 dev-ch-11 合入，未安装） |

## 如何生成一条记录

`main` 分支**没有** `scripts/pack.mjs`（打包脚本只在 `dev-ch` 上），因此按 npm 原生口径打包：

```bash
npm ci
npm run build            # tsc && node scripts/build-client.mjs → lib/
npm pack --json          # 产出 grape-dev-grape-dsh-<version>.tgz，并打印真实文件列表
```

把产物重命名为「scope 去掉、`/` 换成 `-`」+ 版本 + 本地时间戳：

```
@grape-dev/grape-dsh + 0.5.1 + 20261118-141717
        ↓
grape-dev-grape-dsh-0.5.1+20261118-141717.tgz
```

打包后至少核对四件事（`npm pack --json` 的 `files` 列表或 `tar -tzf`）：

1. **必需项齐全**：`package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/client.js`、
   `locale/en.json`、`locale/zh.json`。
2. **禁止项 0 命中**：`src/`、`test/`、`node_modules/`、`docs/issue-*`、`*.tgz`。
3. **版本与包名正确**：`package.json` 里 `@grape-dev/grape-dsh@<预期版本>`。
4. **本次改动的关键符号在产物里**（例如删除某段诊断后，用 `lib/` 里精确匹配确认它真的没了）。

取 commit 与分支：

```bash
git rev-parse --short HEAD
git branch --show-current
```

## 如何计算 sha256（三种等价写法，零新依赖）

```bash
# Node（任意平台）
node -e "const c=require('node:crypto'),f=require('node:fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" "<path-to-tgz>"
# Windows PowerShell
Get-FileHash -Algorithm SHA256 -LiteralPath "<path-to-tgz>" | Select-Object -ExpandProperty Hash
# Linux / macOS
shasum -a 256 "<path-to-tgz>"
```

本表 0.5.1 行的实测输出（Windows PowerShell 与 Node 两种实现一致）：

```text
PS> (Get-FileHash -Algorithm SHA256 -LiteralPath "grape-dev-grape-dsh-0.5.1+20261118-141717.tgz").Hash.ToLower()
36af3f67de399f31f8b52ab2cb5cea3162897b49773ff8ce88b25f0611c44718
```

## 安装前对账

1. 用 §「如何计算 sha256」算出待安装 tgz 的摘要；
2. 在本表找到**同名 tgz** 的 `sha256` 行，逐字符比对（不区分大小写）；
3. 一致 → 按 [`AGENT-DEPLOYMENT-GUIDE.md`](../AGENT-DEPLOYMENT-GUIDE.md) 的 §4 安装，并抄录
   commit / tgz / sha256 到报告里；
4. 不一致或表中无该 tgz → **停止安装**，重新出包或重新取回产物后复算；确实需要安装新产物时，
   先新增本表记录，再安装。

sha256 只证明「产物与记录一致」，不证明发布者身份（无签名）；来源可信度由仓库与分支决定。
版本组合是否受支持，另见 [`COMPATIBILITY.md`](COMPATIBILITY.md)。
