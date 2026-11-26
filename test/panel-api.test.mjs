/**
 * 宿主面板代理的缓存 / 回退 / timing 单元测试（Issue #27）。
 *
 * 测试 seam：`createPanelApiHandler(getConfig, deps)` —— deps 注入 CLI exec、
 * 宿主快路径适配器与时钟，用最小 req/res 桩验证真实 HTTP 语义（status + body）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { CACHE_MAX_ENTRIES, CACHE_TTL_MS, FAILURE_TTL_MS, TASK_TTL_MS, createPanelApiHandler } from '../lib/panel-api.js'
import { HostFetchError } from '../lib/host-fetch.js'

const CONFIG = { bin: 'grape', baseUrl: 'https://grape.example.com', token: 'grape_secret_value', timeout: 30 }
const REPOS = { repos: [{ full_name: 'alice/proj', repo_key: 'gitcode:alice/proj', role: 'Admin' }] }

/** 调用 handler（最小 IncomingMessage / ServerResponse 桩） */
function call(handler, path) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url: path }
    const res = {
      status: 0,
      headers: null,
      writeHead(status, headers) { this.status = status; this.headers = headers },
      end(text) {
        try { resolve({ status: this.status, body: JSON.parse(text) }) } catch (err) { reject(err) }
      },
    }
    handler(req, res).catch(reject)
  })
}

function hostOk(data, hostMs = 12) {
  return async () => ({ data, hostMs })
}

function makeDeps(over = {}) {
  const calls = { host: 0, exec: 0 }
  const deps = {
    now: () => 1_000,
    cacheTtlMs: CACHE_TTL_MS,
    failureTtlMs: FAILURE_TTL_MS,
    log: () => {},
    hostFetch: {
      reposManaged: async () => { calls.host += 1; return { data: REPOS, hostMs: 12 } },
      issuesList: async () => { calls.host += 1; return { data: { issues: [], total: 0 }, hostMs: 9 } },
      pipeline: async () => { calls.host += 1; return { data: { segments: [] }, hostMs: 7 } },
    },
    exec: async (cfg, args) => {
      calls.exec += 1
      if (args[0] === 'repos') return REPOS
      if (args[0] === 'auth') return { username: 'cli-user', managed_repos: [] }
      return []
    },
    ...over,
  }
  return { deps, calls }
}

test('常量默认值：TTL 5min / 失败短缓存 5–10s', () => {
  assert.equal(CACHE_TTL_MS, 300_000)
  assert.ok(FAILURE_TTL_MS >= 5_000 && FAILURE_TTL_MS <= 10_000)
})

test('TTL：5min 内命内存缓存，过期后重取，force 精确失效', async () => {
  let now = 1_000
  const { deps, calls } = makeDeps({ now: () => now })
  const handler = createPanelApiHandler(() => CONFIG, deps)

  const r1 = await call(handler, '/grape-panel-api/repos')
  assert.equal(r1.status, 200)
  assert.equal(r1.body.ok, true)
  assert.equal(r1.body.timing.cache, 'miss')
  assert.equal(r1.body.timing.source, 'host')
  assert.equal(calls.host, 1)

  const r2 = await call(handler, '/grape-panel-api/repos')
  assert.equal(r2.body.timing.cache, 'hit')
  assert.equal(calls.host, 1, 'TTL 内不应再次取数')

  now += CACHE_TTL_MS + 1
  const r3 = await call(handler, '/grape-panel-api/repos')
  assert.equal(r3.body.timing.cache, 'miss')
  assert.equal(calls.host, 2)

  const r4 = await call(handler, '/grape-panel-api/repos?force=1')
  assert.equal(r4.body.timing.cache, 'miss')
  assert.equal(calls.host, 3)
})

test('快路径故障自动回退 CLI：source=cli 且面板不报错', async () => {
  const { deps, calls } = makeDeps({
    hostFetch: {
      reposManaged: async () => { throw new HostFetchError('schema', '字段不兼容') },
      issuesList: async () => { throw new Error('boom') },
      pipeline: async () => { throw new Error('boom') },
    },
  })
  const handler = createPanelApiHandler(() => CONFIG, deps)

  const r = await call(handler, '/grape-panel-api/repos')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.timing.source, 'cli')
  assert.equal(r.body.timing.hostMs, null)
  assert.equal(calls.exec, 1)
  assert.match(r.body.data.repos[0].full_name, /alice\/proj/)
})

test('连点 3 次只触发 1 次宿主取数（in-flight 去重）', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let hostCalls = 0
  const { deps } = makeDeps({
    hostFetch: {
      reposManaged: async () => { hostCalls += 1; await gate; return { data: REPOS, hostMs: 10 } },
      issuesList: async () => ({ data: { issues: [] }, hostMs: 1 }),
      pipeline: async () => ({ data: { segments: [] }, hostMs: 1 }),
    },
  })
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const p1 = call(handler, '/grape-panel-api/repos')
  const p2 = call(handler, '/grape-panel-api/repos')
  const p3 = call(handler, '/grape-panel-api/repos')
  release()
  const [a, b, c] = await Promise.all([p1, p2, p3])
  assert.equal(hostCalls, 1)
  for (const r of [a, b, c]) assert.equal(r.body.ok, true)
})

test('失败短缓存：失败 TTL 内不重试，过期后重试', async () => {
  let now = 1_000
  let hostCalls = 0
  let execCalls = 0
  const { deps } = makeDeps({
    now: () => now,
    hostFetch: {
      reposManaged: async () => { hostCalls += 1; throw new HostFetchError('network', 'offline') },
      issuesList: async () => ({ data: { issues: [] }, hostMs: 1 }),
      pipeline: async () => ({ data: { segments: [] }, hostMs: 1 }),
    },
    exec: async () => { execCalls += 1; throw new Error('grape CLI: boom') },
  })
  const handler = createPanelApiHandler(() => CONFIG, deps)

  const r1 = await call(handler, '/grape-panel-api/repos')
  assert.equal(r1.status, 502)
  assert.equal(r1.body.ok, false)
  assert.equal(hostCalls, 1)
  assert.equal(execCalls, 1)

  const r2 = await call(handler, '/grape-panel-api/repos')
  assert.equal(r2.status, 502)
  assert.equal(hostCalls, 1, '失败短缓存内不应重试快路径')
  assert.equal(execCalls, 1, '失败短缓存内不应重试 CLI')

  now += FAILURE_TTL_MS + 1
  const r3 = await call(handler, '/grape-panel-api/repos')
  assert.equal(r3.status, 502)
  assert.equal(hostCalls, 2)
  assert.equal(execCalls, 2)
})

test('/repos 响应带 timing 且宿主打一行日志', async () => {
  const lines = []
  const { deps } = makeDeps({ log: (l) => lines.push(l) })
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/repos')
  assert.deepEqual(Object.keys(r.body.timing).sort(), ['cache', 'hostMs', 'source', 'totalMs'])
  assert.equal(typeof r.body.timing.hostMs, 'number')
  assert.ok(lines.some((l) => /panel.*\/repos.*source=host/.test(l)), `日志缺失：${lines.join(' | ')}`)
  assert.ok(lines.every((l) => !l.includes(CONFIG.token)), '日志不得含 token')
})

test('issues / pipeline 也走快路径（供 pins 轮询与钻取复用）', async () => {
  let hostCalls = 0
  const { deps } = makeDeps({
    hostFetch: {
      reposManaged: async () => ({ data: REPOS, hostMs: 1 }),
      issuesList: async (cfg, q) => { hostCalls += 1; assert.equal(q.owner, 'alice'); return { data: { issues: [], total: 0 }, hostMs: 2 } },
      pipeline: async (cfg, q) => { hostCalls += 1; assert.equal(String(q.number), '27'); return { data: { segments: [] }, hostMs: 3 } },
    },
  })
  const handler = createPanelApiHandler(() => CONFIG, deps)

  const ri = await call(handler, '/grape-panel-api/issues?owner=alice&repo=proj')
  assert.equal(ri.body.timing.source, 'host')
  const rp = await call(handler, '/grape-panel-api/pipeline?owner=alice&repo=proj&number=27')
  assert.equal(rp.body.timing.source, 'host')
  assert.equal(hostCalls, 2)
})

test('空账号：auth profile 与 orgs list 并行（不再串行 await）', async () => {
  let now = 1_000
  let execCalls = 0
  const pending = []
  const { deps } = makeDeps({
    now: () => now,
    hostFetch: {
      reposManaged: async () => ({ data: { repos: [], total: 0 }, hostMs: 5 }),
      issuesList: async () => ({ data: { issues: [] }, hostMs: 1 }),
      pipeline: async () => ({ data: { segments: [] }, hostMs: 1 }),
    },
    exec: async (cfg, args) => {
      execCalls += 1
      const cmd = args[0]
      // 记录发起时刻：并行时两条命令都在同一 tick 发起
      pending.push(cmd)
      return cmd === 'auth' ? { username: 'nobody', managed_repos: [] } : []
    },
  })
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/repos')
  assert.equal(r.body.ok, true)
  assert.deepEqual(pending.sort(), ['auth', 'orgs'])
  assert.equal(execCalls, 2)
  assert.match(JSON.stringify(r.body.data.diagnostics), /nobody/)
})

test('/health 暴露 TTL 配置', async () => {
  const { deps } = makeDeps()
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/health')
  assert.equal(r.body.data.ttlMs, CACHE_TTL_MS)
  assert.equal(r.body.data.failureTtlMs, FAILURE_TTL_MS)
})
test('空账号：账号诊断复用宿主快路径（不再 spawn CLI）', async () => {
  let execCalls = 0
  let hostCalls = 0
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      reposManaged: async () => ({ data: { repos: [], total: 0 }, hostMs: 5 }),
      issuesList: async () => ({ data: { issues: [] }, hostMs: 1 }),
      pipeline: async () => ({ data: { segments: [] }, hostMs: 1 }),
      authProfile: async () => { hostCalls += 1; return { data: { username: 'nobody', managed_repos: [] }, hostMs: 3 } },
      orgsList: async () => { hostCalls += 1; return { data: [{ name: 'personal', role: 'owner', is_personal: true }], hostMs: 2 } },
    },
    exec: async () => { execCalls += 1; return [] },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/repos')
  assert.equal(r.body.ok, true)
  assert.equal(hostCalls, 2)
  assert.equal(execCalls, 0, '快路径可用时不应 spawn CLI')
  assert.match(JSON.stringify(r.body.data.diagnostics), /nobody/)
})
test('缓存按配置身份隔离：换 token 后不返回上一账号数据（Issue #27 C2）', async () => {
  let token = 'grape_account_a'
  const seen = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      reposManaged: async () => {
        seen.push(token)
        return { data: { repos: [{ full_name: `owner-${seen.length}/proj` }] }, hostMs: 5 }
      },
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => ({ ...CONFIG, token }), deps)

  const a = await call(handler, '/grape-panel-api/repos')
  assert.equal(a.status, 200)
  assert.equal(seen.length, 1)
  const aText = JSON.stringify(a.body.data)

  // 同一 handler 实例内换账号（配置 volatile，热改即生效）
  token = 'grape_account_b'
  const b = await call(handler, '/grape-panel-api/repos')
  assert.equal(b.status, 200)
  assert.equal(seen.length, 2, '换账号必须重新取数，不能命中上一账号的缓存')
  assert.notEqual(JSON.stringify(b.body.data), aText, '不得把上一账号的数据返回给新账号')

  // 同一账号再来一次仍命中缓存（隔离不能退化成永不缓存）
  const c = await call(handler, '/grape-panel-api/repos')
  assert.equal(c.body.timing.cache, 'hit')
  assert.equal(seen.length, 2)
})

test('场景补全：scene_id 为空且 scene_source=repo_default → 回退 default 场景（Issue #26 C1）', async () => {
  const calls = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: { pipeline: async () => ({ data: { segments: [] }, hostMs: 3 }) },
    exec: async (_cfg, args) => {
      calls.push(args.join(' '))
      if (args[0] === 'issues' && args[1] === 'detail') {
        // 实测：issues detail 只有 scene_id=''，没有 scene_source / scene_name
        return { scene_id: '' }
      }
      if (args[0] === 'scenes') {
        return { id: 'default', name: '通用开发', nodes: [{ id: 'vod', tag: 'vod' }, { id: 'issue', tag: 'issue' }] }
      }
      return { segments: [] }
    },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/pipeline?owner=o&repo=r&number=1')
  assert.equal(r.status, 200)
  assert.equal(r.body.data.scene_id, 'default', 'repo_default 的 issue 必须回退 default 场景')
  assert.equal(r.body.data.node_count, 2)
  assert.deepEqual(r.body.data.scene_nodes.map((n) => n.tag), ['vod', 'issue'])
  assert.ok(calls.some((c) => c.startsWith('scenes detail --scene_id default')), '应真的按 default 拉场景')
})

test('force 刷新不复用在途结果：等旧请求结束后重新取（Issue #27 R5）', async () => {
  const pending = []
  let n = 0
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      reposManaged: () => new Promise((resolve) => {
        n += 1
        const id = n
        pending.push(() => resolve({ data: { repos: [{ full_name: `call-${id}` }] }, hostMs: 1 }))
      }),
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)

  const first = call(handler, '/grape-panel-api/repos?force=1')
  await new Promise((r) => setTimeout(r, 20))
  const second = call(handler, '/grape-panel-api/repos?force=1')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(pending.length, 1, '在途期间不应再发第二次 host 调用（去重仍生效）')

  pending[0]()
  await first
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(pending.length, 2, 'force 必须在旧请求结束后重新取数')

  pending[1]()
  const r2 = await second
  assert.equal(r2.body.data.repos[0].full_name, 'call-2', '刷新拿到的必须是新结果，而不是在途的旧结果')
})

test('/issues 缓存投影后的值：命中时不携带原始大字段，也不重新取数（Issue #27 R6）', async () => {
  let hostCalls = 0
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      issuesList: async () => {
        hostCalls += 1
        return { data: { issues: [{ number: 1, title: 't', huge: 'x'.repeat(2000) }] }, hostMs: 2 }
      },
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r1 = await call(handler, '/grape-panel-api/issues?owner=o&repo=r')
  assert.equal(r1.body.timing.cache, 'miss')
  assert.equal(hostCalls, 1)
  assert.equal(r1.body.data.issues[0].huge, undefined, '投影后不应带原始大字段')
  const r2 = await call(handler, '/grape-panel-api/issues?owner=o&repo=r')
  assert.equal(r2.body.timing.cache, 'hit')
  assert.equal(hostCalls, 1, '命中缓存不应重新取数')
  assert.equal(r2.body.data.issues[0].issue_number, '1', '投影后只保留 issue_number（Issue #39：统一为字符串）')
  assert.equal(CACHE_MAX_ENTRIES, 200)
})


// ── Issue #39：Gitee 字母数字编号兼容 ──

test('/issues 投影：GitCode 整数与 Gitee 字母数字编号统一为字符串', async () => {
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      issuesList: async () => ({
        data: {
          issues: [
            { number: 32, issue_number: 32, title: 'gitcode' },
            { number: 'IKXR3B', issue_number: 'IKXR3B', title: 'gitee' },
          ],
          total: 2,
        },
        hostMs: 2,
      }),
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/issues?owner=o&repo=r')
  assert.equal(r.status, 200)
  assert.equal(r.body.data.issues[0].issue_number, '32', 'GitCode 整数应归一为字符串')
  assert.equal(r.body.data.issues[1].issue_number, 'IKXR3B', 'Gitee 字母数字编号原样保留')
})

test('/issues 投影："0" 与字段缺失不产生 0 假编号', async () => {
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      issuesList: async () => ({
        data: {
          issues: [
            { number: '0', issue_number: '0', title: 'zero' },
            { number: '0', title: 'parent-zero' },
            { title: 'missing' },
            { number: 0, issue_number: 0, title: 'numeric-zero' },
          ],
          total: 4,
        },
        hostMs: 2,
      }),
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/issues?owner=o&repo=r')
  assert.deepEqual(
    r.body.data.issues.map((i) => i.issue_number),
    ['', '', '', ''],
    '"0"（含 Gitee parent_issue_number 形态）与缺失一律输出空串',
  )
})

test('/pipeline 接受字母数字编号，拒绝 "0" 与非法参数', async () => {
  const seen = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      pipeline: async (cfg, q) => { seen.push(String(q.number)); return { data: { segments: [] }, hostMs: 1 } },
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)

  const ok = await call(handler, '/grape-panel-api/pipeline?owner=o&repo=r&number=IKXR3B')
  assert.equal(ok.status, 200, '字母数字编号应通过校验')
  assert.deepEqual(seen, ['IKXR3B'], '编号应原样透传给宿主快路径')

  for (const bad of ['0', '-1', 'a b', 'a.b', 'a'.repeat(33)]) {
    const r = await call(handler, `/grape-panel-api/pipeline?owner=o&repo=r&number=${encodeURIComponent(bad)}`)
    assert.equal(r.status, 400, `非法编号 ${bad} 应返回 400`)
    assert.equal(r.body.code, 'invalid-param')
  }
})

test('/focus 与 /events 也接受字母数字编号', async () => {
  const seen = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      pipeline: async (cfg, q) => { seen.push(`pipeline:${q.number}`); return { data: { segments: [] }, hostMs: 1 } },
    },
    exec: async (_cfg, args) => {
      seen.push(`${args[0]}:${args[5] ?? ''}`)
      return { events: [], total: 0 }
    },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)

  const f = await call(handler, '/grape-panel-api/focus?owner=o&repo=r&number=IKXR3B')
  assert.equal(f.status, 200)
  assert.equal(f.body.data.number, 'IKXR3B')
  assert.match(f.body.data.url, /#pipe\/IKXR3B$/)

  const e = await call(handler, '/grape-panel-api/events?owner=o&repo=r&number=IKXR3B')
  assert.equal(e.status, 200)
  assert.ok(seen.includes('pipeline:IKXR3B'), '/focus 应把字母数字编号传给 pipeline')
})

// ── Issue #41：/issues 服务端搜索 q ──

/** 取 `--flag value` 中的 value（不存在则 undefined），避免对整条 argv 做脆弱断言 */
function argAfter(args, flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

test('/issues 透传 q：宿主快路径收到 q + per_page=50，并按 q 分键隔离缓存', async () => {
  const seen = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      issuesList: async (_cfg, q) => {
        seen.push(q)
        return {
          data: {
            issues: [{ number: q.q === '4341' ? 4341 : 2, title: String(q.q) }],
            total: null,
            has_more: false,
          },
          hostMs: 1,
        }
      },
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)

  const r1 = await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=4341')
  assert.equal(r1.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].q, '4341', 'q 必须透传到宿主快路径')
  assert.equal(seen[0].per_page, 50, '搜索应请求每页 50 条')
  assert.equal(seen[0].page, undefined, '第 1 页不额外传 page')
  assert.equal(r1.body.data.issues[0].issue_number, '4341')
  assert.equal(r1.body.data.total, null, 'q 响应 total=null 必须原样保留（复审 Optional）')
  assert.equal(r1.body.data.has_more, false, '投影需保留 has_more（q 响应 total=null，翻页只能看它）')

  const r2 = await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=4341')
  assert.equal(r2.body.timing.cache, 'hit')
  assert.equal(seen.length, 1, '同一 q 应命中缓存')

  // 复审 Required #1：占位符引导「#编号」，平台 q 是字面匹配 → 宿主统一剥前导 #；
  // 归一后与 4341 共用同一缓存键/视图键，不再返回 0 条。
  const rHash = await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=%234341')
  assert.equal(rHash.status, 200)
  assert.equal(rHash.body.timing.cache, 'hit', '#4341 归一为 4341 后应命中同一缓存')
  assert.equal(seen.length, 1, '# 前缀不应额外发起取数')

  const r3 = await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=Gitee')
  assert.equal(r3.body.timing.cache, 'miss')
  assert.equal(seen.length, 2, '不同 q 必须分键，不能命中搜 A 的缓存')
  assert.equal(seen[1].q, 'Gitee')

  const r4 = await call(handler, '/grape-panel-api/issues?owner=o&repo=r')
  assert.equal(seen.length, 3)
  assert.equal(seen[2].q, undefined, '默认列表不能带 q')
  assert.equal(seen[2].per_page, undefined, '默认列表每页条数保持现状')
})

test('/issues q 去首尾空白；只有空白视为不搜索', async () => {
  const seen = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      issuesList: async (_cfg, q) => { seen.push(q); return { data: { issues: [] }, hostMs: 1 } },
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)

  const r = await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=%20%204341%20%20')
  assert.equal(r.status, 200)
  assert.equal(seen[0].q, '4341', 'q 应去首尾空白')

  const blank = await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=%20%20%20')
  assert.equal(blank.status, 200)
  assert.equal(seen[1].q, undefined, '只有空白按未搜索处理（回到默认列表）')

  // q=#4341（GitCode 编号）实测平台返回 0 条；归一后按 4341 检索。
  // 换 repo 避免与上面 4341 的缓存键重合（这里验证的是透传，不是缓存命中）。
  const hash = await call(handler, '/grape-panel-api/issues?owner=o&repo=r2&q=%234341')
  assert.equal(hash.status, 200)
  assert.equal(seen[2].q, '4341', '前导 # 必须剥离后再透传平台 q')
})

test('/issues q 走 CLI 兜底：--q + --per_page 50，page>1 才追加 --page', async () => {
  const argsSeen = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: { issuesList: async () => { throw new HostFetchError('timeout', '宿主超时') } },
    exec: async (_cfg, args) => { argsSeen.push(args); return { issues: [], total: null, has_more: true } },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)

  await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=Gitee&page=2')
  assert.deepEqual(argsSeen[0], [
    'issues', 'list', '--owner', 'o', '--repo', 'r',
    '--q', 'Gitee', '--per_page', '50', '--page', '2', '--json-out',
  ])

  await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=4341')
  assert.equal(argAfter(argsSeen[1], '--q'), '4341')
  assert.equal(argAfter(argsSeen[1], '--per_page'), '50')
  assert.equal(argAfter(argsSeen[1], '--page'), undefined, '第 1 页不传 --page')

  // 复审 Required #1：带 # 的编号在 CLI 兜底路径也必须剥成平台可命中的 q
  await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=%23IKXR3B')
  assert.equal(argAfter(argsSeen[2], '--q'), 'IKXR3B', 'CLI 兜底同样剥离前导 #')

  await call(handler, '/grape-panel-api/issues?owner=o&repo=r&status=open')
  assert.equal(argAfter(argsSeen[3], '--q'), undefined, '默认列表不传 --q')
  assert.equal(argAfter(argsSeen[3], '--per_page'), undefined, '默认列表不传 --per_page（行为不变）')
  assert.equal(argAfter(argsSeen[3], '--status'), 'open')
})

test('/issues 非法 q 返回 400，且不发起取数、不影响其他参数', async () => {
  let hostCalls = 0
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      issuesList: async () => { hostCalls += 1; return { data: { issues: [] }, hostMs: 1 } },
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)

  for (const bad of ['a'.repeat(65), 'bad\u0001q', 'tab\there', 'del\u007f', '-q']) {
    const r = await call(handler,
      `/grape-panel-api/issues?owner=o&repo=r&status=processing&q=${encodeURIComponent(bad)}`)
    assert.equal(r.status, 400, `非法 q 应返回 400：${JSON.stringify(bad)}`)
    assert.equal(r.body.code, 'invalid-param')
    assert.match(r.body.message, /q/, '错误信息应指出 q 参数')
  }
  assert.equal(hostCalls, 0, '非法 q 不得发起取数')

  const ok = await call(handler, '/grape-panel-api/issues?owner=o&repo=r&status=processing&q=4341')
  assert.equal(ok.status, 200, '合法 q 与 status 组合仍可用（不影响其他参数）')
  assert.equal(hostCalls, 1)
})

test('/issues 非法 page 返回 400（仅搜索翻页使用）', async () => {
  let hostCalls = 0
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      issuesList: async () => { hostCalls += 1; return { data: { issues: [] }, hostMs: 1 } },
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)

  for (const bad of ['0', '-1', 'abc', '1.5', '1001']) {
    const r = await call(handler, `/grape-panel-api/issues?owner=o&repo=r&q=Gitee&page=${encodeURIComponent(bad)}`)
    assert.equal(r.status, 400, `非法 page 应返回 400：${bad}`)
    assert.equal(r.body.code, 'invalid-param')
  }
  assert.equal(hostCalls, 0)
  const ok = await call(handler, '/grape-panel-api/issues?owner=o&repo=r&q=Gitee&page=2')
  assert.equal(ok.status, 200)
  assert.equal(hostCalls, 1)
})

// ── Issue #42：/task 只读视图（卡片 4 个按钮的数据来源）──

/** 实测 #42 的 issues mine 行 */
const MINE_ROW = {
  id: 20864,
  repo_key: 'gitcode:grape-dev/grape-dsh',
  issue_number: 42,
  title: '需求卡片 4 个操作按钮',
  status: 'processing',
  stage: 'coding',
  scene_id: 'custom-5f5c87a1',
  task_description: '',
  conversation_id: '41fb4d5e',
  is_running: true,
}

/** 按 CLI 命令分派的 exec 桩（记录调用参数，便于断言回退链真的走到了 events detail） */
function taskExec(seen = []) {
  return async (_cfg, args) => {
    seen.push(args)
    if (args[0] === 'issues' && args[1] === 'mine') return { issues: [MINE_ROW], total: 1 }
    if (args[0] === 'issues' && args[1] === 'detail') {
      return { number: 42, issue_id: 20864, scene_id: 'custom-5f5c87a1', events: [{ seq: 108746, event_type: 'issue_opened' }] }
    }
    if (args[0] === 'events' && args[1] === 'detail') {
      return { seq: 108746, payload: { object_attributes: { description: '## 背景\n\n需求原文' } } }
    }
    throw new Error(`unexpected CLI: ${args.join(' ')}`)
  }
}

test('/task：返回 id / issue_number / repo_key / status / scene_id / description / conversation_id', async () => {
  const seen = []
  const deps = { now: () => 1_000, log: () => {}, exec: taskExec(seen), hostFetch: {} }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/task?owner=grape-dev&repo=grape-dsh&number=42')

  assert.equal(r.status, 200)
  const d = r.body.data
  assert.equal(d.id, 20864, '内部 id 用于写路由（移交必须用它，不能用编号）')
  assert.equal(d.issue_number, '42')
  assert.equal(d.repo_key, 'gitcode:grape-dev/grape-dsh')
  assert.equal(d.status, 'processing')
  assert.equal(d.scene_id, 'custom-5f5c87a1')
  assert.equal(d.conversation_id, '41fb4d5e')
  assert.equal(d.task_description, '## 背景\n\n需求原文', 'mine 描述为空时回退 events detail 的 issue_opened 描述')
  assert.equal(d.is_running, true)

  const mineArgs = seen[0]
  assert.equal(argAfter(mineArgs, '--repo_key'), 'gitcode:grape-dev/grape-dsh', 'issues mine 必须按 repo_key 消歧平台')
  assert.equal(
    argAfter(mineArgs, '--per_page'),
    undefined,
    'issues mine 不得带 --per_page（部分 CLI 版本不支持该参数 → Usage 报错 exit 1；分页由 HTTP 快路径承载）',
  )
  assert.equal(argAfter(seen[2], '--seq'), '108746', '描述回退取首个 issue_opened 的 seq')
})

test('/task：mine 行走宿主 HTTP 快路径（repo_key + per_page=100），命中后不再 spawn mine CLI', async () => {
  const mineQueries = []
  const execArgs = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      issuesMine: async (_cfg, q) => {
        mineQueries.push(q)
        return {
          data: {
            issues: [{
              ...MINE_ROW,
              // 描述直接给全：命中后无需再走 detail / events 兜底，CLI 一次都不该被调用
              task_description: '## 背景\n\n需求原文',
            }],
            total: 1,
          },
          hostMs: 11,
        }
      },
    },
    exec: async (_cfg, args) => { execArgs.push(args); throw new Error(`不应回退 CLI: ${args.join(' ')}`) },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/task?owner=grape-dev&repo=grape-dsh&number=42')

  assert.equal(r.status, 200)
  assert.deepEqual(mineQueries, [{ repo_key: 'gitcode:grape-dev/grape-dsh', per_page: 100 }],
    'mine 行必须走 HTTP 且带 per_page=100（默认 20 行会让目标 issue 掉出列表）')
  assert.equal(execArgs.length, 0, 'HTTP 已命中时不得再 spawn 任何 CLI（含注定失败的 mine）')

  const d = r.body.data
  assert.equal(d.id, 20864)
  assert.equal(d.conversation_id, '41fb4d5e', 'mine 行的 conversation_id 必须透出（进入对话依赖它）')
  assert.equal(d.is_running, true, 'mine 行的 is_running 必须透出（运行中按钮态依赖它）')
  assert.equal(d.task_description, '## 背景\n\n需求原文')
})

test('/task：mine HTTP 快路径失败（403/结构不符）→ 回退 issues mine CLI（无 --per_page）', async () => {
  const seen = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      issuesMine: async () => { throw new HostFetchError('http', 'HTTP 403（GET /api/issues/mine）') },
    },
    exec: taskExec(seen),
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/task?owner=grape-dev&repo=grape-dsh&number=42')

  assert.equal(r.status, 200)
  assert.equal(r.body.data.id, 20864, '回退 CLI 仍要拿到内部 id')
  assert.equal(argAfter(seen[0], '--repo_key'), 'gitcode:grape-dev/grape-dsh')
  assert.equal(argAfter(seen[0], '--per_page'), undefined, '回退路径同样不得带 --per_page')
})

test('/task：45s 缓存 + force 精确刷新；cache 命中不重新 spawn CLI', async () => {
  let now = 1_000
  const seen = []
  const deps = { now: () => now, log: () => {}, exec: taskExec(seen), hostFetch: {} }
  const handler = createPanelApiHandler(() => CONFIG, deps)

  assert.equal(TASK_TTL_MS, 45_000)
  const r1 = await call(handler, '/grape-panel-api/task?owner=o&repo=r&number=42')
  assert.equal(r1.body.timing.cache, 'miss')
  const callsAfterFirst = seen.length

  now += TASK_TTL_MS - 1_000
  const r2 = await call(handler, '/grape-panel-api/task?owner=o&repo=r&number=42')
  assert.equal(r2.body.timing.cache, 'hit')
  assert.equal(seen.length, callsAfterFirst, 'TTL 内不得重新取数')

  now += 2_000
  const r3 = await call(handler, '/grape-panel-api/task?owner=o&repo=r&number=42')
  assert.equal(r3.body.timing.cache, 'miss', '超过 45s 必须重取')
  assert.ok(seen.length > callsAfterFirst)

  const force = await call(handler, '/grape-panel-api/task?owner=o&repo=r&number=42&force=1')
  assert.equal(force.body.timing.cache, 'miss', 'force=1 精确失效')
})

test('/task：非法 number → 400，且不发起 CLI', async () => {
  let execCalls = 0
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {},
    exec: async () => { execCalls += 1; return { issues: [] } },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  for (const bad of ['0', '-1', 'a b', '42.1']) {
    const r = await call(handler, `/grape-panel-api/task?owner=o&repo=r&number=${encodeURIComponent(bad)}`)
    assert.equal(r.status, 400, `非法 number 应 400：${bad}`)
    assert.equal(r.body.code, 'invalid-param')
  }
  assert.equal(execCalls, 0)
})

// ── Issue #42：/scenes（复制需求的场景下拉）──

test('/scenes：宿主快路径命中，返回白名单投影且不带 degraded', async () => {
  let hostCalls = 0
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      scenesWithPipeline: async () => {
        hostCalls += 1
        return {
          data: {
            scenes: [{
              id: 's1', display_name: '流水线', work_branch: 'dev-ch-11',
              created_by: 'x', nodes: [{ tag: 'vod', skill: 'vod-cli' }],
            }],
          },
          hostMs: 4,
        }
      },
    },
    exec: async () => { throw new Error('不应回退 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/scenes?owner=o&repo=r')

  assert.equal(r.status, 200)
  assert.equal(hostCalls, 1)
  assert.equal(r.body.timing.source, 'host')
  assert.equal(r.body.data.length, 1)
  assert.equal(r.body.data[0].id, 's1')
  assert.equal(r.body.data[0].created_by, undefined, '只透出白名单字段')
  assert.equal(r.body.data[0].degraded, undefined)
})

test('/scenes：快路径 403 → 降级为当前场景单条 + degraded 标记', async () => {
  const seen = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {
      scenesWithPipeline: async () => { throw new HostFetchError('http', 'HTTP 403') },
    },
    exec: async (_cfg, args) => {
      seen.push(args)
      if (args[0] === 'scenes' && args[1] === 'detail') {
        return { id: 'custom-5f5c87a1', display_name: '源场景', work_branch: 'dev-ch-11', nodes: [{ tag: 'vod' }] }
      }
      throw new Error(`unexpected CLI: ${args.join(' ')}`)
    },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/scenes?owner=o&repo=r&scene_id=custom-5f5c87a1')

  assert.equal(r.status, 200)
  assert.equal(r.body.timing.source, 'cli')
  assert.equal(r.body.data.length, 1, '降级只回当前场景一条，而不是空列表')
  assert.equal(r.body.data[0].id, 'custom-5f5c87a1')
  assert.equal(r.body.data[0].degraded, true)
  assert.equal(argAfter(seen[0], '--scene_id'), 'custom-5f5c87a1')
  assert.equal(argAfter(seen[0], '--repo'), 'o/r')
})

test('/scenes：36 位 UUID scene_id 不再被 32 字上限误拒（Issue #42 回归）', async () => {
  const uuid = '42151cf7-51da-4098-ba24-c9c3765f57ac'
  const seen = []
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {},
    exec: async (_cfg, args) => {
      seen.push(args)
      if (args[0] === 'scenes' && args[1] === 'detail') {
        return { id: uuid, display_name: 'IaC开发', work_branch: 'main', nodes: [{ tag: 'vod' }] }
      }
      throw new Error(`unexpected CLI: ${args.join(' ')}`)
    },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, `/grape-panel-api/scenes?owner=o&repo=r&scene_id=${uuid}`)

  assert.equal(r.status, 200, 'UUID scene_id 必须放行，否则复制需求取不到场景下拉')
  assert.equal(r.body.data.length, 1)
  assert.equal(r.body.data[0].id, uuid)
  assert.equal(argAfter(seen[0], '--scene_id'), uuid)
})

test('/scenes：无 scene_id 且快路径不可用 → 空列表（不伪造场景）', async () => {
  const deps = {
    now: () => 1_000,
    log: () => {},
    hostFetch: {},
    exec: async () => { throw new Error('不应发起 CLI') },
  }
  const handler = createPanelApiHandler(() => CONFIG, deps)
  const r = await call(handler, '/grape-panel-api/scenes?owner=o&repo=r')
  assert.equal(r.status, 200)
  assert.deepEqual(r.body.data, [])
})
