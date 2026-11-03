import assert from 'node:assert/strict'
import { test } from 'node:test'
import { noticeTitle, plainReply } from '../app/src/plain-reply.ts'

test('a reply becomes one plain paragraph for a notice', () => {
  const md = ['Status for the release:', '', '- **tests** pass', '- see [the PR](https://example.com/pr/1)', '', '![shot](a.png)', '<!-- nod:by=web -->'].join('\n')
  assert.equal(plainReply(md), 'Status for the release: tests pass see the PR')
})

test('headings and numbered lists lose their markers', () => {
  assert.equal(plainReply('## Done\n1. merged\n2. `npm test` green'), 'Done merged npm test green')
})

test('a cut brief title becomes the owner’s whole words in a notice', () => {
  const original = 'the login page should remember   the last project I opened, and show it first'
  assert.equal(noticeTitle({ title: 'the login page should remember…', intake: true, original }), 'the login page should remember the last project I opened, and show it first')
  assert.equal(noticeTitle({ title: 'Remember the last project', intake: true, original }), 'Remember the last project', 'an expanded brief keeps its new title')
  assert.equal(noticeTitle({ title: 'Ship it…', original: 'Ship it now' }), 'Ship it…', 'only briefs')
})
