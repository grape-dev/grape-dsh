/**
 * 宿主 fetch 快路径单元测试（Issue #27）。
 *
 * 测试 seam：`src/host-fetch.ts` 的公开取数函数接受注入的 `fetchImpl`，
 * 不需要真实网络即可覆盖：URL/鉴权映射、非 2xx、超时、结构校验、错误不含 token。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HostFetchError,
  buildAuthProfileUrl,
  buildIssuesListUrl,
  buildIssuesMineUrl,
  buildOrgsListUrl,
  buildPipelineUrl,
  buildReposManagedUrl,
  buildScenesWithPipelineUrl,
  hostFetchAuthProfile,
  hostFetchIssuesList,
  hostFetchIssuesMine,
  hostFetchOrgsList,
  hostFetchPipeline,
  hostFetchReposManaged,
  hostFetchScenesWithPipeline,
  isHostFetchSupported,
} from '../lib/host-fetch.js'

const TARGET = { baseUrl: 'https://grape.example.com', token: 'grape_secret_value', timeoutSec: 30 }

/** 构造一个只回放固定响应的 fetch（记录入参） */
function stubFetch(payload, { status = 200, delayMs = 0 } = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    if (init?.signal?.aborted) {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return payload },
      async text() { return typeof payload === 'string' ? payload : JSON.stringify(payload) },
    }
  }
  impl.calls = calls
  return impl
}

test('URL 映射：repos managed / issues list（含过滤参数）/ pipeline', () => {
  assert.equal(buildReposManagedUrl(TARGET), 'https://grape.example.com/api/repos/managed')

  const issues = buildIssuesListUrl(TARGET, { owner: 'alice', repo: 'proj', status: 'processing', assignees: 'bob' })
  assert.equal(issues, 'https://grape.example.com/api/issues/alice/proj?status=processing&assignees=bob')
  assert.equal(buildIssuesListUrl(TARGET, { owner: 'alice', repo: 'proj' }),
    'https://grape.example.com/api/issues/alice/proj')

  assert.equal(buildPipelineUrl(TARGET, { owner: 'alice', repo: 'proj', number: 27 }),
    'https://grape.example.com/api/issues/alice/proj/27/pipeline')
})

test('issues URL：q / page / per_page 仅在提供时入参（Issue #41）', () => {
  assert.equal(
    buildIssuesListUrl(TARGET, { owner: 'alice', repo: 'proj', status: 'processing', q: 'Gitee 43', page: 2, per_page: 50 }),
    'https://grape.example.com/api/issues/alice/proj?status=processing&q=Gitee+43&page=2&per_page=50',
  )
  assert.equal(
    buildIssuesListUrl(TARGET, { owner: 'alice', repo: 'proj', q: '4341' }),
    'https://grape.example.com/api/issues/alice/proj?q=4341',
  )
  assert.equal(
    buildIssuesListUrl(TARGET, { owner: 'alice', repo: 'proj', q: '4341', page: 1, per_page: 50 }),
    'https://grape.example.com/api/issues/alice/proj?q=4341&page=1&per_page=50',
  )
})

test('issues 快路径把 q 拼进实际请求 URL（Issue #41：第二道关口）', async () => {
  const fetchImpl = stubFetch({ issues: [{ issue_number: '4341' }], total: null, has_more: false })
  const out = await hostFetchIssuesList(
    TARGET,
    { owner: 'grape-dev', repo: 'grape', q: '4341', per_page: 50 },
    { fetchImpl },
  )
  assert.equal(fetchImpl.calls[0].url,
    'https://grape.example.com/api/issues/grape-dev/grape?q=4341&per_page=50')
  assert.equal(out.data.has_more, false)
})

test('baseUrl 末尾斜杠与无协议容错', () => {
  assert.equal(buildReposManagedUrl({ ...TARGET, baseUrl: 'https://grape.example.com/' }),
    'https://grape.example.com/api/repos/managed')
  assert.equal(buildReposManagedUrl({ ...TARGET, baseUrl: 'grape.example.com' }),
    'http://grape.example.com/api/repos/managed')
})

test('repos 快路径：Bearer 鉴权 + hostMs 计时 + 原始数据透传', async () => {
  const data = { repos: [{ full_name: 'alice/proj' }] }
  const fetchImpl = stubFetch(data)
  const out = await hostFetchReposManaged(TARGET, { fetchImpl })
  assert.deepEqual(out.data, data)
  assert.equal(typeof out.hostMs, 'number')
  assert.ok(out.hostMs >= 0)
  assert.equal(fetchImpl.calls[0].url, 'https://grape.example.com/api/repos/managed')
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer grape_secret_value')
  assert.equal(fetchImpl.calls[0].init.headers.accept, 'application/json')
})

test('repos 兼容 CLI 直接返回数组的形态', async () => {
  const out = await hostFetchReposManaged(TARGET, { fetchImpl: stubFetch([{ full_name: 'a/b' }]) })
  assert.ok(Array.isArray(out.data))
})

test('issues / pipeline 快路径投影字段结构校验', async () => {
  const issues = { issues: [{ issue_number: 1, title: 't' }], total: 1 }
  const okIssues = await hostFetchIssuesList(TARGET, { owner: 'a', repo: 'b', status: 'open' },
    { fetchImpl: stubFetch(issues) })
  assert.deepEqual(okIssues.data, issues)

  const pipeline = { issue: { number: 1 }, status: 'running', segments: [] }
  const okPipe = await hostFetchPipeline(TARGET, { owner: 'a', repo: 'b', number: 1 },
    { fetchImpl: stubFetch(pipeline) })
  assert.deepEqual(okPipe.data, pipeline)
})

test('结构不符 → HostFetchError(code=schema)，供上层回退 CLI', async () => {
  for (const [fn, args, bad] of [
    [hostFetchReposManaged, [TARGET], { nope: true }],
    [hostFetchIssuesList, [TARGET, { owner: 'a', repo: 'b' }], { nope: [] }],
    [hostFetchPipeline, [TARGET, { owner: 'a', repo: 'b', number: 1 }], { segments: 'no' }],
  ]) {
    await assert.rejects(
      () => fn(...args, { fetchImpl: stubFetch(bad) }),
      (err) => err instanceof HostFetchError && err.code === 'schema',
    )
  }
})

test('非 2xx → HostFetchError(code=http)，消息含状态码但不含 token', async () => {
  await assert.rejects(
    () => hostFetchReposManaged(TARGET, { fetchImpl: stubFetch({ detail: 'denied' }, { status: 403 }) }),
    (err) => {
      assert.ok(err instanceof HostFetchError)
      assert.equal(err.code, 'http')
      assert.match(err.message, /403/)
      assert.ok(!err.message.includes(TARGET.token), '错误消息不得含 token')
      return true
    },
  )
})

test('超时 → HostFetchError(code=timeout)，且不泄 token', async () => {
  const slow = stubFetch({ repos: [] }, { delayMs: 200 })
  await assert.rejects(
    () => hostFetchReposManaged(TARGET, { fetchImpl: slow, timeoutMs: 20 }),
    (err) => {
      assert.ok(err instanceof HostFetchError)
      assert.equal(err.code, 'timeout')
      assert.ok(!err.message.includes(TARGET.token))
      return true
    },
  )
})

test('无 token / fetch 不可用 / baseUrl 非法 → 明确错误码', async () => {
  await assert.rejects(() => hostFetchReposManaged({ ...TARGET, token: '' }, { fetchImpl: stubFetch({ repos: [] }) }),
    (err) => err.code === 'no-token')
  await assert.rejects(() => hostFetchReposManaged(TARGET, { fetchImpl: null }),
    (err) => err.code === 'no-fetch')
  await assert.rejects(() => hostFetchReposManaged({ ...TARGET, baseUrl: '' }, { fetchImpl: stubFetch({ repos: [] }) }),
    (err) => err.code === 'bad-base-url')
  assert.equal(isHostFetchSupported(), typeof globalThis.fetch === 'function')
})

test('网络错误 → HostFetchError(code=network)', async () => {
  const impl = async () => { throw new TypeError('connect ECONNREFUSED') }
  await assert.rejects(() => hostFetchReposManaged(TARGET, { fetchImpl: impl }),
    (err) => err.code === 'network' && /ECONNREFUSED/.test(err.message))
})

test('JSON 解析失败 → HostFetchError(code=schema)', async () => {
  const impl = async () => ({
    ok: true, status: 200,
    async json() { throw new SyntaxError('bad json') },
    async text() { return 'not json' },
  })
  await assert.rejects(() => hostFetchReposManaged(TARGET, { fetchImpl: impl }),
    (err) => err.code === 'schema')
})
test('空账号诊断：auth profile / orgs list 快路径与 URL 映射', async () => {
  assert.equal(buildAuthProfileUrl(TARGET), 'https://grape.example.com/api/auth/profile')
  assert.equal(buildOrgsListUrl(TARGET), 'https://grape.example.com/api/orgs')

  const profile = { username: 'nobody', managed_repos: [] }
  const p = await hostFetchAuthProfile(TARGET, { fetchImpl: stubFetch(profile) })
  assert.deepEqual(p.data, profile)

  const orgs = [{ name: 'personal', role: 'owner' }]
  const o = await hostFetchOrgsList(TARGET, { fetchImpl: stubFetch(orgs) })
  assert.deepEqual(o.data, orgs)

  await assert.rejects(() => hostFetchAuthProfile(TARGET, { fetchImpl: stubFetch([]) }),
    (err) => err.code === 'schema')
  await assert.rejects(() => hostFetchOrgsList(TARGET, { fetchImpl: stubFetch({ nope: 1 }) }),
    (err) => err.code === 'schema')
})

test('超时覆盖响应体：头已到而 body 挂住 → HostFetchError(timeout)，不会永久挂死（Issue #27 C1）', async () => {
  let aborted = false
  const impl = async (_url, init) => {
    init?.signal?.addEventListener('abort', () => { aborted = true })
    return {
      ok: true,
      status: 200,
      // 响应头已返回、body 永不结束：旧实现拿到头就 clearTimeout，
      // 这里会一直 pending，panel-api 的 inflight 也永不清理。
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
    }
  }

  const t0 = Date.now()
  await assert.rejects(
    () => hostFetchReposManaged(TARGET, { fetchImpl: impl, timeoutMs: 30 }),
    (err) => err instanceof HostFetchError && err.code === 'timeout',
  )
  assert.equal(aborted, true, '超时必须 abort 底层请求（否则 body 流不会中断）')
  assert.ok(Date.now() - t0 < 2_000, '应在超时附近返回，而不是等到进程结束')
})

// ── Issue #42：场景列表快路径（复制需求 / 移交流水线共用）──

test('scenes URL 含 repo=owner/repo（URL 编码，防止斜杠被当成路径段）', () => {
  assert.equal(
    buildScenesWithPipelineUrl(TARGET, { owner: 'grape-dev', repo: 'grape-dsh' }),
    'https://grape.example.com/api/scenes/with-pipeline?repo=grape-dev%2Fgrape-dsh',
  )
  assert.equal(
    buildScenesWithPipelineUrl({ baseUrl: 'https://grape.example.com/', token: 't' }, { owner: 'o', repo: 'r' }),
    'https://grape.example.com/api/scenes/with-pipeline?repo=o%2Fr',
    'baseUrl 末尾斜杠要归一',
  )
})

test('scenes 快路径：Bearer 鉴权 + 原样透传场景列表', async () => {
  const payload = { scenes: [{ id: 's1', display_name: '流水线', work_branch: 'dev', nodes: [] }] }
  const impl = stubFetch(payload)
  const out = await hostFetchScenesWithPipeline(TARGET, { owner: 'o', repo: 'r' }, { fetchImpl: impl })
  assert.equal(impl.calls.length, 1)
  assert.match(impl.calls[0].url, /\/api\/scenes\/with-pipeline\?repo=o%2Fr$/)
  assert.equal(impl.calls[0].init.headers.authorization, `Bearer ${TARGET.token}`)
  assert.deepEqual(out.data, payload)
  assert.equal(typeof out.hostMs, 'number')
})

test('scenes 快路径：结构不符 → HostFetchError(schema)，供上层降级当前场景', async () => {
  await assert.rejects(
    () => hostFetchScenesWithPipeline(TARGET, { owner: 'o', repo: 'r' }, { fetchImpl: stubFetch({ nope: 1 }) }),
    (err) => err instanceof HostFetchError && err.code === 'schema',
  )
  await assert.rejects(
    () => hostFetchScenesWithPipeline(TARGET, { owner: 'o', repo: 'r' }, { fetchImpl: stubFetch({ scenes: [] }, { status: 403 }) }),
    (err) => err instanceof HostFetchError && err.code === 'http',
  )
})

// ── Issue #42 复审 R1：/task 的 mine 行走 HTTP（per_page=100）──

test('mine URL：repo_key + per_page=100（per_page 只在提供时入参）', () => {
  assert.equal(
    buildIssuesMineUrl(TARGET, { repo_key: 'gitcode:grape-dev/grape-dsh', per_page: 100 }),
    'https://grape.example.com/api/issues/mine?repo_key=gitcode%3Agrape-dev%2Fgrape-dsh&per_page=100',
  )
  assert.equal(
    buildIssuesMineUrl(TARGET, { repo_key: 'gitcode:grape-dev/grape-dsh' }),
    'https://grape.example.com/api/issues/mine?repo_key=gitcode%3Agrape-dev%2Fgrape-dsh',
    '不传 per_page 时保持平台默认（与 CLI 缺省行为一致）',
  )
  assert.equal(
    buildIssuesMineUrl({ baseUrl: 'https://grape.example.com/', token: 't' }, { repo_key: 'gitee:o/r', per_page: 100 }),
    'https://grape.example.com/api/issues/mine?repo_key=gitee%3Ao%2Fr&per_page=100',
    'baseUrl 末尾斜杠要归一',
  )
})

test('mine 快路径：Bearer 鉴权 + per_page=100 + 原样透传 issues 行（含 conversation_id / is_running）', async () => {
  const payload = {
    issues: [{
      id: 20864,
      repo_key: 'gitcode:grape-dev/grape-dsh',
      issue_number: 42,
      conversation_id: '41fb4d5e-3e85-4996-988b-0a8429180683',
      is_running: true,
    }],
    total: 1,
  }
  const impl = stubFetch(payload)
  const out = await hostFetchIssuesMine(TARGET, { repo_key: 'gitcode:grape-dev/grape-dsh', per_page: 100 }, { fetchImpl: impl })
  assert.equal(impl.calls.length, 1)
  assert.match(impl.calls[0].url, /\/api\/issues\/mine\?repo_key=gitcode%3Agrape-dev%2Fgrape-dsh&per_page=100$/)
  assert.equal(impl.calls[0].init.headers.authorization, `Bearer ${TARGET.token}`)
  assert.deepEqual(out.data, payload)
  assert.equal(typeof out.hostMs, 'number')
})

test('mine 快路径：结构不符 / 403 → HostFetchError，供 /task 回退 CLI', async () => {
  await assert.rejects(
    () => hostFetchIssuesMine(TARGET, { repo_key: 'gitcode:o/r', per_page: 100 }, { fetchImpl: stubFetch({ nope: 1 }) }),
    (err) => err instanceof HostFetchError && err.code === 'schema',
  )
  await assert.rejects(
    () => hostFetchIssuesMine(TARGET, { repo_key: 'gitcode:o/r', per_page: 100 }, { fetchImpl: stubFetch({ issues: [] }, { status: 403 }) }),
    (err) => err instanceof HostFetchError && err.code === 'http',
  )
})
