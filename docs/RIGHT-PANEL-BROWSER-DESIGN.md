# 右栏「Grape 资源浏览」设计（仓库 → issue → 流水线）

> 目标：在 dsh 右侧栏里做一个**主动钻取**的资源浏览器。
> 与现有「实时观察窗」互补：观察窗看 **AI 当前在做什么**（被动、工具结果驱动），
> 浏览器看 **平台里有什么**（主动、点击驱动）。

---

## 1. 交互流

```
右栏 Tab「Grape 资源」
  ├─ ① 仓库列表        全部已托管仓库（repos managed）
  │    └─ 点击某仓库 ─→ ②
  ├─ ② issue 列表      该仓库的 issue（已带 stage/status 增强）
  │    └─ 点击某 issue ─→ ③
  └─ ③ 流水线详情      该 issue 的节点链（vod → issue → coding → qa → sre）

  顶部：面包屑  ← 返回    +  刷新    +  在官网打开 ↗
```

---

## 2. 数据层（全部**实测通过**，用用户 key `grape_`）

| 层级 | CLI 命令 | 后端接口 | 关键字段 |
|---|---|---|---|
| ① 仓库 | `grape repos managed --json-out` | `GET /api/repos/managed` | `full_name` `repo_key` `role` `status` `branch` `webhook_ok` `has_bot_token` |
| ② issue | `grape issues list --owner --repo --json-out` | `GET /api/issues/{owner}/{repo}` | `issue_number` `title` `status` `stage` `scene_id/scene_name` `owner_agent` `events_count` `latest_event{seq,status,title,created_at}` `is_running` `is_pr` |
| ③ 流水线 | `grape issues pipeline --owner --repo --number --json-out` | `GET /api/issues/{owner}/{repo}/{number}/pipeline` | `status` `summary` `segments[]{seq, agent, event_type, status, output{conclusion,next_step,actions,artifacts}, logs}` |

### 代码平台维度（`repo_key` 前缀）

`repo_key` 形如 `gitcode:owner/repo` / `github:owner/repo` —— **冒号前就是代码平台**。
同一个 `owner/repo` 可能同时存在于 GitCode 与 GitHub，所以平台：

- **展示**：仓库列表按平台分组（一级目录，可展开收起）；issue 列表头、流水线标题也带平台标签；
- **一级目录 = 产品支持的平台**（`SUPPORTED_PLATFORMS = ['gitcode','github']`），即使暂无仓库也列出——
  这是"产品支持什么"而不是"我托管了什么"，空的 GitHub 目录本身是信息。
  数据里出现列表外的平台（如将来的 gitlab）会按出现顺序自动补成新组。
  空平台默认收起，展开显示「该平台还没有托管仓库」；
- **导航**：`platform` 随钻取一路带下去，并进入缓存键（不带平台会让两个平台的同名仓库互相覆盖数据）；
- **不影响取数**：`/api/issues/...` 是 Grape 自有 issue 模型，接口只要 owner/repo，不要平台参数
  （平台是 VCS 维度的属性；只有 `git-repo` 家族那批接口才把请求代理到 VCS）。

实测：本账号 `repos managed`(15) 与 `repos member`(84) **全部是 `gitcode:`** ——
GitHub 受产品支持但本账号未托管仓库，故显示为空目录（`GitHub 暂无`，默认收起）。

### ⚠️ 实测踩到的硬约束（决定了技术选型）

- `grape git-repo issues list`（`GET /api/git-repo/...`）用用户 key **返回 403**：
  `Git 仓库接口仅支持会话级临时 token（agent 专用），用户 API Key / Web 会话不适用`
  → **必须走 `issues` 家族（Grape-unique 接口）**，不能走 `git-repo` 家族。
- `repos managed` / `issues list` / `issues pipeline` 三者用户 key 均可用（已验证）。

### issue 列表的分页能力

`grape issues list` 暴露：`--status` `--sort_order` `--mode` `--assignees`，
**没有 `page` / `per_page`**（对比 `git-repo issues list` 有 `page/per_page`）。
→ P1 先按全量处理 + 前端本地分页；同时作为**对 Grape 的需求**记录：`/api/issues/{owner}/{repo}` 补分页参数。

---

## 3. 数据通道：三条路线，选 B

| | A. 浏览器直连 Grape API | **B. 宿主 HTTP 代理（推荐）** | C. typert remote |
|---|---|---|---|
| 机制 | 面板 `fetch("https://www.grapedev.cn/api/...")` | 宿主 `ctx.webServer.register({kind:'prefix', path, handler})`，面板同源 fetch | `ctx.typert.register({invocations})` |
| 可行性 | ✅ 实测 CORS 开放（回显 origin、`allow-credentials: true`、允许 `authorization` 头） | ✅ 实测 `dsh-host-webserver` 暴露 `register(WebRoute)` / `registerUpgrade` / `tapIndex` | ✅ 存在，但 contribution 是**build 期 codegen** 产物（TypeScript tracing） |
| token | ❌ 必须把 token 放进浏览器。我们的 token 是 `.role('secret')`（**只写不读**），前端拿不到 → 得让用户另外填一个，凭据分散 | ✅ token 只留宿主，复用现有 `resolveGrapeCliConfig()` | ✅ 同 B |
| 依赖 | 依赖 Grape 侧 CORS 策略（今天开，明天可能关） | 不依赖 CORS（同源） | 不依赖 |
| 加工能力 | 无（前端各自解析） | ✅ 可服务端合并/缓存/去重，口径与 33 个工具一致 | ✅ |
| 工作量 | 最小 | 小～中 | 最大（需接 codegen） |

**选 B。** 理由：凭据不外泄是硬要求（且我们的 token 本来就设计成只写不读）；同源免 CORS 依赖；能复用已建好的 CLI 调用层。

---

## 4. 宿主代理接口（`src/panel-api.ts`，host 半部）

```
GET /grape-panel-api/repos
GET /grape-panel-api/issues?owner=<o>&repo=<r>&status=<s>
GET /grape-panel-api/pipeline?owner=<o>&repo=<r>&number=<n>
```

设计要点：

1. **只读白名单**：三个固定 GET，handler 内部只调用上表三条 CLI 命令，
   **绝不把前端传来的字符串拼进任意 CLI 参数**（否则等于开了个任意命令执行后门）。
   `owner/repo/number` 做严格白名单校验（`^[\w.-]+$` / `^\d+$`）。
2. **复用现有 CLI 层**：直接调 `src/cli-client.ts` 的 spawn 封装，
   与 33 个工具**同一套 config 解析**（`bin`/`baseUrl`/`token`/`timeout`，含 `.volatile()` live 值）。
3. **并发去重 + 短 TTL 缓存**（30s，按完整 URL 做 key）：
   spawn CLI 每次几百 ms 冷启动，用户点来点去会打爆；缓存同时让「返回再点进去」瞬时。
4. **错误结构化**：CLI 的非零退出/403/超时 → `{ok:false, code, message}`，
   message 用 CLI 原文（例如那条 403 提示），面板**原样展示**——不吞错。
5. **不新增写接口**：浏览只做「看」。触发/建 issue/改状态仍走 AI 工具 + 写确认（P8）。

---

## 5. 前端结构（client half）

**Tab 归属**：与现有实时观察窗**同一个 tab，顶部模式切换**（用官方 `SegmentedTabs`），
避免右栏塞满 tab。两种模式：

```
[ 实时 · 浏览 ]   ← SegmentedTabs
```

**导航状态**（放 `src/client/browse-store.ts`，与焦点 store 并列）：

```ts
type BrowseView =
  | { kind: 'repos' }
  | { kind: 'issues';  owner: string; repo: string }
  | { kind: 'pipeline'; owner: string; repo: string; number: number }

// 栈式历史 → 面包屑 + 返回
stack: BrowseView[]
```

**三个视图组件**

| 组件 | 内容 | 复用 |
|---|---|---|
| `RepoList` | 一行一仓库：`full_name` + `role`(Tag) + `status`(StateDot) + webhook 标 | `Tag` `StateDot` |
| `IssueList` | 一行一 issue：`#number 标题` + `stage`(Tag) + `status`(Tag tone) + `events_count` + `latest_event` 相对时间 | `Tag` `Button` |
| `PipelineDetail` | **复用现有 `NodeChain` 渲染**（`segments[]` → 节点卡片），加「在官网打开」 | 已有组件 |

**三态**：loading（骨架）/ error（原样错误 + 重试）/ empty（"该仓库暂无 issue"）。
**虚拟化**：仓库/issue 列表 > 50 条时分页（P2），P1 先直接渲染。

---

## 6. 与实时观察窗的关系

| | 实时观察窗（已做） | 资源浏览器（本设计） |
|---|---|---|
| 驱动 | 被动：AI 调工具 → 结果里的焦点标记 | 主动：用户点击 |
| 数据 | 工具结果里的 `_focus`（单条焦点） | 三个 HTTP 接口（列表） |
| 状态 | `#pipe/<n>` / `#event/<seq>` / `#dash` | `repos / issues / pipeline` |
| 面板 | `GrapeFocusPanel` | 新增 `GrapeBrowsePanel` |

**P3 联动**（有价值但非必须）：在浏览到的 issue 上加一个「跟随它」按钮，
把该 issue 设为主焦点 → 切到实时模式 → 之后 AI 一操作它，实时观察窗就自动更新。
这就把「看历史」和「看现在」接成了闭环。

---

## 7. 边界（延续既有原则）

- **只读**：不触发流水线、不改状态、不建 issue、不作 A2A 交接。
- 所有写操作仍走 AI 工具 + 写确认，浏览面板不提供写的入口。
- 面板不持有 token，不把 token 送给浏览器（网络面板里看不到 `grape_`）。

---

## 8. 分阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | 宿主 3 个 GET + 面板三级钻取 + 面包屑/返回 + 三态 + 刷新 + 同 Tab 内「实时/浏览」切换 | ✅ 已实测 |
| **P2** | 仓库名搜索 + issue 搜索/筛选（状态/场景/指派）+ 前端分页兜底 | ✅ 已实测 |
| **P3** | 与实时观察窗联动：「跟随此 issue」→ 设为主焦点 → 切实时模式 | ✅ 已实测 |
| **P4** | 仓库概览卡（`grape dashboard repo`）+ 响应投影 | ✅ 已实测 |
| **P5** | issue → 事件明细（`grape issues events`）+ 按 agent 筛选 + 分页 | ✅ 已实测 |

### P5 实现要点（事件明细）

- **接口**：`GET /grape-panel-api/events?owner=&repo=&number=` → `grape issues events`。
  实测返回 `{events, segments, total}`，其中 **`segments` 与 `events` 内容完全相同**（前者只是别名）
  → 前端统一读 `events`。
- **与节点链的分工**（实测 `grape-admin#11`）：pipeline 的 `segments` 是**阶段节点**（5 个），
  events 是**每个事件**（17 条）。节点链 = 骨架（看当前走到哪），事件列表 = 全过程
  （看发生过什么：seq / agent / 类型 / 状态 / 摘要 / 执行者 / 时间 / skill）。
- 默认**展开**（这就是 P5 要交付的东西，不该再藏一层），超 30 条才分页。
- 按 **agent 筛选**（复用 `ChipRow` + `tally`，取值域从全量派生）——17 条以上没有它就很难读。
  已按某 agent 筛选时**不再重复打该 agent 标签**（整屏同值 = 噪音）。
- 计数写「共 N 条」/「显示 N / 共 M 条」：光写 `5 / 17` 会被误读成分页。
- **刷新联动**：`refresh()` 在流水线视图下连带刷事件明细，否则点「刷新」事件不更新。
- 事件类型映射（`evLabel`，与实时面板共用一份）：实测类型有 `issue_opened` / `a2a_event` /
  `issue_updated` / `pull_request_merged` / `issue_comment`，未收录的保留原样。
- 注：`A2A: → qa` 里的 `→` 在截图分辨率下容易被误读成 `_`，原始数据无下划线（核过）。

### P3 实现要点（跟随）

- **焦点在宿主侧构造**：`GET /grape-panel-api/focus?owner=&repo=&number=` 内部复用宿主自己的
  `pipelineFocus()` + `extractPipelineSummary()`，因此"跟随"得到的焦点与 AI 调工具产生的焦点**同形**
  （同样的 nodes/status/seq/ev/url 口径）→ 实时面板不需要维护第二套渲染路径。
  若在前端另拼一份焦点对象，两边字段迟早漂移。
- **模式切换必须显式**：`setMode('live')` 走模块级 store（`src/client/tab-mode.ts`），
  **不能只依赖**"焦点 URL 变化就切"的副作用 —— AI 已经跟在同一个 issue 上时 URL 不变，
  那样用户点了「跟随」会毫无反应。这是把 mode 从 `GrapeTab` 的 `useState` 提到共享 store 的唯一原因。
- 跟随失败（取不到焦点）时，按钮下方**原样显示错误文案**，不静默。

### P4 实现要点（概览卡 + 响应投影）

- `grape dashboard repo` 实测返回 **64,560 字节**，主体是 `agent_engines`（每个 agent 的全量 worker
  清单，上百条带 device/cred_name/scene_tags）。卡片一条都用不到 →
  宿主侧 `projectDashboard()` **投影**后只回 2,081 字节（约 3%）：身份、metrics、
  场景骨架（节点 tag/next/handoff）、agent 摘要。
- 卡片默认**收起成一行摘要**（竖向空间有限），展开才显示指标 / 场景节点链 / agent 列表。
- ⚠️ **两个口径不一致（Grape 侧）**：`dashboard repo` 的 `role`（Maintainer）与 `repos managed` 的
  `role`（Admin）不同；`metrics.total_issues`（2）与 `issues list` 条数（3）也不同。
  因此收起态**不重复展示**这些字段（避免同屏两个冲突数字被当成面板 bug），
  展开态保留并在指标区下方加一行口径说明。

---

## 9. 风险与坑

1. **CLI 冷启动**：每次 spawn 数百 ms → 必须缓存 + 去重，否则连点卡顿。
2. **issue 列表无分页参数**（见 §2）→ 大仓库可能一次返很多；P1 本地分页兜底，同时向 Grape 提需求。
3. **token 类型**：必须用户 key（`grape_`）；`tk_` 会话 token 会让部分接口表现不同（403 文案里明确写了）。
4. **路由前缀冲突**：`/grape-panel-api` 需确认与 dsh SPA fallback、nginx(18080→3001)、nginx(80→/dsh/) 都不冲突。
   dsh 的命名路由要求 `(kind,path)` 唯一，重复注册会抛异常 → 前缀取足够独特即可。
5. **非 loopback 页面**：配置读写受 dsh 安全设计限制；但**浏览不写配置**，不受影响。
6. **CORS 不依赖**是选 B 的关键收益，别为了省事退回 A。

---

## 10. 验收标准

- [ ] 右栏切到「浏览」→ 列出**全部**已托管仓库
- [ ] 点仓库 → 该仓库 issue 列表，显示 stage / status / 最近事件时间
- [ ] 点 issue → 流水线节点链（复用现有卡片样式）
- [ ] 面包屑与返回可用；刷新可用；错误原样显示（含 403 文案）
- [ ] 浏览器网络面板中**看不到任何 Grape token**（只在宿主侧出现）
- [ ] 连点 10 次不同 issue，无重复 CLI spawn 风暴（缓存命中）
---

## 11. 首屏性能（Issue #27）

> 目标：冷首屏 ≤300ms、5min 内热载 ≤50ms、持久化首屏首字节 ≤50ms、空账号首次 ≤600ms。

### 快路径

- `src/host-fetch.ts`：`/api/repos/managed`、`/api/issues/{owner}/{repo}`、
  `/api/issues/{owner}/{repo}/{number}/pipeline` 三个只读 GET 由宿主 Node 内置 `fetch`
  直连（全局 dispatcher 自带连接池与 TLS 会话复用），不再为每次缓存未命中 spawn 一个 Python CLI。
- 失败回退：无 token / 无 `fetch` / baseUrl 非法 / 非 2xx / 结构不符 / 超时（>8s）/ 网络错误
  → 抛 `HostFetchError`，`panel-api.ts` 原样回退现有 CLI 路径。响应 `timing.source` = `host|cli`。
- 空账号诊断（`/api/auth/profile`、`/api/orgs`）复用同一快路径，并与 `/repos` 的
  `Promise.all` 并行；快路径失败时仍回退 CLI。

### 缓存

- 成功结果 TTL：`CACHE_TTL_MS = 300_000`（5min），可用 `GRAPE_PANEL_CACHE_TTL_MS` 覆盖。
- 失败结果短缓存：`FAILURE_TTL_MS = 8_000`（8s）——连点不连续 spawn，故障恢复后又能快速自愈。
- 保留 `force=1` 精确失效与同 key in-flight 去重（连点 3 次只发起 1 次取数）。

### 持久化首屏（SWR）

- 快照键 `grape-dsh.browse.v1:{baseUrl}:{account}`，值 `{schema, savedAt, data}`；
  另有 `grape-dsh.browse.latest.v1` 指针解决「模块加载时还不知道 baseUrl」。
- 账号仅在空仓库诊断（`viewer.username`）时可得并记忆；非空列表首次加载以空账号分键
  （不为此额外发请求），已知账号后沿用带账号的键。账号只用于分键展示，不承担鉴权。
- 模块加载即 hydrate 根视图 → 先渲染旧数据并标注「数据时间」；后台静默 revalidate，成功替换、失败保留。
- schema 版本不符 / JSON 损坏 / 字段非法即丢弃（安全失效）。

### 预热与错峰

- `prewarmRoot()`：一次 `requestIdleCallback` + 400ms 延迟后预热 `/repos`；
  与 pins 恢复轮询（0/150/300ms）错峰，后台标签页不预热。
- 面板挂载仍调用 `ensureRootLoaded()`；与预热共用 in-flight 去重，不会重复取数。

### 观测

- `/repos` 响应带 `timing { hostMs, cache: hit|miss, source: host|cli, totalMs }`。
- 宿主每次取数打一行日志：`[grape-dsh] panel /repos source=host cache=miss hostMs=9 totalMs=10`
  （不含 token；回退时另打一行 `host-fetch fallback (<code>)`）。
