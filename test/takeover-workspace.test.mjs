import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  derivedTail,
  isFullyQualifiedPath,
  localizeRestoredCwd,
  localizeTakeoverCwd,
  resolveTakeoverRoot,
  sanitizeSegment,
  tailAfterWorkspaceRoot,
} from '../lib/takeover-workspace.js'

// 平台真实返回值（2026-11-18 抓到的 bundle.workspace.cwd_hint）
const REMOTE = '/root/grape-workspaces/gitcode/developer_ch/takeover-ch/issues/1/vod'
const WIN_ROOT = 'C:\\Users\\someone\\grape-workspaces'
const POSIX_ROOT = '/home/someone/grape-workspaces'

test('win32：远端 Linux 路径映射到本机根，且是带盘符的完全限定路径', () => {
  const r = localizeTakeoverCwd({
    remoteCwd: REMOTE,
    repo: 'developer_ch/takeover-ch',
    issueNumber: '1',
    agentType: 'vod',
    root: WIN_ROOT,
    platform: 'win32',
    exists: () => false, // 远端路径在本机当然不存在
  })
  assert.equal(r.source, 'mapped')
  assert.equal(r.cwd, 'C:\\Users\\someone\\grape-workspaces\\gitcode\\developer_ch\\takeover-ch\\issues\\1\\vod')
  assert.ok(isFullyQualifiedPath(r.cwd, 'win32'))
  assert.match(r.note, /远端路径/)
})

test('win32：没有盘符的 /root/... 即使 exists 为真也不算本机目录', () => {
  const r = localizeTakeoverCwd({
    remoteCwd: REMOTE,
    repo: 'developer_ch/takeover-ch',
    issueNumber: '1',
    agentType: 'vod',
    root: WIN_ROOT,
    platform: 'win32',
    exists: () => true, // 故意返回存在，验证「完全限定」判断优先
  })
  assert.equal(r.source, 'mapped')
  assert.ok(r.cwd.startsWith('C:\\Users\\someone\\grape-workspaces\\'))
})

test('posix：同一台机器上的任务目录直接复用（不搬家）', () => {
  const r = localizeTakeoverCwd({
    remoteCwd: REMOTE,
    repo: 'developer_ch/takeover-ch',
    issueNumber: '1',
    agentType: 'vod',
    root: POSIX_ROOT,
    platform: 'linux',
    exists: (p) => p === REMOTE,
  })
  assert.equal(r.source, 'local')
  assert.equal(r.cwd, REMOTE)
})

test('posix：远端路径本机不存在 → 映射到本机根', () => {
  const r = localizeTakeoverCwd({
    remoteCwd: REMOTE,
    repo: 'developer_ch/takeover-ch',
    issueNumber: '1',
    agentType: 'vod',
    root: POSIX_ROOT,
    platform: 'linux',
    exists: () => false,
  })
  assert.equal(r.source, 'mapped')
  assert.equal(r.cwd, `${POSIX_ROOT}/gitcode/developer_ch/takeover-ch/issues/1/vod`)
})

test('win32：已有的盘符路径直接复用', () => {
  const local = 'D:\\work\\takeover-ch\\issues\\1\\vod'
  const r = localizeTakeoverCwd({
    remoteCwd: local,
    repo: 'developer_ch/takeover-ch',
    issueNumber: '1',
    agentType: 'vod',
    root: WIN_ROOT,
    platform: 'win32',
    exists: (p) => p === local,
  })
  assert.equal(r.source, 'local')
  assert.equal(r.cwd, local)
})

test('远端没有 cwd → 按仓库/Issue/agent 生成（derived）', () => {
  const r = localizeTakeoverCwd({
    remoteCwd: '',
    repo: 'grape-dev/grape-dsh',
    issueNumber: '#15',
    agentType: 'qa',
    root: POSIX_ROOT,
    platform: 'linux',
    exists: () => false,
  })
  assert.equal(r.source, 'derived')
  assert.equal(r.cwd, `${POSIX_ROOT}/grape-dev/grape-dsh/issues/15/qa`)
})

test('远端路径不含 grape-workspaces 标记 → 也走 derived，不把远端结构搬进来', () => {
  const r = localizeTakeoverCwd({
    remoteCwd: '/opt/ci/build/agent-7',
    repo: 'o/r',
    issueNumber: '3',
    agentType: 'coding',
    root: POSIX_ROOT,
    platform: 'linux',
    exists: () => false,
  })
  assert.equal(r.source, 'derived')
  assert.equal(r.cwd, `${POSIX_ROOT}/o/r/issues/3/coding`)
})

test('尾部结构不写死层数：多一层平台前缀照样保住', () => {
  assert.equal(
    tailAfterWorkspaceRoot('/srv/grape-workspaces/gitcode/owner/repo/issues/9/qa'),
    'gitcode/owner/repo/issues/9/qa',
  )
  assert.equal(
    tailAfterWorkspaceRoot('/srv/grape-workspaces/owner/repo/issues/9/qa'),
    'owner/repo/issues/9/qa',
  )
  assert.equal(tailAfterWorkspaceRoot('/srv/grape-workspaces'), '')
  assert.equal(tailAfterWorkspaceRoot(''), '')
})

test('非法字符与 .. 被清洗，不会逃出本地根', () => {
  const r = localizeTakeoverCwd({
    remoteCwd: '/x/grape-workspaces/o/r/issues/1/../..',
    repo: 'o/r',
    issueNumber: '1',
    agentType: 'vod',
    root: POSIX_ROOT,
    platform: 'linux',
    exists: () => false,
  })
  assert.ok(!r.cwd.includes('..'), r.cwd)
  assert.ok(r.cwd.startsWith(`${POSIX_ROOT}/`), r.cwd)

  assert.equal(sanitizeSegment('co:ding'), 'co_ding')
  assert.equal(sanitizeSegment('vod.'), 'vod')
  assert.equal(sanitizeSegment('..'), '')
  assert.equal(sanitizeSegment('  '), '')
  assert.equal(derivedTail('o/r', '#12', 'co:ding'), 'o/r/issues/12/co_ding')
})

test('根目录带尾部分隔符不会拼出双分隔符', () => {
  const win = localizeTakeoverCwd({
    remoteCwd: REMOTE,
    repo: 'o/r',
    issueNumber: '1',
    agentType: 'vod',
    root: WIN_ROOT + '\\',
    platform: 'win32',
    exists: () => false,
  })
  assert.ok(!win.cwd.includes('\\\\'), win.cwd)

  const posix = localizeTakeoverCwd({
    remoteCwd: REMOTE,
    repo: 'o/r',
    issueNumber: '1',
    agentType: 'vod',
    root: POSIX_ROOT + '/',
    platform: 'linux',
    exists: () => false,
  })
  assert.ok(!posix.cwd.includes('//'), posix.cwd)
})

test('根目录拿不到 → 返回空 cwd 并给出原因（调用方转成错误）', () => {
  const r = localizeTakeoverCwd({
    remoteCwd: REMOTE,
    repo: 'o/r',
    issueNumber: '1',
    agentType: 'vod',
    root: '',
    platform: 'linux',
    exists: () => false,
  })
  assert.equal(r.cwd, '')
  assert.match(r.note, /工作区根/)
})

test('resolveTakeoverRoot：环境变量优先、必须是完全限定路径，否则回落到主目录', () => {
  assert.equal(
    resolveTakeoverRoot({ env: { GRAPE_TAKEOVER_WORKSPACE_ROOT: 'D:\\ws' }, home: 'C:\\Users\\u', platform: 'win32' }),
    'D:\\ws',
  )
  // 非完全限定的配置被忽略（Windows 上没有盘符的 /ws）
  assert.equal(
    resolveTakeoverRoot({ env: { GRAPE_TAKEOVER_WORKSPACE_ROOT: '/ws' }, home: 'C:\\Users\\u', platform: 'win32' }),
    'C:\\Users\\u\\grape-workspaces',
  )
  assert.equal(
    resolveTakeoverRoot({ env: {}, home: '/home/u', platform: 'linux' }),
    '/home/u/grape-workspaces',
  )
  assert.equal(resolveTakeoverRoot({ env: {}, home: '', platform: 'linux' }), '')
})

test('isFullyQualifiedPath：按平台口径判断', () => {
  assert.equal(isFullyQualifiedPath('C:\\x', 'win32'), true)
  assert.equal(isFullyQualifiedPath('c:/x', 'win32'), true)
  assert.equal(isFullyQualifiedPath('\\\\srv\\share\\x', 'win32'), true)
  assert.equal(isFullyQualifiedPath('/root/x', 'win32'), false)
  assert.equal(isFullyQualifiedPath('', 'win32'), false)
  assert.equal(isFullyQualifiedPath('/root/x', 'linux'), true)
  assert.equal(isFullyQualifiedPath('C:\\x', 'linux'), false)
})

// ── 宿主重启后从平台 cwd_hint 恢复：不猜 derived（Issue #18 复审 R2） ──

test('localizeRestoredCwd：win32 远端 Linux 路径照样映射（不依赖 repo/issue/agent）', () => {
  const r = localizeRestoredCwd({
    remoteCwd: REMOTE,
    root: WIN_ROOT,
    platform: 'win32',
    exists: () => false,
  })
  assert.equal(r.source, 'mapped')
  assert.equal(r.cwd, 'C:\\Users\\someone\\grape-workspaces\\gitcode\\developer_ch\\takeover-ch\\issues\\1\\vod')
})

test('localizeRestoredCwd：本机已存在的路径原样复用', () => {
  const local = 'C:\\work\\takeover\\issues\\2\\qa'
  const r = localizeRestoredCwd({
    remoteCwd: local,
    root: WIN_ROOT,
    platform: 'win32',
    exists: (p) => p === local,
  })
  assert.equal(r.source, 'local')
  assert.equal(r.cwd, local)
})

test('localizeRestoredCwd：没有 grape-workspaces 尾部时不猜（返回空，不出 issues/0/agent）', () => {
  const r = localizeRestoredCwd({
    remoteCwd: '/opt/ci/build/agent-7',
    root: POSIX_ROOT,
    platform: 'linux',
    exists: () => false,
  })
  assert.equal(r.cwd, '')
  assert.equal(r.source, '')
})

test('localizeRestoredCwd：远端路径为空也返回空（调用方降级，不建目录）', () => {
  const r = localizeRestoredCwd({ remoteCwd: '', root: POSIX_ROOT, platform: 'linux' })
  assert.equal(r.cwd, '')
  assert.equal(r.source, '')
})
