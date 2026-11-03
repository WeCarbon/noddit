import assert from 'node:assert/strict'
import { test } from 'node:test'
import { plainReply } from '../app/src/plain-reply.ts'

test('a reply becomes one plain paragraph for a notice', () => {
  const md = ['Status for the release:', '', '- **tests** pass', '- see [the PR](https://example.com/pr/1)', '', '![shot](a.png)', '<!-- nod:by=web -->'].join('\n')
  assert.equal(plainReply(md), 'Status for the release: tests pass see the PR')
})

test('headings and numbered lists lose their markers', () => {
  assert.equal(plainReply('## Done\n1. merged\n2. `npm test` green'), 'Done merged npm test green')
})
