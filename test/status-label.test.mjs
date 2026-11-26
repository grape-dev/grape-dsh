import assert from 'node:assert/strict'
import { test } from 'node:test'

import { STATUS_LABEL, statusLabel } from '../lib/status-label.js'

test('takeover has its own Chinese label (raw status may still leak)', () => {
  assert.equal(statusLabel('takeover'), '接管中')
  assert.equal(STATUS_LABEL.takeover, '接管中')
})

test('known statuses keep their labels and unknown values fall through', () => {
  assert.equal(statusLabel('cancelled'), '已取消')
  assert.equal(statusLabel('active'), '活跃')
  assert.equal(statusLabel('weird_new_status'), 'weird_new_status')
})
