import assert from 'node:assert/strict'
import {
  getQuickAssistantWeight,
  recordQuickAssistantUsage
} from '../main/core/quickAssistantUsage.js'

let usage = {}
usage = recordQuickAssistantUsage(usage, 'Alpha', new Date(2026, 9, 1, 9))
usage = recordQuickAssistantUsage(usage, 'Alpha', new Date(2026, 9, 1, 12))
usage = recordQuickAssistantUsage(usage, 'Beta', new Date(2026, 9, 3, 9))
usage = recordQuickAssistantUsage(usage, 'Alpha', new Date(2026, 9, 8, 9))

assert.deepEqual(usage.activeDates, ['2026-10-01', '2026-10-03', '2026-10-08'])
assert.equal(getQuickAssistantWeight(usage, 'Alpha'), (2 * 5 / 7) + 1)
assert.equal(getQuickAssistantWeight(usage, 'Beta'), 6 / 7)

for (let day = 9; day <= 14; day += 1) {
  usage = recordQuickAssistantUsage(usage, 'Gamma', new Date(2026, 9, day, 9))
}

assert.deepEqual(usage.activeDates, [
  '2026-10-08',
  '2026-10-09',
  '2026-10-10',
  '2026-10-11',
  '2026-10-12',
  '2026-10-13',
  '2026-10-14'
])
assert.equal(getQuickAssistantWeight(usage, 'Alpha'), 1 / 7)
assert.equal(getQuickAssistantWeight(usage, 'Beta'), 0)
assert.equal(getQuickAssistantWeight(usage, 'Gamma'), (2 + 3 + 4 + 5 + 6 + 7) / 7)

console.log('Quick assistant usage regression passed: active usage days, skipped calendar days, seven-day retention, weighted ranking')
