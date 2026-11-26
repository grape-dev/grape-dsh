import test from 'node:test'
import assert from 'node:assert/strict'

import { Config } from '../lib/index.js'

/**
 * 回归：dsh 设置表单按**运行时 schema**（`z.object`）校验写入。
 *
 * 只把字段加进 TS `Config` 接口、客户端面板也做了输入框，但运行时 schema 没声明时，
 * 主机写入会被拒绝 → 用户点「保存」看到「保存失败」。0.5.1 的 deviceName 就是这么踩的。
 *
 * 因此这里把「面板会写的字段」逐个钉进断言：任何一边漏声明，这条测试就红。
 */
const PANEL_FIELDS = ['bin', 'baseUrl', 'token', 'deviceName', 'timeout', 'confirmWrites', 'grapeTheme']

test('Config schema 声明了设置面板会写的全部字段（缺一个就会「保存失败」）', () => {
  const fields = Object.keys(Config.dict ?? {})
  for (const field of PANEL_FIELDS) {
    assert.ok(
      fields.includes(field),
      `Config schema 缺少字段 ${field}：客户端面板写它会被 dsh 主机拒绝（表现为保存失败）`,
    )
  }
})

test('Config schema：deviceName 可校验写入，且默认空串（未配置时按 dsh-<host> 生成）', () => {
  assert.doesNotThrow(() => Config({ deviceName: 'dsh-worker-001' }))
  assert.doesNotThrow(() => Config({}))
  const schema = Config.dict.deviceName
  const node = schema?.refs?.[schema?.uid] ?? schema
  assert.equal(node?.type, 'string')
  assert.equal(node?.meta?.default, '')
})