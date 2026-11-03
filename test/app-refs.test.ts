import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findRefs } from '../app/src/refs.ts'

test('findRefs: matches a known project letter plus its number, word-boundaried', () => {
  const letters = ['G', 'N', 'T']
  const refs = findRefs('see G91 and N303, also T620 once more', letters)
  assert.deepEqual(
    refs.map((r) => ({ text: r.text, letter: r.letter, id: r.id })),
    [
      { text: 'G91', letter: 'G', id: 91 },
      { text: 'N303', letter: 'N', id: 303 },
      { text: 'T620', letter: 'T', id: 620 },
    ],
  )
  // Positions point at the match itself, not somewhere else in the string.
  assert.equal('see G91 and N303, also T620 once more'.slice(refs[0].start, refs[0].end), 'G91')
})

test("findRefs: non-matches — text that only looks like a ref isn't one", () => {
  // Single-digit ids (common sub-item labels) and a letter glued to another word's digits,
  // even though H, A and M are all registered here.
  assert.deepEqual(findRefs('H2 is a gas, A4 paper is common, and MP3 files are everywhere', ['H', 'A', 'M', 'P']), [])
})

test('findRefs: unknown letters are left alone even when the shape is right', () => {
  assert.deepEqual(findRefs('Z99 is not one of ours', ['G', 'N', 'T']), [])
  // Mixed: only the known letter's ref comes back.
  assert.deepEqual(
    findRefs('Z99 and G91 both mentioned', ['G']).map((r) => r.text),
    ['G91'],
  )
})

test('findRefs: a ref inside a code span is skipped, one outside it is not', () => {
  assert.deepEqual(findRefs('see `G91` for the old approach', ['G']), [])
  assert.deepEqual(
    findRefs('G91 outside and `G92` inside', ['G']).map((r) => r.text),
    ['G91'],
  )
})

test('findRefs: a ref already inside a markdown link or bare URL is left to that link', () => {
  assert.deepEqual(findRefs('[see G91](https://example.com/G91)', ['G']), [])
  assert.deepEqual(findRefs('https://example.com/G91/details', ['G']), [])
})

test('findRefs: a ref inside **bold** is left to the caller (it re-scans the inner text itself)', () => {
  assert.deepEqual(findRefs('**see G91**', ['G']), [])
})
