/**
 * 设备身份复用 / 本机只读探测 / `/onboard` 状态机 / 静默拉起护栏 / 时区格式化 的单元测试。
 *
 * 为什么跑 `lib/`：仓库零测试框架（无 jest/vitest 依赖），用 Node 内置 `node:test` 跑 tsc
 * 产物即可，`npm test` 先 build 再跑，不引入任何新依赖。
 *
 * 本文件对应的线上事实（逐字核对 `GET /api/runtime/install` 与 `install.ps1`）：
 *   · 安装目录：Windows `%USERPROFILE%\grape`；普通用户 `$HOME/grape`；root `/opt/grape`
 *   · 配置文件：普通用户 `$HOME/.grape/runtime.env`；root `/etc/grape/runtime.env`
 *   · 键：RUNTIME_TOKEN / RUNTIME_SERVER_URL / RUNTIME_DEVICE_NAME / …
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTO_START_THROTTLE_MS,
  blockAutoStart,
  isWorkerCommand,
  parseEnvText,
  readLocalWorker,
  recordAutoStart,
  resetAutoStartState,
  shouldAutoStartWorker,
  startLocalWorker,
  workerLayout,
  workerLayoutCandidates,
} from '../lib/local-runtime.js'
import {
  decideOnboard,
  listCredentials,
  listServerDevices,
  matchCredential,
  readServerState,
  resolveOnboardDeviceName,
  runOnboardTransaction,
  sanitizeDeviceName,
  verifyDeviceOnline,
} from '../lib/worker-onboard.js'
import { formatTime } from '../lib/time-format.js'

/** 构造一个「文件不存在」错误（与 node fs 一致：code=ENOENT） */
function enoent(path) {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`)
  err.code = 'ENOENT'
  return err
}

/** 构造一个「无权限」错误 */
function eacces(path) {
  const err = new Error(`EACCES: permission denied, open '${path}'`)
  err.code = 'EACCES'
  return err
}

/** 假文件系统：files 里没有的路径一律 ENOENT */
function fakeFs(files) {
  return {
    readFileText: (p) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) {
        const v = files[p]
        if (v instanceof Error) throw v
        return v
      }
      throw enoent(p)
    },
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p) && !(files[p] instanceof Error),
  }
}

const RUNTIME_ENV_TEXT = [
  '# install-worker 写入',
  'RUNTIME_TOKEN=rta_abcdef',
  'RUNTIME_SERVER_URL=https://worker.example.com',
  'RUNTIME_DEVICE_NAME=worker-lab-01',
  'RUNTIME_MAX_CONCURRENT_TASKS=20',
  'RUNTIME_POLL_INTERVAL=3',
  'RUNTIME_HEARTBEAT_INTERVAL=15',
  '',
].join('\n')

// ── 四平台安装布局（M1 / M5）────────────────────────────────────────────

test('workerLayout：Windows 用 %USERPROFILE%\\grape + .grape\\runtime.env（不写死盘符）', () => {
  const win = workerLayout('win32', {}, 'C:\\Users\\me', null)
  assert.equal(win.platform, 'windows')
  assert.equal(win.rootMode, false)
  assert.equal(win.installDir, 'C:\\Users\\me\\grape')
  assert.equal(win.envFile, 'C:\\Users\\me\\.grape\\runtime.env')
  assert.equal(win.versionFile, 'C:\\Users\\me\\.grape\\worker.version')
  assert.equal(win.startScript, 'C:\\Users\\me\\grape\\start-worker.ps1')
  assert.equal(win.pidFile, 'C:\\Users\\me\\grape\\data\\worker.pid')
})

test('workerLayout：Linux root（uid 0）用 /opt/grape + /etc/grape/runtime.env', () => {
  const root = workerLayout('linux', {}, '/root', 0)
  assert.equal(root.platform, 'posix')
  assert.equal(root.rootMode, true)
  assert.equal(root.installDir, '/opt/grape')
  assert.equal(root.envFile, '/etc/grape/runtime.env')
  assert.equal(root.versionFile, '/etc/grape/worker.version')
  assert.equal(root.startScript, '/opt/grape/start-worker.sh')
})

test('workerLayout：Linux 普通用户用 $HOME/grape + $HOME/.grape/runtime.env', () => {
  const user = workerLayout('linux', {}, '/home/me', 1000)
  assert.equal(user.platform, 'posix')
  assert.equal(user.rootMode, false)
  assert.equal(user.installDir, '/home/me/grape')
  assert.equal(user.envFile, '/home/me/.grape/runtime.env')
  assert.equal(user.startScript, '/home/me/grape/start-worker.sh')
})

test('workerLayout：macOS 普通用户与 Linux 普通用户布局一致（只换 home）', () => {
  const mac = workerLayout('darwin', {}, '/Users/me', 501)
  assert.equal(mac.installDir, '/Users/me/grape')
  assert.equal(mac.envFile, '/Users/me/.grape/runtime.env')
  assert.equal(mac.rootMode, false)
})

test('workerLayoutCandidates：POSIX 覆盖另一布局（root 装了普通用户布局也不会误判未安装）', () => {
  const userCands = workerLayoutCandidates('linux', {}, '/home/me', 1000)
  assert.equal(userCands.length, 2)
  assert.equal(userCands[0].envFile, '/home/me/.grape/runtime.env')
  assert.equal(userCands[1].envFile, '/etc/grape/runtime.env')

  const rootCands = workerLayoutCandidates('linux', {}, '/root', 0)
  assert.equal(rootCands[0].envFile, '/etc/grape/runtime.env')
  assert.equal(rootCands[1].envFile, '/root/.grape/runtime.env')

  // Windows 只有一种布局，不产生重复候选
  assert.equal(workerLayoutCandidates('win32', {}, 'C:\\Users\\me', null).length, 1)
})

// ── runtime.env 解析 ───────────────────────────────────────────────────

test('parseEnvText：解析 KEY=VALUE，忽略注释/空行，去包裹引号，值里的 = 保留', () => {
  const env = parseEnvText('# c\n\nRUNTIME_DEVICE_NAME=worker-lab-01\nRUNTIME_SERVER_URL="https://a.example/x?y=1"\nexport EXTRA=1\n')
  assert.equal(env.RUNTIME_DEVICE_NAME, 'worker-lab-01')
  assert.equal(env.RUNTIME_SERVER_URL, 'https://a.example/x?y=1')
  assert.equal(env.EXTRA, '1')
  assert.equal(Object.keys(env).includes('# c'), false)
})

// ── /check 的底层：只读多源探测 ─────────────────────────────────────────

test('readLocalWorker：runtime.env 命中 → source=runtime-env，设备名原样取 RUNTIME_DEVICE_NAME（不再推导 dsh-）', () => {
  const layout = workerLayout('linux', {}, '/home/me', 1000)
  const fs = fakeFs({
    [layout.envFile]: RUNTIME_ENV_TEXT,
    [layout.versionFile]: 'h-6aedab5afaf2\n',
    [layout.installDir]: '',
  })
  const facts = readLocalWorker({
    platform: 'linux', env: {}, home: '/home/me', uid: 1000, ...fs, listProcesses: () => [],
  })
  assert.equal(facts.installed, true)
  assert.equal(facts.running, false)
  assert.equal(facts.source, 'runtime-env')
  assert.equal(facts.deviceName, 'worker-lab-01')
  assert.doesNotMatch(facts.deviceName, /^dsh-/)
  assert.equal(facts.serverUrl, 'https://worker.example.com')
  assert.equal(facts.tokenPresent, true)
  assert.equal(facts.version, 'h-6aedab5afaf2')
  assert.equal(facts.readError, '')
  assert.equal(facts.installDir, '/home/me/grape')
})

test('readLocalWorker：有安装目录/版本但无 runtime.env → source=install-dir（已安装 ≠ 未接入）', () => {
  const layout = workerLayout('linux', {}, '/home/me', 1000)
  const fs = fakeFs({ [layout.installDir]: '', [layout.versionFile]: 'v1' })
  const facts = readLocalWorker({
    platform: 'linux', env: {}, home: '/home/me', uid: 1000, ...fs, listProcesses: () => [],
  })
  assert.equal(facts.installed, true)
  assert.equal(facts.running, false)
  assert.equal(facts.source, 'install-dir')
  assert.equal(facts.deviceName, '')
  assert.equal(facts.tokenPresent, false)
  assert.equal(facts.readError, '')
})

test('readLocalWorker：只有 worker 进程（无 env / 无安装目录）→ source=process 且 running=true', () => {
  const fs = fakeFs({})
  const facts = readLocalWorker({
    platform: 'linux', env: {}, home: '/home/me', uid: 1000, ...fs,
    listProcesses: () => [{ pid: 4242, command: 'python3 -m src.runtime.agent --verbose' }],
  })
  assert.equal(facts.installed, true)
  assert.equal(facts.running, true)
  assert.equal(facts.source, 'process')
})

test('readLocalWorker：env 存在 + 进程在跑 → running=true 且 source 仍以 runtime-env 为准', () => {
  const layout = workerLayout('linux', {}, '/home/me', 1000)
  const fs = fakeFs({ [layout.envFile]: RUNTIME_ENV_TEXT })
  const facts = readLocalWorker({
    platform: 'linux', env: {}, home: '/home/me', uid: 1000, ...fs,
    listProcesses: () => [{ pid: 7, command: '/usr/bin/python3 -m src.runtime.agent' }],
  })
  assert.equal(facts.source, 'runtime-env')
  assert.equal(facts.running, true)
  assert.equal(facts.deviceName, 'worker-lab-01')
})

test('readLocalWorker：什么都没有 → source=none、installed=false（既不是已接入也不是读取失败）', () => {
  const facts = readLocalWorker({
    platform: 'linux', env: {}, home: '/home/me', uid: 1000,
    ...fakeFs({}), listProcesses: () => [],
  })
  assert.equal(facts.installed, false)
  assert.equal(facts.running, false)
  assert.equal(facts.source, 'none')
  assert.equal(facts.readError, '')
})

test('readLocalWorker：遍历候选布局，root 用户装了普通用户布局也能识别（避免误报未安装后再装第二份）', () => {
  const userLayout = workerLayout('linux', {}, '/home/me', 1000)
  const fs = fakeFs({ [userLayout.envFile]: RUNTIME_ENV_TEXT })
  const facts = readLocalWorker({
    platform: 'linux', env: {}, home: '/home/me', uid: 0, ...fs, listProcesses: () => [],
  })
  assert.equal(facts.installed, true)
  assert.equal(facts.source, 'runtime-env')
  assert.equal(facts.deviceName, 'worker-lab-01')
})

test('readLocalWorker：配置文件无权限（EACCES）→ readError 非空，前端据此禁用接入而不是报「未安装」', () => {
  const layout = workerLayout('linux', {}, '/home/me', 1000)
  const fs = fakeFs({ [layout.envFile]: eacces(layout.envFile) })
  const facts = readLocalWorker({
    platform: 'linux', env: {}, home: '/home/me', uid: 1000, ...fs, listProcesses: () => [],
  })
  assert.match(facts.readError, /读取/)
  assert.equal(facts.installed, false)
  assert.equal(facts.source, 'none')
})

test('readLocalWorker：pid 文件存在且进程存活 → running=true（不依赖进程枚举）', () => {
  const layout = workerLayout('linux', {}, '/home/me', 1000)
  const fs = fakeFs({ [layout.envFile]: RUNTIME_ENV_TEXT, [layout.pidFile]: '5150\n' })
  const seen = []
  const facts = readLocalWorker({
    platform: 'linux', env: {}, home: '/home/me', uid: 1000, ...fs,
    listProcesses: () => { seen.push(1); return [] },
    killZero: (pid) => pid === 5150,
  })
  assert.equal(facts.running, true)
  assert.equal(seen.length, 0)
})

// ── /onboard 状态机（M2）────────────────────────────────────────────────

const LOCAL_INSTALLED_RUNNING = {
  installed: true, running: true, deviceName: 'worker-lab-01', serverUrl: 'https://worker.example.com',
  version: 'v1', tokenPresent: true, installDir: '/home/me/grape', envFile: '/home/me/.grape/runtime.env',
  source: 'runtime-env', readError: '',
}

test('decideOnboard：readError 非空 → read-error（500），绝不安装/建凭据', () => {
  const d = decideOnboard({ ...LOCAL_INSTALLED_RUNNING, readError: '读取配置失败' }, {})
  assert.equal(d.action, 'read-error')
  assert.equal(d.status, 500)
})

test('decideOnboard：未安装 → initialize（按现有默认命名规则初始化）', () => {
  const d = decideOnboard({ ...LOCAL_INSTALLED_RUNNING, installed: false, running: false, source: 'none', deviceName: '' }, {})
  assert.equal(d.action, 'initialize')
  assert.equal(d.status, 200)
})

test('decideOnboard：未安装但服务端已有同名凭据 → conflict（不重复造身份，也不擅自吊销）', () => {
  const d = decideOnboard(
    { ...LOCAL_INSTALLED_RUNNING, installed: false, running: false, source: 'none', deviceName: '' },
    { credential: { id: 31, name: 'dsh-lab', status: 'active', device_name: 'worker-other-01' } },
  )
  assert.equal(d.action, 'conflict')
  assert.equal(d.status, 409)
  assert.match(d.message, /#31/)
})

test('decideOnboard：未安装且服务端无同名凭据（含不可判定）→ initialize', () => {
  const notInstalled = { ...LOCAL_INSTALLED_RUNNING, installed: false, running: false, source: 'none', deviceName: '' }
  assert.equal(decideOnboard(notInstalled, {}).action, 'initialize')
  assert.equal(decideOnboard(notInstalled, { unknown: true }).action, 'initialize')
  assert.equal(decideOnboard(notInstalled, { credential: null }).action, 'initialize')
})

test('decideOnboard：本机已装 + 服务端状态不可判定 → conflict（绝不猜成 initialize 再签一条凭据）', () => {
  const d = decideOnboard(LOCAL_INSTALLED_RUNNING, { unknown: true })
  assert.equal(d.action, 'conflict')
  assert.equal(d.status, 409)
  assert.match(d.message, /读取失败/)
})

test('decideOnboard：本环境有这台设备 → already-connected（只展示，不重装）', () => {
  const d = decideOnboard(LOCAL_INSTALLED_RUNNING, {
    credential: { id: 9, name: 'dsh-x', status: 'active', device_name: 'worker-lab-01' },
    device: { device_name: 'worker-lab-01', health: 'online' },
  })
  assert.equal(d.action, 'already-connected')
  assert.equal(d.status, 200)
})

test('decideOnboard：本机在跑但本环境没有这台设备 → initialize（跨环境点接入会真的重建）', () => {
  const d = decideOnboard(LOCAL_INSTALLED_RUNNING, {})
  assert.equal(d.action, 'initialize')
  assert.equal(d.status, 200)
})

test('decideOnboard：本环境无设备行但有同名 active 凭据 → conflict（token 拿不回，不重复签发）', () => {
  const d = decideOnboard(LOCAL_INSTALLED_RUNNING, {
    credential: { id: 1000458, name: 'worker-lab-01', status: 'active', device_name: 'worker-lab-01' },
  })
  assert.equal(d.action, 'conflict')
  assert.equal(d.status, 409)
  assert.match(d.message, /1000458/)
})

// ── 环境隔离（2026-11-20 用户要求）──────────────────────────────────────
// 铁律：本机 runtime.env 的 RUNTIME_SERVER_URL 与插件 config.baseUrl 对不上
//      → 本环境视同「没有 worker」，必须重装；绝不能被本环境的旧设备行判成 already-connected。

test('decideOnboard：服务地址不一致 → server-mismatch（优先级高于 already-connected）', () => {
  const d = decideOnboard(
    { ...LOCAL_INSTALLED_RUNNING, serverUrl: 'https://grape-dev.topxtopx.com' },
    {                                   // 本环境里还留着同名的旧设备行 + 旧凭据行
      device: { device_name: 'worker-lab-01', health: 'offline' },
      credential: { id: 42, name: 'worker-lab-01', status: 'active', device_name: 'worker-lab-01' },
    },
    { baseUrl: 'https://beta.grapedev.cn:9443' },
  )
  assert.equal(d.action, 'server-mismatch')
  assert.equal(d.status, 200)
  assert.match(d.message, /grape-dev\.topxtopx\.com/)
  assert.match(d.message, /beta\.grapedev\.cn:9443/)
})

test('decideOnboard：服务地址一致（仅斜杠/大小写差异）→ 仍按原状态机判定', () => {
  const same = decideOnboard(
    { ...LOCAL_INSTALLED_RUNNING, serverUrl: 'https://BETA.grapedev.cn:9443/' },
    { device: { device_name: 'worker-lab-01', health: 'online' } },
    { baseUrl: 'https://beta.grapedev.cn:9443' },
  )
  assert.equal(same.action, 'already-connected')

  // 未安装时不触发 mismatch（没有 runtime.env 可比），走 initialize
  const notInstalled = decideOnboard(
    { ...LOCAL_INSTALLED_RUNNING, installed: false, running: false, source: 'none', deviceName: '' },
    {},
    { baseUrl: 'https://beta.grapedev.cn:9443' },
  )
  assert.equal(notInstalled.action, 'initialize')
})

test('sanitizeDeviceName：必须以 dsh 开头、小写归一、去非法字符、超长截断', () => {
  assert.equal(sanitizeDeviceName('dsh-worker-001'), 'dsh-worker-001')
  assert.equal(sanitizeDeviceName('Worker 001'), 'dsh-worker-001')
  assert.equal(sanitizeDeviceName('DSH_EC2_09'), 'dsh-ec2-09')
  assert.equal(sanitizeDeviceName('  --dsh--a--b--  '), 'dsh-a-b')
  assert.equal(sanitizeDeviceName(''), '')
  assert.equal(sanitizeDeviceName('   '), '')
  const long = sanitizeDeviceName(`dsh-${'x'.repeat(200)}`)
  assert.ok(long.length <= 88 && long.startsWith('dsh-'))
})

// ── 目标设备名：config 优先（2026-11-23 「配了 deviceName 却按旧 runtime.env 注册」回归）──

test('resolveOnboardDeviceName：config.deviceName 优先于本机 runtime.env（新注册 / 改名以配置为准）', () => {
  assert.equal(resolveOnboardDeviceName('dsh-worker-004', 'dsh-worker-003', 'host-a'), 'dsh-worker-004')
  // 配置名先归一（大小写/空格/非法字符），再作为目标名
  assert.equal(resolveOnboardDeviceName('Worker 004', 'worker-lab-01', 'host-a'), 'dsh-worker-004')
  // 配置与本机一致 → 不变
  assert.equal(resolveOnboardDeviceName('dsh-worker-003', 'dsh-worker-003', 'host-a'), 'dsh-worker-003')
})

test('resolveOnboardDeviceName：未配置 → 原样沿用 runtime.env 的设备名（历史名不二次归一）', () => {
  // 服务端历史设备名不一定 dsh 开头，二次 sanitize 等于凭空换身份
  assert.equal(resolveOnboardDeviceName('', 'worker-lab-01', 'host-a'), 'worker-lab-01')
  assert.equal(resolveOnboardDeviceName('   ', 'dsh-worker-003', 'host-a'), 'dsh-worker-003')
})

test('resolveOnboardDeviceName：配置与本机都为空 → dsh-<host>', () => {
  assert.equal(resolveOnboardDeviceName('', '', 'host-a'), 'dsh-host-a')
  assert.equal(resolveOnboardDeviceName('', '', 'my host!'), 'dsh-my-host')
})

// ── credential 事务化（M2）──────────────────────────────────────────────

test('runOnboardTransaction：安装失败 → 只按本次 created.id revoke，并把错误抛出', async () => {
  const revoked = []
  await assert.rejects(
    runOnboardTransaction({
      deviceName: 'worker-lab-01',
      mint: async (name) => ({ id: 4242, token: 'rta_new', name }),
      install: async () => { throw new Error('install exploded') },
      verify: async () => 'online',
      revoke: async (id) => { revoked.push(id) },
    }),
    /install exploded/,
  )
  assert.deepEqual(revoked, [4242])
})

test('runOnboardTransaction：签发失败 → 不 revoke（没有 created.id 可撤）', async () => {
  const revoked = []
  await assert.rejects(
    runOnboardTransaction({
      deviceName: 'worker-lab-01',
      mint: async () => { throw new Error('mint 403') },
      install: async () => {},
      verify: async () => 'online',
      revoke: async (id) => { revoked.push(id) },
    }),
    /mint 403/,
  )
  assert.deepEqual(revoked, [])
})

test('runOnboardTransaction：安装成功 + 已上线 → ok，且不 revoke', async () => {
  const revoked = []
  const r = await runOnboardTransaction({
    deviceName: 'worker-lab-01',
    mint: async (name) => ({ id: 7, token: 'rta_new', name }),
    install: async () => {},
    verify: async () => 'online',
    revoke: async (id) => { revoked.push(id) },
  })
  assert.equal(r.ok, true)
  assert.equal(r.online, true)
  assert.equal(r.credentialId, 7)
  assert.deepEqual(revoked, [])
})

test('runOnboardTransaction：安装成功但注册未在预算内完成（pending）→ 仍是 ok 且不 revoke（避免把已装机器再打离线）', async () => {
  const revoked = []
  const r = await runOnboardTransaction({
    deviceName: 'worker-lab-01',
    mint: async (name) => ({ id: 8, token: 'rta_new', name }),
    install: async () => {},
    verify: async () => 'pending',
    revoke: async (id) => { revoked.push(id) },
  })
  assert.equal(r.ok, true)
  assert.equal(r.pending, true)
  assert.deepEqual(revoked, [])
})

test('runOnboardTransaction：校验明确失败（failed）→ revoke 并抛出', async () => {
  const revoked = []
  await assert.rejects(
    runOnboardTransaction({
      deviceName: 'worker-lab-01',
      mint: async (name) => ({ id: 11, token: 'rta_new', name }),
      install: async () => {},
      verify: async () => 'failed',
      revoke: async (id) => { revoked.push(id) },
    }),
    /校验/,
  )
  assert.deepEqual(revoked, [11])
})

test('runOnboardTransaction：签发超时（结果未知）→ 按 name 回查并撤销孤儿凭据', async () => {
  const revoked = []
  const looked = []
  await assert.rejects(
    runOnboardTransaction({
      deviceName: 'worker-lab-01',
      mint: async () => {
        const e = new Error('This operation was aborted')
        e.name = 'AbortError'
        throw e
      },
      install: async () => {},
      verify: async () => 'online',
      revoke: async (id) => { revoked.push(id) },
      lookup: async (name) => { looked.push(name); return { id: 900, name } },
    }),
    /aborted/i,
  )
  assert.deepEqual(looked, ['worker-lab-01'])
  assert.deepEqual(revoked, [900])
})

test('runOnboardTransaction：签发明确失败（非超时）→ 不回查、不撤销（避免误撤同名他人凭据）', async () => {
  const revoked = []
  let lookups = 0
  await assert.rejects(
    runOnboardTransaction({
      deviceName: 'worker-lab-01',
      mint: async () => { throw new Error('签发凭据失败 HTTP 400: name exists') },
      install: async () => {},
      verify: async () => 'online',
      revoke: async (id) => { revoked.push(id) },
      lookup: async (name) => { lookups += 1; return { id: 901, name } },
    }),
    /HTTP 400/,
  )
  assert.equal(lookups, 0)
  assert.deepEqual(revoked, [])
})

// ── 静默拉起护栏（M3）───────────────────────────────────────────────────

test('shouldAutoStartWorker：已装未运行且未拦 → 允许一次，并记录时间（同一进程 5 分钟内最多 1 次）', () => {
  resetAutoStartState()
  const now = 1_700_000_000_000
  const first = shouldAutoStartWorker({ key: 'worker-lab-01', installed: true, running: false, readError: '', now })
  assert.equal(first.start, true)
  assert.equal(first.reason, 'ok')

  const second = shouldAutoStartWorker({ key: 'worker-lab-01', installed: true, running: false, readError: '', now: now + 1000 })
  assert.equal(second.start, false)
  assert.equal(second.reason, 'throttled')

  const third = shouldAutoStartWorker({ key: 'worker-lab-01', installed: true, running: false, readError: '', now: now + AUTO_START_THROTTLE_MS + 1 })
  assert.equal(third.start, true)
})

test('shouldAutoStartWorker：不同设备各自节流（互不影响）', () => {
  resetAutoStartState()
  const now = 1_700_000_000_000
  assert.equal(shouldAutoStartWorker({ key: 'dev-a', installed: true, running: false, readError: '', now }).start, true)
  assert.equal(shouldAutoStartWorker({ key: 'dev-b', installed: true, running: false, readError: '', now }).start, true)
})

test('shouldAutoStartWorker：凭据被吊销（退出码 42）→ 永久不拉起', () => {
  resetAutoStartState()
  const key = 'worker-lab-01'
  blockAutoStart(key, 'credential-revoked')
  const d = shouldAutoStartWorker({ key, installed: true, running: false, readError: '', now: Date.now() })
  assert.equal(d.start, false)
  assert.equal(d.reason, 'blocked:credential-revoked')
})

test('shouldAutoStartWorker：用户显式停止后本进程不再拉起', () => {
  resetAutoStartState()
  const key = 'worker-lab-01'
  blockAutoStart(key, 'user-stopped')
  const d = shouldAutoStartWorker({ key, installed: true, running: false, readError: '', now: Date.now() })
  assert.equal(d.start, false)
  assert.equal(d.reason, 'blocked:user-stopped')
})

test('shouldAutoStartWorker：运行中 / 未安装 / 读取失败都不拉起', () => {
  resetAutoStartState()
  const base = { key: 'worker-lab-01', now: 1_700_000_000_000 }
  assert.deepEqual(shouldAutoStartWorker({ ...base, installed: true, running: true, readError: '' }),
    { start: false, reason: 'running' })
  assert.deepEqual(shouldAutoStartWorker({ ...base, installed: false, running: false, readError: '' }),
    { start: false, reason: 'not-installed' })
  assert.deepEqual(shouldAutoStartWorker({ ...base, installed: false, running: false, readError: '读取失败' }),
    { start: false, reason: 'read-error' })
})

// ── 时区格式化（M4）────────────────────────────────────────────────────

test('formatTime：无 Z 的时间按 UTC 解析，再按目标时区渲染（UTC 07:07 → 北京 15:07）', () => {
  assert.equal(formatTime('2026-11-13T07:07:54', { locale: 'en-CA', timeZone: 'Asia/Shanghai' }), '2026-11-13 15:07:54')
  assert.equal(formatTime('2026-11-13T07:07:54Z', { locale: 'en-CA', timeZone: 'Asia/Shanghai' }), '2026-11-13 15:07:54')
  assert.equal(formatTime('2026-11-13T07:07:54+00:00', { locale: 'en-CA', timeZone: 'Asia/Shanghai' }), '2026-11-13 15:07:54')
})

test('formatTime：已带偏移按偏移解析，UTC 时区渲染不位移（不再按字符串截断）', () => {
  assert.equal(formatTime('2026-11-13T07:07:54.078089+00:00', { locale: 'en-CA', timeZone: 'UTC' }), '2026-11-13 07:07:54')
  assert.equal(formatTime('2026-11-13T07:07:54', { locale: 'en-CA', timeZone: 'UTC' }), '2026-11-13 07:07:54')
})

test('formatTime：空值 → 空串；无法解析 → 原样返回（不吞信息）', () => {
  assert.equal(formatTime('', { timeZone: 'UTC' }), '')
  assert.equal(formatTime(null), '')
  assert.equal(formatTime(undefined), '')
  assert.equal(formatTime('not-a-date', { timeZone: 'UTC' }), 'not-a-date')
})
// ── 服务端凭据匹配：同一 device_name 多行（Required #1 回归）────────────────

test('matchCredential：同一设备名多行时 active 优先（旧 revoked 行不得把状态机推到重建）', () => {
  const creds = [
    { id: 1, name: 'dsh-lab', status: 'revoked', device_name: 'lab-01' },
    { id: 2, name: 'dsh-lab-2', status: 'active', device_name: 'lab-01' },
    { id: 3, name: 'other', status: 'active', device_name: 'lab-02' },
  ]
  assert.equal(matchCredential(creds, 'lab-01')?.id, 2)
})

test('matchCredential：无 active 时返回首个匹配行；device_name 优先、name 兜底', () => {
  const creds = [
    { id: 5, name: 'dsh-lab', status: 'revoked', device_name: 'lab-01' },
    { id: 6, name: 'lab-02', status: 'active', device_name: '' },
  ]
  assert.equal(matchCredential(creds, 'lab-01')?.id, 5)
  assert.equal(matchCredential(creds, 'lab-02')?.id, 6)
  assert.equal(matchCredential(creds, ''), null)
})

test('readServerState：多凭据同行时取 active 那条（不再 filter[0] 误判）', async () => {
  const creds = [
    { id: 1, name: 'dsh-lab', status: 'revoked', device_name: 'lab-01' },
    { id: 2, name: 'dsh-lab-2', status: 'active', device_name: 'lab-01' },
  ]
  await withFetch(async (url) => {
    if (String(url).includes('/runtime-credentials')) return fakeResponse({ credentials: creds })
    return fakeResponse({ devices: [], total: 0 })
  }, async () => {
    const s = await readServerState({ baseUrl: 'https://api.example', token: 'grape_x' }, 'lab-01')
    assert.equal(s.credential?.id, 2)
    assert.equal(s.credential?.status, 'active')
  })
})

// ── 在线校验：必须按本次 created.id（Required #2 回归）────────────────────

test('verifyDeviceOnline：同名旧凭据行非 active 不得把本次新凭据判 failed', async () => {
  const list = async () => [{
    credential_id: 99, name: 'old', device_name: 'lab-01',
    credential_status: 'revoked', health: 'offline', last_seen_at: null,
  }]
  const state = await verifyDeviceOnline(
    { baseUrl: 'https://api.example', token: 'grape_x' }, 100, 'lab-01',
    { budgetMs: 30, intervalMs: 10, list },
  )
  assert.equal(state, 'pending')
})

test('verifyDeviceOnline：本次凭据 id 行 active+online → online；非 active → failed', async () => {
  const rows = (status, health) => async () => [{
    credential_id: 100, name: 'new', device_name: 'lab-01',
    credential_status: status, health, last_seen_at: null,
  }]
  const opts = { budgetMs: 200, intervalMs: 10 }
  assert.equal(await verifyDeviceOnline({ baseUrl: 'https://x', token: 't' }, 100, 'lab-01', { ...opts, list: rows('active', 'online') }), 'online')
  assert.equal(await verifyDeviceOnline({ baseUrl: 'https://x', token: 't' }, 100, 'lab-01', { ...opts, list: rows('revoked', 'offline') }), 'failed')
})

test('verifyDeviceOnline：没有本次凭据 id 的行 → pending（绝不因查不到而撤销）', async () => {
  const list = async () => []
  const state = await verifyDeviceOnline(
    { baseUrl: 'https://x', token: 't' }, 100, 'lab-01',
    { budgetMs: 30, intervalMs: 10, list },
  )
  assert.equal(state, 'pending')
})

// ── 设备列表分页 ────────────────────────────────────────────────────────

test('listServerDevices：按 total 翻页聚合，直到取满', async () => {
  const pages = []
  await withFetch(async (url) => {
    const u = new URL(String(url))
    const page = Number(u.searchParams.get('page'))
    pages.push(page)
    if (page === 1) {
      return fakeResponse({
        total: 3,
        devices: [
          { credential_id: 1, name: 'a', device_name: 'a', credential_status: 'active', health: 'online', last_seen_at: null },
          { credential_id: 2, name: 'b', device_name: 'b', credential_status: 'active', health: 'offline', last_seen_at: null },
        ],
      })
    }
    return fakeResponse({
      total: 3,
      devices: [{ credential_id: 3, name: 'c', device_name: 'c', credential_status: 'revoked', health: 'offline', last_seen_at: null }],
    })
  }, async () => {
    const rows = await listServerDevices({ baseUrl: 'https://api.example', token: 'grape_x' }, { pageSize: 2 })
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map((r) => r.credential_id), [1, 2, 3])
    assert.deepEqual(pages, [1, 2])
  })
})

test('listServerDevices：未配置 token / 请求失败 → 空数组（调用方按无法判定处理）', async () => {
  assert.deepEqual(await listServerDevices({ baseUrl: 'https://api.example' }), [])
  await withFetch(async () => fakeResponse({}, false, 500), async () => {
    assert.deepEqual(await listServerDevices({ baseUrl: 'https://api.example', token: 'grape_x' }), [])
  })
})

test('listCredentials：未配置 token / 请求失败 → 抛错（绝不返回 [] 掩盖无法判定）', async () => {
  await assert.rejects(listCredentials({ baseUrl: 'https://api.example' }), /未配置 token/)
  await withFetch(async () => fakeResponse({}, false, 500), async () => {
    await assert.rejects(
      listCredentials({ baseUrl: 'https://api.example', token: 'grape_x' }),
      /读取凭据失败 HTTP 500/,
    )
  })
})

test('readServerState：凭据列表读取失败 → unknown（不得当成无凭据）', async () => {
  await withFetch(async (url) => {
    if (String(url).includes('/runtime-credentials')) return fakeResponse({}, false, 500)
    return fakeResponse({ devices: [], total: 0 })
  }, async () => {
    const s = await readServerState({ baseUrl: 'https://api.example', token: 'grape_x' }, 'lab-01')
    assert.equal(s.unknown, true)
    assert.equal(s.credential, undefined)
  })
})

// ── 拉起路径（startLocalWorker）─────────────────────────────────────────

test('startLocalWorker：启动脚本不存在 → started=false 且 error 可读（Windows / POSIX）', () => {
  const win = workerLayout('win32', {}, 'C:\\Users\\me', null)
  const wr = startLocalWorker(win, 'win32')
  assert.equal(wr.started, false)
  assert.match(wr.error, /启动脚本不存在/)

  const posix = workerLayout('linux', {}, '/home/me', 1000)
  const pr = startLocalWorker(posix, 'linux')
  assert.equal(pr.started, false)
  assert.match(pr.error, /启动脚本不存在/)
})

test('startLocalWorker：POSIX 普通用户执行 start-worker.sh → started=true 且有 pid', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-dsh-start-test-'))
  try {
    const script = join(dir, 'start-worker.sh')
    writeFileSync(script, '#!/bin/sh\nexit 0\n')
    chmodSync(script, 0o755)
    const layout = { ...workerLayout('linux', {}, '/home/me', 1000), startScript: script }
    const r = startLocalWorker(layout, 'linux')
    assert.equal(r.started, true)
    assert.equal(r.error, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startLocalWorker：Windows 成功拉起 → powershell -File <startScript>（spawn 可注入，断言 argv）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-dsh-start-win-test-'))
  try {
    const script = join(dir, 'start-worker.ps1')
    writeFileSync(script, 'exit 0\n')
    const layout = { ...workerLayout('win32', {}, 'C:\\Users\\me', null), startScript: script }
    const calls = []
    const child = { pid: 4321, on() { return this }, unref() {} }
    const r = startLocalWorker(layout, 'win32', undefined, (bin, args, opts) => {
      calls.push({ bin, args, opts })
      return child
    })
    assert.equal(r.started, true)
    assert.equal(r.pid, 4321)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].bin, 'powershell.exe')
    assert.deepEqual(calls[0].args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script])
    assert.equal(calls[0].opts.shell, false)
    // Windows 上必须不 detached：powershell.exe 以 DETACHED_PROCESS 启动会 ~90ms 空转 exit 0
    // （2026-11-20 实测），表现为「点了启动但没有任何进程」。
    assert.equal(calls[0].opts.detached, false)
    assert.equal(calls[0].opts.stdio, 'ignore')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startLocalWorker：POSIX 普通用户仍以 detached 拉起 start-worker.sh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-dsh-start-posix-test-'))
  try {
    const script = join(dir, 'start-worker.sh')
    writeFileSync(script, '#!/bin/sh\nexit 0\n')
    chmodSync(script, 0o755)
    const layout = { ...workerLayout('linux', {}, '/home/me', 1000), startScript: script }
    const calls = []
    const child = { pid: 99, on() { return this }, unref() {} }
    const r = startLocalWorker(layout, 'linux', undefined, (bin, args, opts) => {
      calls.push({ bin, args, opts })
      return child
    })
    assert.equal(r.started, true)
    assert.equal(calls[0].bin, script)
    assert.equal(calls[0].opts.detached, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startLocalWorker：spawn 同步抛错 → started=false 且 error 可读（不再恒 true）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-dsh-start-fail-test-'))
  try {
    const script = join(dir, 'start-worker.sh')
    writeFileSync(script, '#!/bin/sh\nexit 0\n')
    chmodSync(script, 0o755)
    const layout = { ...workerLayout('linux', {}, '/home/me', 1000), startScript: script }
    const r = startLocalWorker(layout, 'linux', undefined, () => {
      throw new Error('spawn ENOENT')
    })
    assert.equal(r.started, false)
    assert.equal(r.pid, 0)
    assert.match(r.error, /spawn ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('startLocalWorker：spawn 未返回 pid → started=false；异步 error 回写同一结果', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-dsh-start-nopid-test-'))
  try {
    const script = join(dir, 'start-worker.sh')
    writeFileSync(script, '#!/bin/sh\nexit 0\n')
    chmodSync(script, 0o755)
    const layout = { ...workerLayout('linux', {}, '/home/me', 1000), startScript: script }
    const handlers = {}
    const child = { pid: undefined, on(ev, cb) { handlers[ev] = cb; return this }, unref() {} }
    const r = startLocalWorker(layout, 'linux', undefined, () => child)
    assert.equal(r.started, false)
    assert.equal(r.pid, 0)
    handlers.error(new Error('spawn ENOENT'))
    assert.equal(r.started, false)
    assert.match(r.error, /ENOENT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 进程主判据收紧 + 显式拉起记账（Minor 回归）──────────────────────────

test('isWorkerCommand：只认 python + worker 模块入口（旧 src.runtime.agent / 新 src.domains.runtime.engine.agent），日志/编辑器里出现该串不算', () => {
  assert.equal(isWorkerCommand('python3 -m src.runtime.agent --verbose'), true)
  assert.equal(isWorkerCommand('/usr/bin/python3.12 -m src.runtime.agent'), true)
  assert.equal(isWorkerCommand('C:\\py\\python.exe -m src.runtime.agent'), true)
  assert.equal(isWorkerCommand('"C:\\Program Files\\Python\\python.exe" -m src.runtime.agent'), true)
  assert.equal(isWorkerCommand('src.runtime.agent'), true)   // pgrep 兜底
  // 新布局（h-ed5f4e02adee 起）：worker 跑的是 src.domains.runtime.engine.agent
  assert.equal(isWorkerCommand('"C:\\Users\\u\\grape\\.venv\\Scripts\\python.exe" -m src.domains.runtime.engine.agent'), true)
  assert.equal(isWorkerCommand('/usr/bin/python3 -m src.domains.runtime.engine.agent'), true)
  assert.equal(isWorkerCommand('src.domains.runtime.engine.agent'), true)
  assert.equal(isWorkerCommand('vim src/runtime/agent.py'), false)
  assert.equal(isWorkerCommand('tail -f /var/log/src.runtime.agent.log'), false)
  assert.equal(isWorkerCommand('node build.js src.runtime.agent'), false)
  // 只是路径里带 domains 不算 worker
  assert.equal(isWorkerCommand('vim src/domains/runtime/engine/agent.py'), false)
})

test('recordAutoStart：显式拉起记账后 /ensure-worker 不会在节流窗口内再拉一次', () => {
  resetAutoStartState()
  const now = 1_700_000_000_000
  recordAutoStart('lab-01', now)
  const d = shouldAutoStartWorker({ key: 'lab-01', installed: true, running: false, readError: '', now: now + 1000 })
  assert.deepEqual(d, { start: false, reason: 'throttled' })
})

// ── helpers ─────────────────────────────────────────────────────────────

function fakeResponse(data, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}

async function withFetch(mock, fn) {
  const original = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('安装命令走 powershell -EncodedCommand 且必须异步执行（不得阻塞事件循环）', () => {
  const root = process.cwd()
  const cmdSrc = readFileSync(join(root, 'src/install-command.ts'), 'utf8')
  const idxSrc = readFileSync(join(root, 'src/index.ts'), 'utf8')
  assert.match(cmdSrc, /-EncodedCommand/, 'Windows 安装命令必须用 -EncodedCommand 交给 powershell.exe')
  assert.match(cmdSrc, /powershell\.exe/, '必须显式调用 powershell.exe')
  assert.match(cmdSrc, /\bspawn\(/, '安装必须用 spawn 异步执行')
  assert.doesNotMatch(cmdSrc, /execFileSync\s*\(/, '不得用 execFileSync 调用：同步执行会阻塞宿主事件循环（安装期间面板假死）')
  assert.match(cmdSrc, /macOS|dsh|'\/bin\/sh'/, '必须覆盖 macOS/Linux 的 /bin/sh -c 分支')
  assert.match(idxSrc, /await runWorkerInstallCommand\(installCmd/, 'index.ts 应 await 统一的 runWorkerInstallCommand')
})
