/**
 * Issue #43 R5 端到端回归：创建并接管时，在会话创建与 attach 之前强制触发面板恢复，
 * 断言只建 1 个会话、只有 1 个 session id 被 attach。
 *
 * 客户端模块（src/client/*.ts）不参与 tsc 产物（仅 typecheck），因此这里用 esbuild
 * 现场打包 takeover-switch.ts，并 stub 浏览器全局后 import；再用源码断言守护
 * 「面板 load() 必须经过创建态门禁」与「两个建会话入口统一走去重层」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    clear: () => { map.clear() },
    key: () => null,
    get length() { return map.size },
  }
}

function deferred() {
  let resolveFn
  let rejectFn
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

let attachBodies = []
let logSteps = []

function installBrowserGlobals() {
  globalThis.sessionStorage = memoryStorage()
  globalThis.localStorage = memoryStorage()
  globalThis.location = { hostname: 'test-host', reload() { /* noop */ } }
  globalThis.window = {
    setTimeout, clearTimeout, setInterval, clearInterval, location: globalThis.location,
  }
  globalThis.document = {
    baseURI: 'http://localhost/',
    hidden: false,
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    querySelector() { return null },
    querySelectorAll() { return [] },
    contains() { return false },
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText() { /* noop */ } } },
    configurable: true,
    writable: true,
  })
  attachBodies = []
  logSteps = []
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    if (init.body) {
      if (target.includes('takeover-attach')) attachBodies.push(JSON.parse(String(init.body)))
      if (target.includes('takeover-log')) logSteps.push(JSON.parse(String(init.body)).step)
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
  }
}

let moduleInstance = 0
const bundledCache = new Map()

async function loadTakeoverSwitch({ withNotice = false } = {}) {
  const cacheKey = withNotice ? 'with-notice' : 'plain'
  if (!bundledCache.has(cacheKey)) {
    // withNotice 变体把 pins-store 的 getNotice 一起导出：setNotice 与 getNotice 共用
    // 同一个 bundle 内模块实例，可以断言「跳过时确实给了用户可见提示」。
    const entry = withNotice
      ? "export * from './src/client/takeover-switch.ts'\nexport { getNotice } from './src/client/pins-store.ts'"
      : "export * from './src/client/takeover-switch.ts'"
    const result = await build({
      stdin: {
        contents: entry,
        resolveDir: repoRoot,
        sourcefile: 'takeover-switch.entry.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      write: false,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"test"' },
    })
    bundledCache.set(cacheKey, result.outputFiles[0].text)
  }
  // 每次追加实例标记：模拟页面 reload 后拿到全新的模块内存态（同一 URL 会被模块缓存复用）
  moduleInstance += 1
  const code = `${bundledCache.get(cacheKey)}\n// instance ${moduleInstance}\n`
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  return import(url)
}

// 测试内会临时 stub globalThis.setTimeout（阻止 DOM 阶梯真等 30s），这里先留住原生实现
const nativeSetTimeout = globalThis.setTimeout

/** 让出若干轮 macrotask（不依赖被测模块内部的 setTimeout）。 */
async function flushTicks(rounds = 50) {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => nativeSetTimeout(r, 0))
}

test('R5 创建与 attach 前强制挂载面板只产生 1 个会话、1 个 attach', async () => {
  installBrowserGlobals()
  const mod = await loadTakeoverSwitch()

  const gate = deferred()
  let createCount = 0
  mod.setApiSessionCreator(() => {
    createCount += 1
    return gate.promise
  })

  mod.switchToTakeoverWorkspace('接管 prompt', 'ws-1', 'Workspace 1', 'tkos-e2e')

  assert.equal(mod.hasPendingTakeover(), true, '底稿应在创建前写入')
  assert.equal(createCount, 1, '创建并接管只应发起一次 create')
  assert.equal(mod.canAutoRecoverPendingTakeover(), false, 'R2：创建进行中面板门禁应为 false')

  // 绕过面板门禁、在 create resolve 与 attach 之前强制走恢复路径（最坏时序）
  const recoverPromise = mod.tryRecoverPendingTakeover()
  assert.equal(createCount, 1, 'R1：重复入口不得再调用 create')

  gate.resolve('session-e2e')
  assert.equal(await recoverPromise, true)
  for (let i = 0; i < 50 && attachBodies.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
  }

  assert.equal(createCount, 1, 'R5：最终只建 1 个会话')
  assert.equal(attachBodies.length, 1, 'R5：只 attach 一次')
  assert.equal(new Set(attachBodies.map((b) => b.client_session)).size, 1, 'R5：只有 1 个 session id 被 attach')
  assert.equal(attachBodies[0].client_session, 'session-e2e')
  assert.equal(mod.hasPendingTakeover(), false, '成功后应清底稿')
})

test('R2 面板 load() 的自动恢复必须经过创建态门禁并做重复对账', () => {
  const source = readFileSync(join(repoRoot, 'src/client/GrapeFocusPanel.tsx'), 'utf8')
  assert.match(source, /canAutoRecoverPendingTakeover/, 'load() 自动恢复必须检查创建态门禁')
  assert.match(source, /reconcileTakeoverSessions/, '服务端已登记本地会话时必须做重复对账')
  const gated = source.indexOf('hasPendingTakeover() &&')
  const gate = source.indexOf('canAutoRecoverPendingTakeover()')
  assert.ok(gated >= 0 && gate > gated, '门禁应作为自动恢复的前置条件')
})

test('R2 UI 回退建会话期间门禁关闭，且不重复发起建会话', async () => {
  installBrowserGlobals()
  const mod = await loadTakeoverSwitch()
  let createCount = 0
  mod.setApiSessionCreator(async () => {
    createCount += 1
    throw new Error('api unavailable')
  })

  // DOM 阶梯在测试里不应真等 30s：只登记创建态，不让 timer 回调跑
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    mod.switchToTakeoverWorkspace('接管 prompt', 'ws-ui', 'Workspace UI', 'tkos-ui')
    await flushTicks()

    assert.equal(createCount, 1, 'API 建会话只应尝试一次')
    assert.equal(mod.hasPendingTakeover(), true, '失败回退前底稿仍在')
    assert.equal(
      mod.canAutoRecoverPendingTakeover(),
      false,
      'R2：UI 回退建会话期间面板门禁必须关闭（否则会再建一条）',
    )

    const recovered = await mod.tryRecoverPendingTakeover()
    assert.equal(recovered, false, 'UI 回退进行中不得再发起 API 恢复')
    assert.equal(createCount, 1, 'R2：回退期间不得再多建会话')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('R2 页面 reload 后持久化创建态仍关闭门禁', async () => {
  installBrowserGlobals()
  const beforeReload = await loadTakeoverSwitch()
  beforeReload.setApiSessionCreator(async () => {
    throw new Error('api unavailable')
  })

  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    beforeReload.switchToTakeoverWorkspace('reload prompt', 'ws-reload', 'Workspace Reload', 'tkos-reload')
    await flushTicks()
    assert.equal(beforeReload.canAutoRecoverPendingTakeover(), false)

    // 模拟 reload：模块内存态清零，只剩 sessionStorage/localStorage
    const afterReload = await loadTakeoverSwitch()
    assert.equal(afterReload.hasPendingTakeover(), true, 'reload 后底稿仍在')
    assert.equal(
      afterReload.canAutoRecoverPendingTakeover(),
      false,
      'R2：reload 后仍须保持创建态门禁，不能立刻再自动恢复一次',
    )
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('R2 resumeTakeoverAfterReload：API 创建中 reload 不得再次调用 apiSessionCreator', async () => {
  installBrowserGlobals()
  const beforeReload = await loadTakeoverSwitch()
  const gate = deferred()
  let createCount = 0
  beforeReload.setApiSessionCreator(() => {
    createCount += 1
    return gate.promise
  })

  beforeReload.switchToTakeoverWorkspace('api reload prompt', 'ws-api-reload', 'Workspace API', 'tkos-api-reload')
  assert.equal(createCount, 1, '首次接管应发起一次 API 创建（此时仍未 resolve）')
  assert.equal(beforeReload.canAutoRecoverPendingTakeover(), false, 'API 创建中门禁应关闭')

  // 模拟 reload：模块内存态（in-flight / 10s 窗口）全丢，只剩 stash 里的创建态标记
  const afterReload = await loadTakeoverSwitch()
  let afterReloadCreate = 0
  afterReload.setApiSessionCreator(async () => {
    afterReloadCreate += 1
    return 'session-duplicate'
  })

  afterReload.resumeTakeoverAfterReload()
  await flushTicks()

  assert.equal(afterReloadCreate, 0, 'R2：reload 后 TTL 内不得再次调用 apiSessionCreator')
  assert.equal(createCount, 1, 'R2：整条链路只应有一次 API 创建尝试')
  assert.ok(logSteps.includes('resume_skipped_creating'), 'reload 恢复应因创建态标记而跳过')
  assert.equal(afterReload.hasPendingTakeover(), true, '底稿应保留，供 TTL 到期/手动重试继续')
  assert.equal(afterReload.canAutoRecoverPendingTakeover(), false, 'R2：门禁在 reload 后仍生效')
})

test('R2 resumeTakeoverAfterReload：UI 回退创建中 reload 不得再次调用 apiSessionCreator', async () => {
  installBrowserGlobals()
  const beforeReload = await loadTakeoverSwitch()
  let beforeCreate = 0
  beforeReload.setApiSessionCreator(async () => {
    beforeCreate += 1
    throw new Error('api unavailable')
  })

  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    // API 失败 → 进入 DOM 回退：创建态标记应转为 UI 来源并落 stash
    beforeReload.switchToTakeoverWorkspace('ui reload prompt', 'ws-ui-reload', 'Workspace UI', 'tkos-ui-reload')
    await flushTicks()
    assert.equal(beforeCreate, 1, '回退前只应尝试一次 API')
    assert.equal(beforeReload.canAutoRecoverPendingTakeover(), false, 'R2：UI 回退中门禁关闭')

    const afterReload = await loadTakeoverSwitch()
    let afterReloadCreate = 0
    afterReload.setApiSessionCreator(async () => {
      afterReloadCreate += 1
      return 'session-duplicate'
    })

    afterReload.resumeTakeoverAfterReload()
    await flushTicks()

    assert.equal(afterReloadCreate, 0, 'R2：UI 回退创建中 reload 后不得再调 apiSessionCreator')
    assert.ok(logSteps.includes('resume_skipped_creating'), 'reload 恢复应因 UI 创建态标记而跳过')
    assert.equal(afterReload.hasPendingTakeover(), true, 'UI 回退未完成时底稿应保留')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('R2 resumeTakeoverAfterReload：创建态 TTL 到期后允许自动恢复', async () => {
  installBrowserGlobals()
  const beforeReload = await loadTakeoverSwitch()
  const gate = deferred()
  beforeReload.setApiSessionCreator(() => gate.promise)
  beforeReload.switchToTakeoverWorkspace('ttl prompt', 'ws-ttl', 'Workspace TTL', 'tkos-ttl')

  // 模拟用户等过了 TTL（180s）：标记时间戳仍沿用原格式
  const raw = globalThis.sessionStorage.getItem('grape.takeover.uiCreating')
  const sep = raw.lastIndexOf('|')
  const expired = `${raw.slice(0, sep)}|${Date.now() - 181_000}`
  globalThis.sessionStorage.setItem('grape.takeover.uiCreating', expired)
  globalThis.localStorage.setItem('grape.takeover.uiCreating', expired)

  const afterReload = await loadTakeoverSwitch()
  let afterReloadCreate = 0
  afterReload.setApiSessionCreator(async () => {
    afterReloadCreate += 1
    return 'session-after-ttl'
  })
  afterReload.resumeTakeoverAfterReload()
  await flushTicks()

  assert.equal(afterReloadCreate, 1, 'TTL 到期后应允许自动恢复（不会永久关门禁）')
  assert.equal(afterReload.hasPendingTakeover(), false, '恢复成功后清底稿')
})

test('R4 takeoverId 单一来源：switch 始终覆盖写 TK_KEY（允许空串），清理时清空', async () => {
  installBrowserGlobals()
  const mod = await loadTakeoverSwitch()
  // 上一次接管残留的旧 id：不能被沿用，否则 create 的 key 与面板 reconcile 的 key 不一致
  globalThis.sessionStorage.setItem('grape.takeover.id', 'tkos-stale')
  globalThis.localStorage.setItem('grape.takeover.id', 'tkos-stale')

  const gate = deferred()
  mod.setApiSessionCreator(() => gate.promise)
  mod.switchToTakeoverWorkspace('接管 prompt', 'ws-2', 'Workspace 2', '')

  assert.equal(mod.getPendingTakeoverId(), '', '无 takeoverId 时也必须覆盖写空串，不能沿用旧 stash')

  gate.resolve('session-2')
  await flushTicks()
  assert.equal(mod.hasPendingTakeover(), false, '成功后应清底稿')
  assert.equal(mod.getPendingTakeoverId(), '', '清理时必须一并清掉 TK_KEY')
})

test('R1 两个建会话入口统一走 createTakeoverSession 去重层', () => {
  const source = readFileSync(join(repoRoot, 'src/client/takeover-switch.ts'), 'utf8')
  const calls = source.match(/await createTakeoverSession\(/g) || []
  assert.equal(calls.length, 2, 'switch 与 recover 两个入口都应走统一去重层')
  assert.doesNotMatch(source, /await apiSessionCreator!?\s*\(/, '不得绕过协调器直接调用 apiSessionCreator')
})

/** 把持久化的创建态标记时间戳改到 TTL 之前（模拟「上一页建完就没再动过」）。 */
function expireCreatingMarker(msAgo = 181_000) {
  const raw = globalThis.sessionStorage.getItem('grape.takeover.uiCreating')
  assert.ok(raw, '应有持久化创建态标记')
  const sep = raw.lastIndexOf('|')
  const expired = `${raw.slice(0, sep)}|${Date.now() - msAgo}`
  globalThis.sessionStorage.setItem('grape.takeover.uiCreating', expired)
  globalThis.localStorage.setItem('grape.takeover.uiCreating', expired)
}

/**
 * 让 DOM 阶梯的 setTimeout 轮询立即推进（不等 30s）：每一拍排成微任务。
 * flushTicks 用原生 setTimeout 让出 macrotask，微任务链会被完整排干。
 */
async function driveLadder(fn, rounds = 200) {
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (cb) => { Promise.resolve().then(cb); return 0 }
  try {
    await fn()
    await flushTicks(rounds)
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
}

test('R7 阶梯自行 reload（行未渲染）后新页继续接管，create 计数 = 1', async () => {
  installBrowserGlobals()
  const beforeReload = await loadTakeoverSwitch()
  let reloadCount = 0
  globalThis.location.reload = () => { reloadCount += 1 }
  let apiAttempts = 0
  beforeReload.setApiSessionCreator(async () => {
    apiAttempts += 1
    throw new Error('api unavailable')   // 触发 UI 回退：进入 DOM 阶梯
  })

  // DOM 全空 → 找不到 workspace 行 → 阶梯走「刷新一次」分支
  await driveLadder(() => {
    beforeReload.switchToTakeoverWorkspace('ladder prompt', 'ws-ladder', 'Workspace Ladder', 'tkos-ladder')
  })

  assert.equal(apiAttempts, 1, 'API 建会话只应尝试一次')
  assert.equal(reloadCount, 1, '行未渲染时阶梯应自行 reload 一次（其它分支不得提前 reload）')
  assert.equal(
    globalThis.sessionStorage.getItem('grape.takeover.uiCreating'),
    null,
    'R7：reload 前必须清掉创建态标记（此时还没建过任何会话）',
  )
  const intent = globalThis.sessionStorage.getItem('grape.takeover.ladderReload')
  assert.ok(intent && intent.startsWith('takeover:tkos-ladder|'), 'R7：reload 前应写「阶梯续做」意图标记')

  // 新页：模块内存态全丢，只剩 stash
  const afterReload = await loadTakeoverSwitch()
  let createCount = 0
  afterReload.setApiSessionCreator(async () => {
    createCount += 1
    return 'session-ladder'
  })
  afterReload.resumeTakeoverAfterReload()
  await flushTicks(200)

  assert.equal(createCount, 1, 'R7：新页应继续接管且只建 1 个会话')
  assert.ok(logSteps.includes('resume_ladder_continue'), 'R7：新页应按「续做」处理')
  assert.equal(logSteps.includes('resume_skipped_creating'), false, 'R7：不得再误判为「创建仍在进行」')
  assert.equal(afterReload.hasPendingTakeover(), false, '续做成功后应清底稿')
})

test('R7 创建态跳过时必须有用户可见提示（不得静默悬空）', async () => {
  installBrowserGlobals()
  const beforeReload = await loadTakeoverSwitch({ withNotice: true })
  const gate = deferred()
  beforeReload.setApiSessionCreator(() => gate.promise)   // 永不 resolve = 创建仍在进行
  beforeReload.switchToTakeoverWorkspace('long prompt', 'ws-notice', 'Workspace Notice', 'tkos-notice')

  // 模拟 reload：只剩 stash 里的创建态标记（TTL 内）
  const afterReload = await loadTakeoverSwitch({ withNotice: true })
  let createCount = 0
  afterReload.setApiSessionCreator(async () => {
    createCount += 1
    return 'session-duplicate'
  })
  afterReload.resumeTakeoverAfterReload()
  await flushTicks(100)

  assert.equal(createCount, 0, '创建中不得再建会话')
  assert.ok(logSteps.includes('resume_skipped_creating'), '应走「创建中跳过」分支')
  const notice = String(afterReload.getNotice() || '')
  assert.ok(notice.includes('自动重试'), `跳过时必须给出可操作的提示，实际：${notice}`)
  assert.equal(afterReload.hasPendingTakeover(), true, '底稿保留，供手动「继续接管」')
})

test('R7 创建态 TTL 到期后恢复前提示「可能已建过会话」', async () => {
  installBrowserGlobals()
  const beforeReload = await loadTakeoverSwitch({ withNotice: true })
  const gate = deferred()
  beforeReload.setApiSessionCreator(() => gate.promise)
  beforeReload.switchToTakeoverWorkspace('ttl notice prompt', 'ws-ttl-notice', 'Workspace TTL', 'tkos-ttl-notice')
  expireCreatingMarker()

  const afterReload = await loadTakeoverSwitch({ withNotice: true })
  // 永不 resolve：让「结果未知」提示不被后续成功/失败提示覆盖，便于断言
  afterReload.setApiSessionCreator(() => new Promise(() => { /* never */ }))
  afterReload.resumeTakeoverAfterReload()
  await flushTicks(100)

  assert.ok(logSteps.includes('creating_state_expired'), 'TTL 到期应留痕')
  assert.ok(logSteps.includes('creating_outcome_unknown'), '恢复前应留痕「结果未知」')
  const notice = String(afterReload.getNotice() || '')
  assert.ok(notice.includes('可能'), `TTL 到期恢复时必须提示「可能已建过会话」，实际：${notice}`)
})