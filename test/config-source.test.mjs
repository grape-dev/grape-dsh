import test from 'node:test'
import assert from 'node:assert/strict'

import { grapeConfigError, resolveGrapeCliConfig, resolveGrapeCliConfigLenient } from '../lib/cli-client.js'

/**
 * 环境隔离（2026-11-20 用户要求）：
 * 插件只允许从 cordis.patch.yml（插件 config）读取 baseUrl ——
 * 不读 GRAPE_BASE_URL / GRAPE_SERVER_URL，也没有内置默认地址。
 */
test('resolveGrapeCliConfig：baseUrl 只认插件 config（去掉尾斜杠），环境变量不再兜底', () => {
  const prevBase = process.env.GRAPE_BASE_URL
  const prevServer = process.env.GRAPE_SERVER_URL
  process.env.GRAPE_BASE_URL = 'https://env.example'
  process.env.GRAPE_SERVER_URL = 'https://env-server.example'
  try {
    const cfg = resolveGrapeCliConfig({ baseUrl: 'https://cfg.example/', token: 'grape_x' })
    assert.equal(cfg.baseUrl, 'https://cfg.example')
    assert.equal(cfg.token, 'grape_x')
  }
  finally {
    if (prevBase === undefined) delete process.env.GRAPE_BASE_URL
    else process.env.GRAPE_BASE_URL = prevBase
    if (prevServer === undefined) delete process.env.GRAPE_SERVER_URL
    else process.env.GRAPE_SERVER_URL = prevServer
  }
})

test('resolveGrapeCliConfig：未配置 baseUrl → 明确报错，绝不回落到环境变量/localhost', () => {
  const prevBase = process.env.GRAPE_BASE_URL
  process.env.GRAPE_BASE_URL = 'https://env.example'
  try {
    assert.throws(
      () => resolveGrapeCliConfig({ token: 'grape_x' }),
      /baseUrl 未配置/,
    )
  }
  finally {
    if (prevBase === undefined) delete process.env.GRAPE_BASE_URL
    else process.env.GRAPE_BASE_URL = prevBase
  }
})

test('resolveGrapeCliConfigLenient：缺 baseUrl/token 也不抛（宿主挂载不能因缺配置整块挂掉）', () => {
  const empty = resolveGrapeCliConfigLenient({}, {})
  assert.equal(empty.baseUrl, '')
  assert.equal(empty.token, '')
  assert.match(grapeConfigError(empty), /baseUrl 未配置/)

  const onlyBase = resolveGrapeCliConfigLenient({ baseUrl: 'https://cfg.example/' }, {})
  assert.equal(onlyBase.baseUrl, 'https://cfg.example')
  assert.match(grapeConfigError(onlyBase), /token 未配置/)

  const ok = resolveGrapeCliConfigLenient({ baseUrl: 'https://cfg.example', token: 'grape_x' }, {})
  assert.equal(grapeConfigError(ok), '')
})

test('resolveGrapeCliConfig：token 只认插件 config（GRAPE_API_TOKEN 不再兜底）', () => {
  const prevToken = process.env.GRAPE_API_TOKEN
  process.env.GRAPE_API_TOKEN = 'grape_env'
  try {
    // 未配置 token → 明确报错，不会拿环境里的令牌顶上
    assert.throws(
      () => resolveGrapeCliConfig({ baseUrl: 'https://cfg.example' }),
      /token 未配置/,
    )
    const cfg = resolveGrapeCliConfig({ baseUrl: 'https://cfg.example', token: 'grape_cfg' })
    assert.equal(cfg.token, 'grape_cfg')
  }
  finally {
    if (prevToken === undefined) delete process.env.GRAPE_API_TOKEN
    else process.env.GRAPE_API_TOKEN = prevToken
  }
})