import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildLegacyPrompt, fetchTakeoverBundle, legacyAttachReply, legacyEndpointReply } from '../lib/takeover-bundle.js'

const CFG = { baseUrl: 'http://grape.test', token: 'tkn' }

const PARAMS = {
  repo: 'grape-dev/grape-dsh',
  repoKey: 'gitcode:grape-dev/grape-dsh',
  issueNumber: '9',
  agentType: 'coding',
  host: 'dev-box',
  hostOs: 'linux',
  hostArch: 'x64',
  hostShell: '/bin/sh',
}

function makeApiCall(routes) {
  const calls = []
  const apiCall = async (cfg, method, path, body) => {
    calls.push({ cfg, method, path, body })
    for (const route of routes) {
      const hit = route(method, path)
      if (hit) return hit
    }
    return { ok: false, status: 500, data: { code: 'unexpected', message: 'no route' } }
  }
  return { apiCall, calls }
}

const MAIN_404 = (method, path) =>
  method === 'POST' && path === '/api/takeover/sessions'
    ? { ok: false, status: 404, data: { code: 'not_found', message: 'Not Found' } }
    : null

const MAIN_405 = (method, path) =>
  method === 'POST' && path === '/api/takeover/sessions'
    ? { ok: false, status: 405, data: { code: 'method_not_allowed', message: 'Method Not Allowed' } }
    : null

function legacyRoute(overrides = {}) {
  const data = {
    task_id: 't_legacy_1',
    status: 'running',
    agent_type: 'coding',
    skill: 'coding-cli',
    cwd: '/workspace/grape-dsh',
    prompt: 'P'.repeat(6000),
    env_extra: JSON.stringify({ GRAPE_SESSION_TOKEN: 'tk_legacy', REPO_FULL_NAME: 'grape-dev/grape-dsh' }),
    messages: [
      { seq: 1, type: 'step_start', content: 'Step 1 started' },
      { seq: 2, type: 'tool_use', tool: 'bash', content: 'ls' },
      { seq: 3, type: 'text', content: 'done' },
    ],
    ...overrides,
  }
  return (method, path) =>
    method === 'GET' && path.startsWith('/api/runtime/issues/takeover-context')
      ? { ok: true, status: 200, data }
      : null
}

test('404 triggers legacy fallback and normalizes the bundle', async () => {
  const logs = []
  const warns = []
  const { apiCall, calls } = makeApiCall([MAIN_404, legacyRoute()])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    PARAMS,
  )

  assert.equal(calls.length, 2)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].path, '/api/takeover/sessions')
  assert.equal(calls[0].body.repo_key, 'gitcode:grape-dev/grape-dsh')
  assert.equal(calls[0].body.issue_number, '9')
  assert.equal(calls[0].body.platform, 'dsh')
  assert.equal(calls[0].body.supports.finish, true)
  assert.equal(calls[1].method, 'GET')
  assert.ok(calls[1].path.startsWith('/api/runtime/issues/takeover-context?'))
  assert.match(calls[1].path, /repo_key=gitcode%3Agrape-dev%2Fgrape-dsh/)
  assert.match(calls[1].path, /issue_number=9/)
  assert.match(calls[1].path, /agent_type=coding/)

  assert.equal(out.ok, true)
  assert.equal(out.status, 200)
  assert.equal(out.degraded, true)
  assert.equal(out.notice, '服务端版本较旧，已降级到旧协议')
  assert.equal(out.takeoverId, 'legacy:t_legacy_1')

  const bundle = out.bundle
  assert.equal(bundle.takeover_id, 'legacy:t_legacy_1')
  assert.equal(bundle.workspace.cwd_hint, '/workspace/grape-dsh')
  assert.equal(bundle.env.GRAPE_SESSION_TOKEN, 'tk_legacy')
  assert.equal(bundle.task.id, 't_legacy_1')
  assert.equal(bundle.task.agent_type, 'coding')
  assert.equal(bundle.task.skill, 'coding-cli')
  assert.equal(bundle.history.messages.length, 3)
  assert.equal(bundle.meta.protocol, 'legacy')
  assert.equal(bundle.assets, undefined)

  const prompt = bundle.instructions.prompt
  assert.ok(prompt.includes('## 任务接管'))
  assert.ok(prompt.includes('仓库: grape-dev/grape-dsh'))
  assert.ok(prompt.includes('原任务: t_legacy_1'))
  assert.ok(prompt.includes('## 原任务执行日志'))
  assert.ok(prompt.includes('[工具调用] bash: ls'))
  assert.ok(prompt.includes('## 原始任务 Prompt'))
  assert.ok(prompt.includes('P'.repeat(100)))
  assert.ok(prompt.endsWith('请基于以上上下文继续处理 Issue #9。'))

  assert.equal(logs.length, 1)
  assert.ok(logs[0].includes('fallback to legacy takeover-context'))
  assert.ok(logs[0].includes('repo=grape-dev/grape-dsh'))
  assert.ok(logs[0].includes('issue=9'))
  assert.equal(warns.length, 0)
})

test('405 also triggers legacy fallback', async () => {
  const logs = []
  const { apiCall, calls } = makeApiCall([MAIN_405, legacyRoute()])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: (m) => logs.push(m), warn: () => {} },
    PARAMS,
  )

  assert.equal(calls.length, 2)
  assert.equal(out.ok, true)
  assert.equal(out.degraded, true)
  assert.equal(out.takeoverId, 'legacy:t_legacy_1')
  assert.equal(logs.length, 1)
})

test('legacy env_extra parse failure degrades to empty env instead of throwing', async () => {
  const { apiCall } = makeApiCall([MAIN_404, legacyRoute({ env_extra: 'not-json' })])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: () => {}, warn: () => {} },
    PARAMS,
  )

  assert.equal(out.ok, true)
  assert.deepEqual(out.bundle.env, {})
})

test('legacy without task_id is a readable 404, not server_too_old', async () => {
  const warns = []
  const { apiCall } = makeApiCall([MAIN_404, legacyRoute({ task_id: '', messages: [] })])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: () => {}, warn: (m) => warns.push(m) },
    PARAMS,
  )

  assert.equal(out.ok, false)
  assert.equal(out.status, 404)
  assert.ok(out.message.includes('没有找到 Issue #9 正在运行的任务'))
  assert.equal(warns.length, 0)
})

test('legacy fallback failure returns 501 server_too_old with a structured warn log', async () => {
  const warns = []
  const { apiCall, calls } = makeApiCall([
    MAIN_404,
    (method, path) =>
      method === 'GET' && path.startsWith('/api/runtime/issues/takeover-context')
        ? { ok: false, status: 500, data: { code: 'internal_error' } }
        : null,
  ])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: () => {}, warn: (m) => warns.push(m) },
    PARAMS,
  )

  assert.equal(calls.length, 2)
  assert.equal(out.ok, false)
  assert.equal(out.status, 501)
  assert.equal(out.code, 'server_too_old')
  assert.equal(out.message, '服务端不支持接管接口，请联系管理员升级')
  assert.equal(warns.length, 1)
  assert.ok(warns[0].includes('code=server_too_old'))
  assert.ok(warns[0].includes('repo=grape-dev/grape-dsh'))
  assert.ok(warns[0].includes('issue=9'))
})

test('legacy fallback returning non-JSON body is a complete failure', async () => {
  const { apiCall } = makeApiCall([
    MAIN_404,
    (method, path) =>
      method === 'GET' && path.startsWith('/api/runtime/issues/takeover-context')
        ? { ok: true, status: 200, data: { raw: '<html>gateway 404</html>' } }
        : null,
  ])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: () => {}, warn: () => {} },
    PARAMS,
  )

  assert.equal(out.ok, false)
  assert.equal(out.status, 501)
  assert.equal(out.code, 'server_too_old')
})

for (const status of [400, 401, 409, 500]) {
  test(`main path ${status} is passed through without fallback`, async () => {
    const logs = []
    const warns = []
    const { apiCall, calls } = makeApiCall([
      (method, path) =>
        method === 'POST' && path === '/api/takeover/sessions'
          ? { ok: false, status, data: { code: `err_${status}`, message: `boom ${status}` } }
          : null,
      legacyRoute(),
    ])

    const out = await fetchTakeoverBundle(
      { cfg: CFG, apiCall, log: (m) => logs.push(m), warn: (m) => warns.push(m) },
      PARAMS,
    )

    assert.equal(calls.length, 1, 'must not retry legacy for real business errors')
    assert.equal(out.ok, false)
    assert.equal(out.status, status)
    assert.equal(out.code, `err_${status}`)
    assert.equal(out.message, `boom ${status}`)
    assert.equal(out.degraded, false)
    assert.equal(logs.length, 0)
    assert.equal(warns.length, 0)
  })
}

test('main path success is returned untouched (no degradation)', async () => {
  const { apiCall, calls } = makeApiCall([
    (method, path) =>
      method === 'POST' && path === '/api/takeover/sessions'
        ? {
            ok: true,
            status: 200,
            data: {
              takeover_id: 'tko_new_1',
              cancel_ok: true,
              cancel_error: '',
              bundle: { takeover_id: 'tko_new_1', workspace: { cwd_hint: '/w/new' }, env: {}, task: { id: 't_1' } },
            },
          }
        : null,
  ])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: () => {}, warn: () => {} },
    PARAMS,
  )

  assert.equal(calls.length, 1)
  assert.equal(out.ok, true)
  assert.equal(out.degraded, false)
  assert.equal(out.notice, '')
  assert.equal(out.takeoverId, 'tko_new_1')
  assert.equal(out.bundle.workspace.cwd_hint, '/w/new')
  assert.equal(out.cancelOk, true)
})

test('main path success without takeover_id falls back to bundle.takeover_id', async () => {
  const { apiCall } = makeApiCall([
    (method, path) =>
      method === 'POST' && path === '/api/takeover/sessions'
        ? { ok: true, status: 200, data: { bundle: { takeover_id: 'tko_in_bundle', workspace: { cwd_hint: '/w/b' } } } }
        : null,
  ])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: () => {}, warn: () => {} },
    PARAMS,
  )

  assert.equal(out.takeoverId, 'tko_in_bundle')
})

test('buildLegacyPrompt keeps the tail of long logs and the original prompt', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({
    seq: i + 1,
    type: 'text',
    content: `line-${i}-${'x'.repeat(400)}`,
  }))
  const prompt = buildLegacyPrompt({
    repo: 'grape-dev/grape-dsh',
    issueNumber: '9',
    agentType: 'coding',
    skill: 'coding-cli',
    taskId: 't_1',
    messages,
    originalPrompt: `${'α'.repeat(5000)}TAIL-MARKER`,
  })

  assert.ok(prompt.includes('line-39'))
  assert.ok(!prompt.includes('line-0-'))
  assert.ok(prompt.includes('TAIL-MARKER'))
  assert.ok(!prompt.includes('α'.repeat(4001)))
  assert.ok(prompt.length < 14000)
  assert.ok(prompt.endsWith('请基于以上上下文继续处理 Issue #9。'))
})

test('404 with a business code is passed through instead of falling back to legacy', async () => {
  const logs = []
  const warns = []
  const { apiCall, calls } = makeApiCall([
    (method, path) =>
      method === 'POST' && path === '/api/takeover/sessions'
        ? { ok: false, status: 404, data: { code: 'no_running_task', message: '没有正在运行的任务' } }
        : null,
    legacyRoute(),
  ])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    PARAMS,
  )

  assert.equal(calls.length, 1, 'business 404 must not be retried against the legacy endpoint')
  assert.equal(out.ok, false)
  assert.equal(out.status, 404)
  assert.equal(out.code, 'no_running_task')
  assert.equal(out.message, '没有正在运行的任务')
  assert.notEqual(out.code, 'server_too_old')
  assert.equal(logs.length, 0)
  assert.equal(warns.length, 0)
})

test('404 without a business code (bare route miss) still falls back', async () => {
  const { apiCall, calls } = makeApiCall([
    (method, path) =>
      method === 'POST' && path === '/api/takeover/sessions'
        ? { ok: false, status: 404, data: {} }
        : null,
    legacyRoute(),
  ])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: () => {}, warn: () => {} },
    PARAMS,
  )

  assert.equal(calls.length, 2)
  assert.equal(out.ok, true)
  assert.equal(out.degraded, true)
})

test('404 with route_not_found code is treated as a missing route and falls back', async () => {
  const { apiCall, calls } = makeApiCall([
    (method, path) =>
      method === 'POST' && path === '/api/takeover/sessions'
        ? { ok: false, status: 404, data: { code: 'route_not_found', message: 'no such route' } }
        : null,
    legacyRoute(),
  ])

  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: () => {}, warn: () => {} },
    PARAMS,
  )

  assert.equal(calls.length, 2)
  assert.equal(out.ok, true)
  assert.equal(out.degraded, true)
})

test('legacy takeover short-circuits progress/finish/request-finish/abort locally', () => {
  const tid = 'legacy:t_legacy_1'

  const progress = legacyEndpointReply('progress', tid)
  assert.equal(progress.status, 200)
  assert.equal(progress.body.ok, true)
  assert.equal(progress.body.local_only, true)
  assert.equal(progress.body.skipped, true)

  const requestFinish = legacyEndpointReply('request-finish', tid)
  assert.equal(requestFinish.status, 200)
  assert.equal(requestFinish.body.ok, true)
  assert.equal(requestFinish.body.skipped, true)

  const finish = legacyEndpointReply('finish', tid)
  assert.equal(finish.status, 200)
  assert.equal(finish.body.ok, false)
  assert.match(String(finish.body.message), /平台手动完成/)

  const abort = legacyEndpointReply('abort', tid)
  assert.equal(abort.status, 200)
  assert.equal(abort.body.ok, false)
  assert.match(String(abort.body.message), /平台手动处理/)
})

test('new-protocol takeover ids are not short-circuited locally', () => {
  for (const endpoint of ['progress', 'request-finish', 'finish', 'abort']) {
    assert.equal(legacyEndpointReply(endpoint, 'tko_new_1'), null)
  }
  assert.equal(legacyAttachReply('tko_new_1', 'cs-1', undefined), null)
})

test('legacy attach is answered locally with the registered workspace', () => {
  const withWs = legacyAttachReply('legacy:t_1', 'cs-1', { id: 'ws_1', name: 'takeover' })
  assert.equal(withWs.status, 200)
  assert.equal(withWs.body.ok, true)
  assert.equal(withWs.body.local_only, true)
  assert.equal(withWs.body.workspace_id, 'ws_1')
  assert.equal(withWs.body.workspace_name, 'takeover')
  assert.equal(withWs.body.client_session, 'cs-1')

  const withoutWs = legacyAttachReply('legacy:t_2', 'cs-2', undefined)
  assert.equal(withoutWs.status, 200)
  assert.equal(withoutWs.body.ok, true)
  assert.equal(withoutWs.body.workspace_id, '')
})

test('non-404/405 failure propagates code, message and request_id (platform 500)', async () => {
  const { apiCall, calls } = makeApiCall([
    (method, path) => method === 'POST' && path === '/api/takeover/sessions'
      ? { ok: false, status: 500, data: { code: 'internal_error', message: '服务器内部错误，请稍后重试', request_id: 'req-abc123' } }
      : null,
  ])
  const out = await fetchTakeoverBundle(
    { cfg: CFG, apiCall, log: () => {}, warn: () => {} },
    PARAMS,
  )
  assert.equal(out.ok, false)
  assert.equal(out.status, 500)
  assert.equal(out.code, 'internal_error')
  assert.equal(out.message, '服务器内部错误，请稍后重试')
  // 平台 500 回执里的 request_id 必须原样带回面板（否则用户无法贴给平台定位日志）
  assert.equal(out.requestId, 'req-abc123')
  // 500 不是“服务端太旧”，不得回退 legacy
  assert.equal(calls.length, 1)
})
