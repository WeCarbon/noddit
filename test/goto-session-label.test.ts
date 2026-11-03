import { test } from 'node:test'
import assert from 'node:assert/strict'

import { gotoSessionBundleId, gotoSessionLabelKey } from '../app/src/goto-label.ts'

test('gotoSessionLabelKey: iTerm2 and Terminal.app each name their own menu label', () => {
  assert.equal(gotoSessionLabelKey('mac-iterm2'), 'ctxGotoSessionIterm2')
  assert.equal(gotoSessionLabelKey('mac-terminal'), 'ctxGotoSessionTerminal')
})

test('gotoSessionBundleId: the bundle id NSWorkspace would look up for each terminal', () => {
  assert.equal(gotoSessionBundleId('mac-iterm2'), 'com.googlecode.iterm2')
  assert.equal(gotoSessionBundleId('mac-terminal'), 'com.apple.Terminal')
})
