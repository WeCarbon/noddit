import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ATTACHMENT_RE } from '../src/core/parse.ts'
import { splitImageLinks } from '../src/tui/images.ts'

test('a file name with parentheses keeps its whole path in attachment and image links', () => {
  const line = '- ![shot (1).png](../attachments/7/shot (1).png)'
  assert.equal(ATTACHMENT_RE.exec(line)?.[3], '../attachments/7/shot (1).png')
  const parts = splitImageLinks('see ![a](../attachments/7/a(b).png) here')
  assert.deepEqual(parts.find((p) => 'target' in p), { alt: 'a', target: '../attachments/7/a(b).png' })
})
