/**
 * 包身份防漂移测试（Issue #15）。
 *
 * 包名收敛为单一来源：`package.json.name` 为唯一真源。
 * - `cordis.patch.yml` 的 module id（insert 项的 name）必须与之一致（静态清单无法运行时推导，靠本测试守护）；
 * - `scripts/build-client.mjs` 的 PKG_NAME 必须由 `package.json` 推导，不得硬编码；
 * - tarball 命名直接向 `npm pack --dry-run` 取真实产物名，不在此另造第二套规则。
 *
 * 任一身份点回退为旧名 → 本文件用例变红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PKG_NAME } from '../scripts/build-client.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
/** 改名后的目标包名（Issue #15 的验收基线） */
const EXPECTED_NAME = '@grape-dev/grape-dsh'

function readText(relPath) {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}

function readPackage() {
  return JSON.parse(readText('package.json'))
}

/** 取 cordis.patch.yml 中 `id: grape-tools` 这一 insert 项的 module id（name 字段） */
function cordisModuleName() {
  const text = readText('cordis.patch.yml')
  const match = text.match(
    /^[ \t]*-[ \t]+insert:[ \t]*\r?\n[ \t]*-[ \t]+id:[ \t]*grape-tools[ \t]*\r?\n[ \t]*name:[ \t]*['"]?([^'"\s#]+)['"]?/m,
  )
  assert.ok(match, 'cordis.patch.yml 应包含 id: grape-tools 及其后的 name（module id）字段')
  return match[1]
}

test('package.json.name、cordis.patch.yml module id、build 脚本 PKG_NAME 三者一致', () => {
  const pkg = readPackage()

  assert.equal(pkg.name, EXPECTED_NAME, `package.json.name 应为 ${EXPECTED_NAME}`)
  assert.equal(cordisModuleName(), pkg.name, 'cordis.patch.yml 的 module id 应与 package.json.name 一致')
  assert.equal(PKG_NAME, pkg.name, 'build 脚本的 PKG_NAME 应与 package.json.name 一致')
})

test('build-client.mjs 的 PKG_NAME 由 package.json 推导，不硬编码包名', () => {
  const source = readText('scripts/build-client.mjs')
  assert.match(source, /readFileSync\([^)]*package\.json/, 'PKG_NAME 应通过 readFileSync 读取 package.json')
  assert.match(source, /JSON\.parse\(/, 'package.json 读取后应 JSON.parse')
})

test('npm pack --dry-run 计划产物名 = grape-dev-grape-dsh-<version>.tgz', () => {
  const pkg = readPackage()
  // --ignore-scripts：不要为一次「只问名字」的检查跑 prepare/tsc
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' },
  )

  assert.equal(result.status, 0, `npm pack --dry-run 应 exit 0：${result.stdout}${result.stderr}`)
  const parsed = JSON.parse(result.stdout)
  const filename = String(parsed?.[0]?.filename || '')
  assert.equal(
    filename,
    `grape-dev-grape-dsh-${pkg.version}.tgz`,
    '产物名应由包名推导（作用域去掉 @ 与 /，拼 <version>.tgz）',
  )
})