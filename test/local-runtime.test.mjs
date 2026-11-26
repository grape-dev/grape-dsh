/**
 * 本机运行时探测 / 安装布局 / 接管鉴权 的单元测试。
 *
 * 为什么跑 `lib/`：仓库零测试框架（无 jest/vitest 依赖），用 Node 内置 `node:test` 跑 tsc
 * 产物即可，`npm test` 先 build 再跑，不引入任何新依赖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTO_START_THROTTLE_MS,
  WORKER_STATE_ADVICE,
  autoStartStatus,
  buildWorkerStartRecord,
  classifyWorkerState,
  cleanupStaleTakeoverTokens,
  commandWrapper,
  evaluateStartGuard,
  findPython,
  grapeBinCandidates,
  grapeExecutable,
  installLayout,
  parseEnvText,
  parsePythonVersion,
  pythonLaunchers,
  pythonMissingMessage,
  pythonTooOldMessage,
  readLocalWorker,
  parseProcessList,
  collapseWorkerProcesses,
  recordAutoStart,
  removeTakeoverToken,
  resetAutoStartState,
  resolveApiAuth,
  resolveGrapeBin,
  runLocal,
  serverUrlMismatch,
  shouldAutoStartWorker,
  startLocalWorker,
  stopRuntimeAgent,
  workerLayout,
} from '../lib/local-runtime.js'
import { redactSensitiveText } from '../lib/repo-diagnostics.js'

/** 构造一条假探针结果 */
function fakeRun({ stdout = '', stderr = '', ok = true, status = 0, error = '', missing = false }) {
  return { ok, status, stdout, stderr, error, missing }
}

// ── /check 的底层：命令执行 ──────────────────────────────────────────────

test('runLocal：不存在的可执行文件 → ok:false + missing:true（/check 不得误报成功）', () => {
  const r = runLocal(join(tmpdir(), 'grape-dsh-definitely-missing-bin'), ['--version'])
  assert.equal(r.ok, false)
  assert.equal(r.missing, true)
})

test('runLocal：真实可执行文件（node --version）→ ok:true，证明数组传参不经 shell', () => {
  const r = runLocal(process.execPath, ['--version'])
  assert.equal(r.ok, true)
  assert.match(r.stdout.trim(), /^v\d+\.\d+\.\d+/)
})

test('runLocal：参数含空格 / 通配符也不会被 shell 解释（R1）', () => {
  const r = runLocal(process.execPath, ['-e', 'process.stdout.write("a b *")'])
  assert.equal(r.ok, true)
  assert.equal(r.stdout, 'a b *')
})

// ── Python 探测与版本校验 ───────────────────────────────────────────────

test('parsePythonVersion：解析常见输出', () => {
  assert.deepEqual(parsePythonVersion('Python 3.12.10'), { major: 3, minor: 12, micro: 10, text: '3.12.10' })
  assert.deepEqual(parsePythonVersion('3.9.18'), { major: 3, minor: 9, micro: 18, text: '3.9.18' })
  assert.equal(parsePythonVersion('garbage'), null)
})

test('pythonLaunchers：按平台排序（win32 先 py，类 Unix 先 python3）（R5）', () => {
  assert.deepEqual(pythonLaunchers('win32'), ['py', 'python', 'python3'])
  assert.equal(pythonLaunchers('linux')[0], 'python3')
  assert.equal(pythonLaunchers('darwin')[0], 'python3')
})

test('findPython：Python 3.9 → ok:false，文案指出「版本过低」而不是「未安装」', () => {
  const probe = () => fakeRun({ stdout: 'Python 3.9.18' })
  const py = findPython('linux', probe)
  assert.ok(py)
  assert.equal(py.ok, false)
  assert.equal(py.version, 'Python 3.9.18')
  const msg = pythonTooOldMessage(py)
  assert.match(msg, /版本过低/)
  assert.match(msg, /3\.10\+/)
  assert.doesNotMatch(msg, /未找到/)
})

test('findPython：3.9 之后命中 3.12 → 取可用版本而不是第一个（候选顺序不等于结论）', () => {
  const probe = (bin) => fakeRun({ stdout: bin === 'python3' ? 'Python 3.9.18' : 'Python 3.12.10' })
  const py = findPython('linux', probe)
  assert.ok(py)
  assert.equal(py.ok, true)
  assert.equal(py.bin, 'python')
  assert.equal(py.version, 'Python 3.12.10')
})

test('findPython：一个候选都没有 → null，文案说明「未找到」（不再谎称环境缺件）', () => {
  const probe = () => fakeRun({ ok: false, status: 1, error: 'spawnSync py ENOENT', missing: true })
  assert.equal(findPython('win32', probe), null)
  const msg = pythonMissingMessage('win32')
  assert.match(msg, /未找到/)
  assert.match(msg, /py \/ python \/ python3/)
})

// ── 安装布局（R4 / R7）──────────────────────────────────────────────────

test('installLayout：Windows 用 LOCALAPPDATA + Scripts\\ + pip.exe', () => {
  const win = installLayout('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me')
  assert.equal(win.platform, 'windows')
  assert.equal(win.installDir, 'C:\\Users\\me\\AppData\\Local\\grape-cli')
  assert.equal(win.venvPip, 'C:\\Users\\me\\AppData\\Local\\grape-cli\\.venv\\Scripts\\pip.exe')
  assert.equal(win.grapeBin, 'C:\\Users\\me\\AppData\\Local\\grape-cli\\.venv\\Scripts\\grape.exe')
  assert.equal(win.venvPython.endsWith('Scripts\\python.exe'), true)
  assert.equal(win.linkPath, '')
})

test('installLayout：Windows 无 LOCALAPPDATA 时回落到用户目录（不写死盘符）', () => {
  const win = installLayout('win32', {}, 'C:\\Users\\me')
  assert.equal(win.installDir, 'C:\\Users\\me\\AppData\\Local\\grape-cli')
})

test('installLayout：Linux 用 <root>/opt/grape-cli + bin/ + 软链', () => {
  const lin = installLayout('linux', {}, '/home/me')
  assert.equal(lin.platform, 'posix')
  assert.equal(lin.installDir, '/opt/grape-cli')
  assert.equal(lin.venvDir, '/opt/grape-cli/.venv')
  assert.equal(lin.venvPip, '/opt/grape-cli/.venv/bin/pip')
  assert.equal(lin.grapeBin, '/opt/grape-cli/.venv/bin/grape')
  assert.equal(lin.linkPath, '/usr/local/bin/grape')
})

test('grapeExecutable：可执行名按平台（R5）', () => {
  assert.equal(grapeExecutable('win32'), 'grape.exe')
  assert.equal(grapeExecutable('linux'), 'grape')
})

// ── 接管 token 清理 ─────────────────────────────────────────────────────

test('cleanupStaleTakeoverTokens：只删 grape-takeover-*.tok，其它文件不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-dsh-token-test-'))
  try {
    writeFileSync(join(dir, 'grape-takeover-1730000000000-42.tok'), 'secret')
    writeFileSync(join(dir, 'grape-takeover-notatoken.txt'), 'keep')
    writeFileSync(join(dir, 'other.tok'), 'keep')
    const removed = cleanupStaleTakeoverTokens(dir)
    assert.equal(removed, 1)
    assert.deepEqual(readdirSync(dir).sort(), ['grape-takeover-notatoken.txt', 'other.tok'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanupStaleTakeoverTokens：目录不存在时返回 0 且不抛（挂载路径必须容错）', () => {
  assert.equal(cleanupStaleTakeoverTokens(join(tmpdir(), 'grape-dsh-no-such-dir-xyz')), 0)
})

test('removeTakeoverToken：删掉工作区里的 .grape-takeover-token，其它文件保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-dsh-ws-token-'))
  try {
    writeFileSync(join(dir, '.grape-takeover-token'), 'tko_secret')
    writeFileSync(join(dir, '.grape-takeover-env.sh'), 'export X=1')
    const r = removeTakeoverToken(dir)
    assert.equal(r.removed, true)
    assert.equal(r.error, '')
    assert.deepEqual(readdirSync(dir), ['.grape-takeover-env.sh'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('removeTakeoverToken：文件已不存在也算成功（force），空 cwd 直接跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grape-dsh-ws-token-'))
  try {
    assert.equal(removeTakeoverToken(dir).removed, true)
    assert.deepEqual(removeTakeoverToken(''), { removed: false, error: '' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 接管鉴权（R9）───────────────────────────────────────────────────────

test('resolveApiAuth：无 token → error 明确「未配置 token」，token 为空（不发空 PRIVATE-TOKEN）', () => {
  const auth = resolveApiAuth({ baseUrl: 'https://www.grapedev.cn' })
  assert.equal(auth.token, '')
  assert.match(auth.error, /未配置 token/)
})

test('resolveApiAuth：baseUrl 与 token 都只认 config —— 环境变量一律不兜底（2026-11-20 环境隔离）', () => {
  const fromConfig = resolveApiAuth({ baseUrl: 'https://cfg.example/', token: 'grape_cfg' })
  assert.deepEqual({ baseUrl: fromConfig.baseUrl, token: fromConfig.token, error: fromConfig.error },
    { baseUrl: 'https://cfg.example', token: 'grape_cfg', error: '' })

  // 只给环境变量 → 视为未配置，绝不悄悄连到 env 里的环境、也不借 env 的令牌
  const prev = { base: process.env.GRAPE_BASE_URL, server: process.env.GRAPE_SERVER_URL, token: process.env.GRAPE_API_TOKEN }
  process.env.GRAPE_BASE_URL = 'https://env.example'
  process.env.GRAPE_SERVER_URL = 'https://env-server.example'
  process.env.GRAPE_API_TOKEN = 'grape_env'
  try {
    const envOnly = resolveApiAuth({})
    assert.equal(envOnly.baseUrl, '')
    assert.equal(envOnly.token, '')
    assert.match(envOnly.error, /未配置 baseUrl/)
  }
  finally {
    if (prev.base === undefined) delete process.env.GRAPE_BASE_URL
    else process.env.GRAPE_BASE_URL = prev.base
    if (prev.server === undefined) delete process.env.GRAPE_SERVER_URL
    else process.env.GRAPE_SERVER_URL = prev.server
    if (prev.token === undefined) delete process.env.GRAPE_API_TOKEN
    else process.env.GRAPE_API_TOKEN = prev.token
  }
})

test('serverUrlMismatch：同一环境（仅斜杠/大小写/默认端口差异）不算不一致；不同环境一律不一致', () => {
  assert.equal(serverUrlMismatch('https://Beta.example:9443/', 'https://beta.example:9443'), false)
  assert.equal(serverUrlMismatch('https://x.example:443', 'https://x.example'), false)
  assert.equal(serverUrlMismatch('http://x.example:80/', 'http://x.example'), false)
  assert.equal(serverUrlMismatch('https://grape-dev.topxtopx.com', 'https://beta.grapedev.cn:9443'), true)
  assert.equal(serverUrlMismatch('', 'https://beta.grapedev.cn:9443'), true)
  // 配置缺失时不做误判（由 resolveApiAuth 报配置错误）
  assert.equal(serverUrlMismatch('https://x.example', ''), false)
})

test('resolveApiAuth：无 baseUrl → 明确报「未配置 baseUrl」，不回落 localhost', () => {
  const auth = resolveApiAuth({ token: 'grape_x' })
  assert.match(auth.error, /未配置 baseUrl/)
  assert.equal(auth.baseUrl, '')
})

// ── 服务管理平台分支（R6）──────────────────────────────────────────────

test('stopRuntimeAgent：Windows 走 sc.exe，失败再兜底 Stop-Service', () => {
  const calls = []
  const probe = (bin, args) => {
    calls.push([bin, ...args])
    return bin === 'sc.exe' ? fakeRun({ ok: false, status: 1 }) : fakeRun({})
  }
  const r = stopRuntimeAgent('win32', probe)
  assert.equal(r.ok, true)
  assert.equal(calls[0][0], 'sc.exe')
  assert.equal(calls[1][0], 'powershell.exe')
  assert.ok(calls[1].some((x) => String(x).includes('Stop-Service')))
})

test('stopRuntimeAgent：Linux 走 systemctl，且不触碰 sc/Stop-Service', () => {
  const calls = []
  const r = stopRuntimeAgent('linux', (bin, args) => {
    calls.push([bin, ...args])
    return fakeRun({})
  })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'systemctl')
  assert.deepEqual(calls[0].slice(1), ['stop', 'runtime-agent.service'])
})

// ── grape CLI 定位（本机 worker 展示：设备解析 / CLI 定位）──────────────────

test('commandWrapper：Windows 的 .cmd/.bat 走 cmd.exe /c，其它一律原样启动', () => {
  const win = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  assert.deepEqual(commandWrapper('C:\\tools\\grape.cmd', 'win32', win), {
    bin: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/c', 'C:\\tools\\grape.cmd'],
  })
  assert.deepEqual(commandWrapper('C:\\tools\\grape.BAT', 'win32', win).args, ['/c', 'C:\\tools\\grape.BAT'])
  // 真 exe 不需要包装（否则参数会被 cmd 再解释一遍）
  assert.deepEqual(commandWrapper('C:\\tools\\grape.exe', 'win32', win), { bin: 'C:\\tools\\grape.exe', args: [] })
  assert.deepEqual(commandWrapper('/usr/local/bin/grape', 'linux', {}), { bin: '/usr/local/bin/grape', args: [] })
})

test('grapeBinCandidates：同时给出插件安装器与 worker 安装脚本的路径，且按平台构造', () => {
  const win = grapeBinCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u')
  assert.ok(win.some((c) => c.source === 'plugin-install' && c.bin.endsWith('grape.exe')))
  assert.ok(win.some((c) => c.source === 'worker-install' && c.bin.includes('grape\\.venv\\Scripts\\grape.exe')))
  const posix = grapeBinCandidates('linux', {}, '/home/u')
  assert.ok(posix.every((c) => !c.bin.includes('\\')))
  assert.ok(posix.some((c) => c.source === 'worker-install' && c.bin.endsWith('/grape')))
})

test('resolveGrapeBin：显式 config 最优先（即使探不通也照用，便于报错指出该路径）', () => {
  const r = resolveGrapeBin({
    configured: 'D:\\custom\\grape.exe',
    envValue: 'D:\\env\\grape.exe',
    installed: 'D:\\session\\grape.exe',
    platform: 'win32',
    exists: () => true,
    probe: () => false,
  })
  assert.equal(r.bin, 'D:\\custom\\grape.exe')
  assert.equal(r.source, 'config')
})

test('resolveGrapeBin：没有 config 时 env→会话内→安装目录→PATH 逐层回退', () => {
  const env = resolveGrapeBin({
    envValue: 'D:\\env\\grape.exe',
    platform: 'win32',
    exists: () => true,
    probe: () => true,
  })
  assert.equal(env.source, 'env')

  // 会话内刚装好（宿主重启前）——不依赖 PATH
  const session = resolveGrapeBin({
    installed: 'C:\\tmp\\venv\\Scripts\\grape.exe',
    platform: 'win32',
    exists: () => false,
    probe: (bin) => bin === 'C:\\tmp\\venv\\Scripts\\grape.exe',
  })
  assert.equal(session.source, 'installed')

  // 重启后：PATH 没有它，但插件安装目录里在 → 必须还能找到（本次「解析失败」的根因）
  const installedOnDisk = 'C:\\Users\\u\\AppData\\Local\\grape-cli\\.venv\\Scripts\\grape.exe'
  const disk = resolveGrapeBin({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    home: 'C:\\Users\\u',
    exists: (p) => p === installedOnDisk,
    probe: (bin) => bin === installedOnDisk,
  })
  assert.equal(disk.bin, installedOnDisk)
  assert.equal(disk.source, 'plugin-install')

  // 只有 PATH 里有
  const path = resolveGrapeBin({
    platform: 'linux',
    home: '/home/u',
    exists: () => false,
    probe: (bin) => bin === 'grape',
  })
  assert.equal(path.bin, 'grape')
  assert.equal(path.source, 'PATH')

  // PATH 与安装目录都有 → 托管副本优先（系统 Python 里 pip 装的那份可能是旧版）
  const both = resolveGrapeBin({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    home: 'C:\\Users\\u',
    exists: () => true,
    probe: () => true,
  })
  assert.equal(both.source, 'plugin-install')
  assert.ok(both.bin.endsWith('grape.exe'))

  // 都没有：给出平台可执行名 + 完整的尝试清单
  const missing = resolveGrapeBin({ platform: 'linux', home: '/home/u', exists: () => false, probe: () => false })
  assert.equal(missing.source, 'missing')
  assert.equal(missing.bin, 'grape')
  assert.ok(missing.tried.includes('grape'))
})

test('parseEnvText：BOM / export / 引号 / 行尾注释 / 值里带 = 都能正确解析', () => {
  const env = parseEnvText([
    '\uFEFFRUNTIME_TOKEN="rta_abc=def=="',
    'export RUNTIME_SERVER_URL=https://www.grapedev.cn  # 主控地址',
    "RUNTIME_DEVICE_NAME='dsh-ecs-grape-dev-changhui'",
    'set RUNTIME_MAX_CONCURRENT_TASKS=20',
    '$env:RUNTIME_POLL_INTERVAL=3',
    '# 注释行',
    'INVALID LINE',
    '',
  ].join('\r\n'))
  assert.equal(env.RUNTIME_TOKEN, 'rta_abc=def==')
  assert.equal(env.RUNTIME_SERVER_URL, 'https://www.grapedev.cn')
  assert.equal(env.RUNTIME_DEVICE_NAME, 'dsh-ecs-grape-dev-changhui')
  assert.equal(env.RUNTIME_MAX_CONCURRENT_TASKS, '20')
  assert.equal(env.RUNTIME_POLL_INTERVAL, '3')
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'INVALID LINE'), false)
})

test('parseEnvText：修改时间/空串不抛错', () => {
  assert.deepEqual(parseEnvText(''), {})
  assert.deepEqual(parseEnvText(undefined), {})
})

// ── Issue #25：Worker 状态机与探测容错 ────────────────────────────────────

/** 构造「文件不存在」错误（与 node fs 一致：code=ENOENT） */
function enoent(path) {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`)
  err.code = 'ENOENT'
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

const ENV_TEXT = [
  'RUNTIME_TOKEN=rta_seedvalue',
  'RUNTIME_SERVER_URL=https://www.grapedev.cn',
  'RUNTIME_DEVICE_NAME=dsh-ecs-grape-dev-changhui',
  'RUNTIME_HEARTBEAT_INTERVAL=15',
  '',
].join('\n')

test('状态机（探测不可用/超时）：探测失败 → probe-failed，不判「未运行」、不拉起', () => {
  const layout = workerLayout('linux', {}, '/home/me', 1000)
  const facts = readLocalWorker({
    platform: 'linux', env: {}, home: '/home/me', uid: 1000,
    ...fakeFs({ [layout.envFile]: ENV_TEXT }),
    probe: () => fakeRun({
      ok: false, status: null, error: 'spawnSync powershell.exe ETIMEDOUT', missing: false,
      stderr: '',
    }),
  })
  // 探测失败不得折叠成「没有进程」
  assert.equal(facts.running, false)
  assert.equal(facts.probe.ok, false)
  assert.equal(facts.probeFailed, true)
  assert.match(facts.probe.error, /ETIMEDOUT/)

  const c = classifyWorkerState({
    local: facts,
    server: { device_name: 'dsh-ecs-grape-dev-changhui', health: 'offline', last_seen_at: '2026-11-19T00:00:00Z' },
    probe: { failed: true, method: facts.probe.method, ok: false },
    now: Date.parse('2026-11-19T06:50:00Z'),
  })
  assert.equal(c.state, 'probe-failed')
  assert.equal(c.canAutoStart, false)
  assert.match(c.advice, /探测/)
  assert.equal(shouldAutoStartWorker({
    key: 'probe-lab', installed: true, running: false, probeFailed: true,
  }).start, false)
  assert.equal(evaluateStartGuard(facts), 'probe-failed')
})

test('状态机（双进程并存）：venv + 非 venv 解释器同时命中 → running=true 且拒绝再次拉起', () => {
  const facts = readLocalWorker({
    platform: 'win32', env: {}, home: 'C:\\Users\\u', uid: null,
    ...fakeFs({ [workerLayout('win32', {}, 'C:\\Users\\u', null).envFile]: ENV_TEXT }),
    listProcesses: () => [
      { pid: 8264, command: 'C:\\Users\\u\\grape\\.venv\\Scripts\\python.exe -m src.runtime.agent' },
      { pid: 7012, command: 'C:\\Program Files\\Python312\\python.exe -m src.runtime.agent' },
    ],
  })
  assert.equal(facts.running, true)
  assert.equal(facts.processes.length, 2)
  assert.deepEqual(facts.processes.map((p) => p.pid).sort((a, b) => a - b), [7012, 8264])

  const c = classifyWorkerState({
    local: facts,
    server: { health: 'offline', last_seen_at: '2026-11-19T00:00:00Z' },
    now: Date.parse('2026-11-19T06:50:00Z'),
  })
  assert.equal(c.state, 'started-waiting-heartbeat')
  assert.equal(c.canAutoStart, false)
  // 护栏：任一存活 agent 进程（含子进程/非 venv 解释器）都禁止再拉
  assert.equal(evaluateStartGuard(facts), 'process-alive')
  const d = shouldAutoStartWorker({
    key: 'dual-proc', installed: true, running: false, survivingProcesses: facts.processes.length,
  })
  assert.equal(d.start, false)
  assert.equal(d.reason, 'process-alive')
})

test('状态机（凭据非 active）：凭据 revoked → credential-inactive，提示重新接入', () => {
  const c = classifyWorkerState({
    local: {
      installed: true, running: false, deviceName: 'dev-a', serverUrl: 'https://x.example',
      readError: '', source: 'runtime-env', heartbeatIntervalSec: 15, probeFailed: false, processes: [],
    },
    server: { device_name: 'dev-a', health: 'offline', last_seen_at: '2026-11-18T00:00:00Z', credential_status: 'revoked' },
    now: Date.parse('2026-11-19T06:50:00Z'),
  })
  assert.equal(c.state, 'credential-inactive')
  assert.equal(c.canAutoStart, false)
  assert.match(c.advice, /重新接入/)
})

test('状态机（服务端 online 但本地探测失败）：判定为「探测不可用 / 服务端在线」，不拉起', () => {
  const now = Date.parse('2026-11-19T06:50:00Z')
  const c = classifyWorkerState({
    local: {
      installed: true, running: false, deviceName: 'dev-a', serverUrl: 'https://x.example',
      readError: '', source: 'runtime-env', heartbeatIntervalSec: 15, probeFailed: true, processes: [],
    },
    server: {
      device_name: 'dev-a', health: 'online', last_seen_at: new Date(now - 5000).toISOString(),
      credential_status: 'active', worker_version: 'h-1',
    },
    probe: { failed: true, method: 'powershell', ok: false },
    now,
  })
  assert.equal(c.state, 'server-online-probe-failed')
  assert.equal(c.canAutoStart, false)
  assert.match(c.advice, /服务端显示在线/)
  assert.match(c.basis.join('\n'), /探测不可用/)

  // 探测成功但没枚举到进程：以服务端心跳为准，同样不拉起
  const noLocal = classifyWorkerState({
    local: {
      installed: true, running: false, deviceName: 'dev-a', serverUrl: 'https://x.example',
      readError: '', source: 'runtime-env', heartbeatIntervalSec: 15, probeFailed: false, processes: [],
    },
    server: { device_name: 'dev-a', health: 'online', last_seen_at: new Date(now - 5000).toISOString() },
    probe: { failed: false, method: 'ps', ok: true },
    now,
  })
  assert.equal(noLocal.state, 'server-online-no-local-process')
  assert.equal(noLocal.canAutoStart, false)

  // 2×heartbeat 窗口外则不算在线
  const stale = classifyWorkerState({
    local: {
      installed: true, running: false, deviceName: 'dev-a', serverUrl: 'https://x.example',
      readError: '', source: 'runtime-env', heartbeatIntervalSec: 15, probeFailed: false, processes: [],
    },
    server: { device_name: 'dev-a', health: 'online', last_seen_at: new Date(now - 31000).toISOString() },
    probe: { failed: false, method: 'ps', ok: true },
    now,
  })
  assert.notEqual(stale.state, 'server-online-probe-failed')
})

test('状态机（节流窗口重复触发）：recordAutoStart 后 5 分钟内不再拉起', () => {
  resetAutoStartState()
  const now = Date.parse('2026-11-19T06:50:00Z')
  recordAutoStart('throttle-lab', now)
  const status = autoStartStatus('throttle-lab', now + 1000)
  assert.equal(status.throttled, true)
  assert.equal(status.lastStartAt, now)

  const d = shouldAutoStartWorker({
    key: 'throttle-lab', installed: true, running: false, now: now + 1000,
  })
  assert.equal(d.start, false)
  assert.equal(d.reason, 'throttled')

  const c = classifyWorkerState({
    local: {
      installed: true, running: false, deviceName: 'throttle-lab', serverUrl: 'https://x.example',
      readError: '', source: 'runtime-env', heartbeatIntervalSec: 15, probeFailed: false, processes: [],
    },
    server: null,
    throttle: { blocked: null, lastStartAt: now },
    now: now + 1000,
  })
  assert.equal(c.state, 'autostart-throttled')
  assert.equal(c.canAutoStart, false)

  // 窗口过后恢复可拉起
  const later = shouldAutoStartWorker({
    key: 'throttle-lab', installed: true, running: false, now: now + AUTO_START_THROTTLE_MS + 1,
  })
  assert.equal(later.start, true)
  resetAutoStartState()
})

test('状态机（拉起失败回写）：pid/退出码/错误/stderr 摘要与拉起后核对差异都写进记录', () => {
  const now = Date.parse('2026-11-19T06:50:00Z')
  const failed = { started: false, error: '启动脚本不存在：C:\\Users\\u\\grape\\start-worker.ps1', pid: 0 }
  const rec = buildWorkerStartRecord({
    started: failed,
    now,
    expected: { deviceName: 'dev-a', serverUrl: 'https://x.example' },
    actual: { deviceName: 'dev-b', serverUrl: 'https://y.example', tokenPresent: false },
    probe: { ok: false, stderrLines: ['Access is denied.', 'powershell exit 1'] },
  })
  assert.equal(rec.pid, 0)
  assert.equal(rec.exitCode, null)
  assert.match(rec.error, /启动脚本不存在/)
  assert.ok(rec.stderrLines.length >= 2)
  assert.equal(rec.verifyState, 'mismatch')
  assert.match(rec.verifyDetail, /device_name/)
  assert.match(rec.verifyDetail, /RUNTIME_TOKEN/)
  assert.equal(rec.at, new Date(now).toISOString())

  // 真实 startLocalWorker 拉起失败（脚本不存在）也必须可回写
  const layout = workerLayout('win32', {}, 'C:\\Users\\u', null)
  const real = startLocalWorker(layout, 'win32')
  assert.equal(real.started, false)
  const rec2 = buildWorkerStartRecord({ started: real, now })
  assert.match(rec2.error, /启动脚本不存在/)
  assert.equal(rec2.verifyState, 'unverified')
})

test('状态机：9+ 态齐全，每态都有可操作建议（禁止折叠成布尔）', () => {
  const states = Object.keys(WORKER_STATE_ADVICE)
  assert.ok(states.length >= 9, `状态数 ${states.length} < 9`)
  for (const state of states) {
    assert.equal(typeof WORKER_STATE_ADVICE[state], 'string')
    assert.ok(WORKER_STATE_ADVICE[state].trim().length > 0, `${state} 缺少建议`)
  }
  for (const required of [
    'not-installed', 'installed-stopped', 'started-waiting-heartbeat',
    'server-online-probe-failed', 'server-online-no-local-process', 'identity-mismatch',
    'credential-inactive', 'probe-failed', 'autostart-throttled', 'autostart-blocked', 'read-error',
  ]) {
    assert.ok(states.includes(required), `缺少状态 ${required}`)
  }
})

test('状态机：同一环境内设备名不一致 → identity-mismatch', () => {
  const c = classifyWorkerState({
    local: {
      installed: true, running: true, deviceName: 'dev-a', serverUrl: 'https://same.example',
      readError: '', source: 'runtime-env', heartbeatIntervalSec: 15, probeFailed: false,
      processes: [{ pid: 9, command: 'python -m src.runtime.agent' }],
    },
    server: { device_name: 'dev-b', health: 'offline', last_seen_at: null },
    expected: { serverUrl: 'https://same.example' },
    now: Date.now(),
  })
  assert.equal(c.state, 'identity-mismatch')
  assert.equal(c.canAutoStart, false)
  assert.match(c.basis.join('\n'), /设备名不一致/)
})

test('脱敏：诊断文本不泄露 RUNTIME_TOKEN / tk_ / grape_ / tko_ / rta_ 值', () => {
  const text = [
    'RUNTIME_TOKEN=rta_seedvalue',
    'Authorization: Bearer abcdefg',
    'api_key=grape_abcdef',
    'head=tko_abcdef1234',
    'tk_abcdef1234',
  ].join('\n')
  const red = redactSensitiveText(text)
  assert.doesNotMatch(red, /rta_seedvalue/)
  assert.doesNotMatch(red, /abcdefg/)
  assert.doesNotMatch(red, /grape_abcdef/)
  assert.doesNotMatch(red, /tko_abcdef1234/)
  assert.doesNotMatch(red, /tk_abcdef1234/)
  assert.match(red, /\[已脱敏\]/)
})
test('进程解析：pid ppid command 三列 + 父子合并（Issue #25）', () => {
  const text = [
    ' 8264 10164 "C:/x/.venv/Scripts/python.exe" -m src.runtime.agent',
    ' 7012 8264 "C:/Program Files/Python312/python.exe" -m src.runtime.agent',
  ].join(String.fromCharCode(10))
  const list = parseProcessList(text)
  assert.equal(list.length, 2)
  assert.equal(list[0].ppid, 10164)
  assert.equal(list[1].ppid, 8264)
  const merged = collapseWorkerProcesses(list)
  assert.equal(merged.length, 1, '同一 worker 的 launcher + 解释器应合并为一条')
  assert.equal(merged[0].pid, 8264, '保留父进程，剔除它的子进程')

  // 老格式（两列）仍然可解析，且不会被当成父子
  const old2 = parseProcessList(' 100 /usr/bin/python -m src.runtime.agent')
  assert.equal(old2.length, 1)
  assert.equal(old2[0].ppid, undefined)
  assert.equal(collapseWorkerProcesses(old2).length, 1)
})
