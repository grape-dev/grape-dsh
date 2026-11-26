/**
 * 安全加固回归测试（issue #33 的安全扫描发现）：
 *   ① install 命令拼接的 shell 注入面
 *   ② 执行时 token 出现在进程命令行
 *   ③ 服务端下发的脚本名 / 技能名越出工作目录
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  INSTALL_TOKEN_ENV,
  psQuote,
  safeBaseUrl,
  safeDevice,
  safeToken,
  shQuote,
  workerInstallCommand,
  workerInstallCommandWithEnv,
} from '../lib/install-command.js'
import { safeScriptPath, writeTakeoverScripts } from '../lib/script-writer.js'

const WIN = { isWindows: true }
const POSIX = { isWindows: false }

test('baseUrl：拒绝 shell 注入、非 http(s)、带凭据的值', () => {
  const bad = [
    'http://h.example"; rm -rf ~ #',
    'http://h.example; id',
    'http://h.example`id`',
    'ftp://h.example',
    'javascript:alert(1)',
    'http://user:pass@h.example',
    '',
  ]
  for (const value of bad) {
    assert.throws(() => safeBaseUrl(value), /worker 安装/, `应拒绝: ${value}`)
  }
  assert.equal(safeBaseUrl('https://www.grapedev.cn/'), 'https://www.grapedev.cn')
})

test('token / device：只接受白名单字符', () => {
  assert.equal(safeToken('grape_AbC-123_xyz'), 'grape_AbC-123_xyz')
  for (const value of ['a b', "a'; rm -rf /", 'a$(id)', 'a|b', '']) {
    assert.throws(() => safeToken(value), /worker 安装/)
  }
  assert.equal(safeDevice('dev-1'), 'dev-1')
  assert.equal(safeDevice(''), '')
  assert.throws(() => safeDevice('dev 1; rm'), /worker 安装/)
})

test('POSIX 安装命令：每个值都单引号包裹，无裸命令替换', () => {
  const cmd = workerInstallCommand('https://h.example', 'tok-1', 'dev-1', POSIX)
  assert.equal(
    cmd,
    "curl -sSL 'https://h.example/api/runtime/install' | bash -s -- --token 'tok-1' --server 'https://h.example' --device 'dev-1'",
  )
})

test('Windows 安装命令：值用单引号包裹，psQuote 按 PowerShell 规则转义', () => {
  const cmd = workerInstallCommand('https://h.example', 'tok-1', '', WIN)
  assert.ok(cmd.includes("-Token 'tok-1'"), cmd)
  assert.ok(cmd.includes("-Server 'https://h.example'"), cmd)
  // 白名单会先挡掉引号；psQuote/shQuote 是第二道防线，单独验证
  assert.equal(psQuote("a'b"), "'a''b'")
  assert.equal(shQuote("a'b"), "'a'\\''b'")
})

test('执行用命令不含 token 字面量，token 只走环境变量', () => {
  const posix = workerInstallCommandWithEnv('https://h.example', 'SEKRET-123', 'dev-1', POSIX)
  assert.ok(!posix.command.includes('SEKRET-123'), posix.command)
  assert.ok(posix.command.includes(`--token "$${INSTALL_TOKEN_ENV}"`), posix.command)
  assert.equal(posix.env[INSTALL_TOKEN_ENV], 'SEKRET-123')

  const win = workerInstallCommandWithEnv('https://h.example', 'SEKRET-123', '', WIN)
  assert.ok(!win.command.includes('SEKRET-123'), win.command)
  assert.ok(win.command.includes(`$env:${INSTALL_TOKEN_ENV}`), win.command)
})

test('safeScriptPath：拒绝分隔符 / 绝对路径 / 上跳，接受普通文件名', () => {
  const cwd = path.resolve(os.tmpdir(), 'gd-cwd-check')
  for (const value of ['../evil.sh', '..', '.', 'a/b.sh', 'a\\b.sh', '/etc/passwd', '']) {
    assert.throws(() => safeScriptPath(cwd, value), /脚本/, `应拒绝: ${value}`)
  }
  assert.equal(safeScriptPath(cwd, '.grape-takeover-report.sh'), path.join(cwd, '.grape-takeover-report.sh'))
})

test('writeTakeoverScripts：越界条目不落盘，正常条目照写', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-sec-'))
  const parent = path.dirname(cwd)
  try {
    const out = writeTakeoverScripts(cwd, [
      { name: 'report', filename: '.grape-takeover-report.sh', ext: 'sh', content: 'echo ok', mode: '0600' },
      { name: 'evil', filename: '../escaped.sh', ext: 'sh', content: 'echo pwn', mode: '0700' },
    ], POSIX)

    assert.equal(out.find((item) => item.name === 'report')?.ok, true)
    assert.equal(out.find((item) => item.name === 'evil')?.ok, false)
    assert.ok(fs.existsSync(path.join(cwd, '.grape-takeover-report.sh')))
    assert.ok(!fs.existsSync(path.join(parent, 'escaped.sh')), '越界文件不应写出工作目录')
  }
  finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('cli-client：argv 里不再出现 --token，令牌改走环境变量', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'cli-client.js'), 'utf8')
  assert.ok(!src.includes("'--token'"), '不应再把 --token 放进子进程参数')
  assert.ok(src.includes('GRAPE_API_TOKEN'), '应通过环境变量传令牌')
})