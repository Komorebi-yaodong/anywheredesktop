import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const expectedValues = ['none', 'default', 'low', 'medium', 'high', 'xhigh', 'max']
const expectedLabels = ['关闭', '自动', '快速', '均衡', '深入', '强化', '极致']
const files = [
  new URL('../render/window/components/ChatInput.vue', import.meta.url)
]

for (const file of files) {
  const source = await fs.readFile(file, 'utf8')
  assert.doesNotMatch(source, /调整模型思考深度/)
  assert.match(source, /思维深度: \$\{currentReasoningOption\.value\.label\}/)
  assert.match(source, /reasoning-depth-track/)
  assert.match(source, /var\(--el-color-primary\)/)
  assert.match(source, /top: 5px/)
  assert.match(source, /box-sizing: border-box/)
  assert.match(source, /normalizeReasoningEffort/)
  for (const value of expectedValues) assert.match(source, new RegExp(`value: '${value}'`))
  for (const label of expectedLabels) assert.match(source, new RegExp(`label: '${label}'`))
}

console.log('Reasoning depth UI regression passed: seven nodes, automatic default label, and normalized compatibility values')
