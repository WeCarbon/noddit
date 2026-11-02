// Runs inside the real window (debug build, NODDIT_APP_SCRIPT): first-run onboarding, then
// answering, replying, deferring and jumping on the bench. Every step logs to the app's
// stderr; `SHOT <name>` lines are where the runner takes a screenshot.
;(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke
  const log = (line) => invoke('log', { line })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => [...document.querySelectorAll(sel)]
  async function until(what, fn, ms = 15000) {
    const end = Date.now() + ms
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() > end) throw new Error(`timed out: ${what}`)
      await sleep(100)
    }
  }
  const shot = async (name) => {
    await invoke('e2e_shot', { name })
    await sleep(1400)
  }
  const key = (k, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }))
  const type = (el, text) => {
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const button = (text) => $$('button').find((b) => b.textContent.trim().startsWith(text))
  const toast = (text) => until(`toast "${text}"`, () => $('.toast.show')?.textContent.includes(text))
  // A dialog that has a field puts the keyboard there as soon as it opens.
  const focused = (what, sel) => until(`${what} has focus`, () => document.activeElement?.closest(sel), 3000)

  try {
    log('STEP welcome')
    ;(await until('Get started', () => button('Get started'))).click()
    await sleep(400)
    await shot('add-project')
    const drop = await until('folder step', () => $('.drop') || $('.agents'))
    if (drop.classList.contains('drop')) drop.click()

    log('STEP agents')
    await until('agents step', () => $('.agents'))
    await sleep(300)
    // Only Codex: connecting Claude Code would install the plugin into this machine's real setup.
    for (const pick of $$('.agent-pick')) {
      const want = pick.textContent.includes('Codex')
      if (pick.classList.contains('on') !== want) pick.querySelector('input').click()
      await sleep(50)
    }
    await shot('agents')
    ;(await until('Connect', () => button('Connect'))).click()
    await until('setup finished', () => $('.logo.done') || $('.act'))
    await sleep(300)
    await shot('agents-result')
    if (!$('.logo.done')) (await until('Continue', () => button('Continue'))).click()

    log('STEP done')
    ;(await until('Open the bench', () => button('Open the bench'))).click()
    await until('bench', () => $('.shell .row.node'))
    await sleep(600)
    await shot('bench')

    log('STEP answer')
    $$('.nav-item').find((b) => b.textContent.includes('Decide')).click()
    await sleep(200)
    $$('.row.node').find((r) => r.textContent.includes('Pick a database')).click()
    await sleep(200)
    key('2')
    const answerBox = await until('answer composer', () => $('.composer textarea'))
    await focused('answer composer', '.composer textarea')
    type(answerBox, 'Postgres — we need the JSON columns')
    await sleep(200)
    await shot('answer-composer')
    answerBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await toast('Sent')
    await sleep(800)
    await shot('answered')

    log('STEP enter-default')
    $$('.nav-item').find((b) => b.textContent.includes('Decide')).click()
    await sleep(200)
    $$('.row.node').find((r) => r.textContent.includes('Announce the launch')).click()
    await sleep(200)
    key('Enter')
    const confirm = await until('default composer', () => $('.composer textarea'))
    confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await toast('Sent')

    log('STEP change-answer')
    // Answered: the cards are locked; a digit says how to change it instead of answering again.
    $$('.nav-item').find((b) => b.textContent.includes('All')).click()
    await sleep(200)
    $$('.row.node').find((r) => r.textContent.includes('Announce the launch')).click()
    await until('locked cards', () => $$('.decide .option').length === 2 && $$('.decide .option').every((b) => b.disabled))
    key('2')
    await toast('Change answer')
    if ($('.composer')) throw new Error('a digit on an answered decision opened the composer')
    $('.change-answer').click()
    await until('cards unlocked', () => $$('.decide .option').every((b) => !b.disabled))
    await shot('change-answer')
    key('2')
    const again = await until('composer for the new answer', () => $('.composer textarea'))
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await toast('Sent')
    await until('locked again', () => $$('.decide .option').length === 2 && $$('.decide .option').every((b) => b.disabled))

    log('STEP reply')
    $$('.nav-item').find((b) => b.textContent.includes('All')).click()
    await sleep(200)
    $$('.row.node').find((r) => r.textContent.includes('Write the schema')).click()
    await sleep(200)
    key('N')
    const replyBox = await until('reply composer', () => $('.composer textarea'))
    await focused('reply composer', '.composer textarea')
    type(replyBox, '先把 users 表的索引补上，再跑迁移。')
    replyBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await toast('Reply added')
    await sleep(800)
    await shot('replied')

    log('STEP defer')
    $$('.row.node').find((r) => r.textContent.includes('Tidy the logs')).click()
    await sleep(200)
    key('d')
    await toast('Deferred')

    log('STEP pin')
    const pick = async (title) => {
      $$('.row.node').find((r) => r.textContent.includes(title)).click()
      await sleep(200)
    }
    await pick('Rename the bucket')
    key('t')
    await toast('Pinned')
    await sleep(600)

    log('STEP close')
    await pick('Rotate the keys')
    key('x')
    const why = await until('close composer', () => $('.composer textarea'))
    await focused('close composer', '.composer textarea')
    type(why, 'merged into X5')
    why.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await toast('Closed')
    await sleep(600)

    log('STEP seen')
    await pick('Weekly report is ready')
    key('a')
    await toast('Marked as seen')
    await sleep(600)

    log('STEP goto')
    key('g')
    let box = await until('palette', () => $('.palette input'))
    await focused('goto palette', '.palette input')
    if (box.value !== '') throw new Error(`the g that opened the palette was typed into it: "${box.value}"`)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await until('palette closed by Esc', () => !$('.palette'))
    if (document.activeElement?.closest('.palette')) throw new Error('focus stayed in the closed palette')
    key('g')
    box = await until('palette again', () => $('.palette input'))
    await focused('goto palette again', '.palette input')
    type(box, 'X1')
    await sleep(200)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await until('X1 selected', () => $('.row.sel')?.textContent.includes('X1'))

    log('STEP optimistic')
    // Defer with a slow CLI: the row leaves at once, long before the CLI returns.
    $$('.nav-item').find((b) => b.textContent.includes('Available')).click()
    await sleep(300)
    await pick('Pick a database')
    await invoke('e2e_cli_fault', { fault: { command: 'defer', delayMs: 2500, fail: false } })
    const asked = performance.now()
    key('d')
    await until('row gone at once', () => !$$('.row.node').some((r) => r.textContent.includes('Pick a database')), 1000)
    log(`optimistic: row gone ${Math.round(performance.now() - asked)} ms after d`)
    await sleep(3200)
    if ($$('.row.node').some((r) => r.textContent.includes('Pick a database'))) throw new Error('the deferred row came back after the CLI finished')
    // A failing CLI puts the row back and says why.
    await invoke('e2e_cli_fault', { fault: { command: 'defer', delayMs: 300, fail: true } })
    await pick('Write the schema')
    key('d')
    await until('row gone before the failure', () => !$$('.row.node').some((r) => r.textContent.includes('Write the schema')), 1000)
    await toast('Not saved')
    await until('row back after the failure', () => $$('.row.node').some((r) => r.textContent.includes('Write the schema')))
    await invoke('e2e_cli_fault', { fault: null })
    // Undo the first one so the rest of the run sees X1 as before.
    $$('.nav-item').find((b) => b.textContent.includes('All')).click()
    await sleep(300)
    await pick('Pick a database')
    key('d')
    await toast('Back on the lists')
    await sleep(800)

    log('STEP hotkey-window')
    // System-style notifications: the hotkey brings the main window up on the most urgent decision.
    await invoke('settings_set', { settings: { notify: 'off', hotkey: '', keepInTray: true } })
    $$('.nav-item').find((b) => b.textContent.includes('All')).click()
    await sleep(300)
    await invoke('press_hotkey', { hideFirst: true })
    await until('decide view after hotkey', () => $('.nav-item.on')?.textContent.includes('Decide'))
    await until('the waiting decision selected', () => $('.row.sel')?.textContent.includes('Rename the bucket'))

    log('STEP hotkey-banner')
    await invoke('settings_set', { settings: { notify: 'banner', hotkey: '', keepInTray: true } })
    await invoke('press_hotkey', { hideFirst: true })
    await sleep(1500)
    await invoke('banner_open_main', { key: '' })
    await sleep(300)

    log('STEP window-resize')
    // The edge handles: dragging the bottom-right corner 40×30 points grows the window by that much.
    const size = async () => {
      const s = await invoke('plugin:window|inner_size', { label: 'main' })
      const f = await invoke('plugin:window|scale_factor', { label: 'main' })
      return { w: Math.round(s.width / f), h: Math.round(s.height / f) }
    }
    if ($$('.rz > div').length !== 8) throw new Error('no resize handles on the window edges')
    const before = await size()
    await invoke('resize_begin')
    await invoke('resize_to', { edge: 'se', dx: 40, dy: 30 })
    await sleep(300)
    const grown = await size()
    if (grown.w !== before.w + 40 || grown.h !== before.h + 30) throw new Error(`corner resize: ${JSON.stringify(before)} → ${JSON.stringify(grown)}`)
    await invoke('resize_begin')
    await invoke('resize_to', { edge: 'nw', dx: 40, dy: 30 })
    await sleep(300)
    const back = await size()
    if (back.w !== before.w || back.h !== before.h) throw new Error(`back from the other corner: ${JSON.stringify(back)}`)

    log('STEP pane-dividers')
    const divider = $('.divider-list')
    const listWidth = () => $('.list-pane').offsetWidth
    const w0 = listWidth()
    const at = divider.getBoundingClientRect().left + 3
    const pointer = (type, x) => divider.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: 300, pointerId: 1, button: 0, buttons: 1 }))
    pointer('pointerdown', at)
    pointer('pointermove', at + 60)
    pointer('pointerup', at + 60)
    await until('list wider by 60', () => listWidth() === w0 + 60)
    await sleep(300)
    const saved = JSON.parse((await invoke('prefs_load')) ?? '{}')
    if (saved.panes?.list !== w0 + 60) throw new Error(`pane widths not remembered: ${JSON.stringify(saved.panes)}`)
    divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await until('default layout again', () => listWidth() === w0)

    log('STEP stress')
    // Views switching, tray phrases and node writes all at once, while the monitor streams the
    // writes back: the main thread must keep answering (debug builds log when it stops).
    const phrases = { needsDecision: 'needs a decision', notCollected: 'not collected', open: 'Open', settings: 'Settings…', quit: 'Quit' }
    const writes = []
    for (let i = 0; i < 40; i++) {
      key('Tab')
      void invoke('set_phrases', { phrases })
      void invoke('waiting_get')
      if (i % 4 === 0) writes.push(invoke('decs', { args: ['note', '2', `stress ${i}`, '--agent', '--author', 'lane-stress · e2e'], cwd: null, stdin: null }))
      await sleep(25)
    }
    const results = await Promise.all(writes)
    if (results.some((r) => r.code !== 0)) throw new Error(`a write during the stress failed: ${results.find((r) => r.code !== 0).stderr}`)
    const t0 = performance.now()
    await invoke('is_background')
    if (performance.now() - t0 > 1000) throw new Error('the main thread is slow to answer after the stress')
    // Let the monitor's echoes of those writes settle before the next steps look at the screen.
    for (let quiet = 0; quiet < 8; ) {
      await sleep(250)
      quiet = $('.live.busy') ? 0 : quiet + 1
    }

    log('STEP project-filter')
    $('.project[data-ctx="project"]').click()
    await until('project filter on', () => $('.project.on') && $('.scope-chip'))
    await sleep(300)
    if (!JSON.parse((await invoke('prefs_load')) ?? '{}').project) throw new Error('the project filter is not remembered')
    key('Escape')
    await until('Esc lifts the project filter', () => !$('.scope-chip') && !$('.project.on'))

    log('STEP settings')
    key(',', { metaKey: true })
    await until('settings', () => $('.settings'))
    await shot('settings')
    key('Escape')
    await until('settings closed', () => !$('.settings'))

    log('STEP help')
    await sleep(300)
    key('?')
    await until('help', () => $('.help'))
    await shot('help')
    key('Escape')

    log('STEP context-menus')
    const rightClick = (el) => {
      const r = el.getBoundingClientRect()
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })
      el.dispatchEvent(ev)
      return ev.defaultPrevented
    }
    const menuItem = (label) => $$('.ctx-menu .ctx-item').find((i) => i.querySelector('.ctx-label').textContent.startsWith(label))
    // Anywhere: never the web view's own menu (Reload).
    if (!rightClick($('.pane-head'))) throw new Error('the built-in context menu was not suppressed')
    if ($('.ctx-menu')) throw new Error('a menu opened on empty space')

    $$('.nav-item').find((b) => b.textContent.includes('All')).click()
    await sleep(300)
    const row = $$('.row.node').find((r) => r.textContent.includes('Pick a CDN') || r.textContent.includes('Write the schema'))
    rightClick(row)
    await until('row menu', () => $('.ctx-menu'))
    if (!row.classList.contains('sel') && !$('.row.sel')?.textContent.includes(row.querySelector('.title').textContent)) throw new Error('right-click did not select the row')
    for (const want of ['Reply…', 'Copy ', 'Copy title', 'Reveal in Finder', 'Open the file']) if (!menuItem(want)) throw new Error(`row menu lacks ${want}`)
    await shot('row-menu')
    key('Escape')
    await until('menu closed', () => !$('.ctx-menu'))

    // ⇧F10 opens the selected row's menu; arrows and Enter run an item.
    await until('a selected row', () => $('.row.sel'))
    key('F10', { shiftKey: true })
    await until('keyboard menu', () => $('.ctx-menu') || (key('F10', { shiftKey: true }), false), 5000)
    key('Escape')
    await until('menu closed again', () => !$('.ctx-menu'))

    log('STEP flag')
    // ! marks important; the context menu sets a milestone through its date dialog.
    $$('.nav-item').find((b) => b.textContent.includes('All')).click()
    await sleep(200)
    await pick('Write the schema')
    key('!')
    await toast('Marked important')
    await until('★ on the row', () => $('.row.sel .flag-mark.important'))
    rightClick($('.row.sel'))
    await until('milestone item', () => menuItem('Set a milestone'))
    menuItem('Set a milestone').click()
    const date = await until('milestone date', () => $('.milestone-dialog input'))
    await focused('milestone date', '.milestone-dialog input')
    type(date, '2030-01-15')
    await sleep(100)
    await shot('milestone-dialog')
    // Enabled once the previous write (the ! above) has finished refreshing.
    ;(await until('save enabled', () => ($('.milestone-dialog .primary')?.disabled === false ? $('.milestone-dialog .primary') : null))).click()
    await toast('Milestone set')
    await until('⚑ on the row', () => $('.row.sel .flag-mark.milestone') || $('.row.node.sel') && $('.nhead .mchip.c-magenta'))

    log('STEP announce')
    // The runner files a decision from outside now; it must reach the bench (and be announced, which the runner checks).
    await until('the new decision on the bench', () => $$('.row.node').some((r) => r.textContent.includes('Pick a CDN')), 30000)

    const cli = await invoke('decs', { args: ['sessions', '--json'], cwd: null, stdin: null })
    if (cli.code === 0) {
      log('STEP brief')
      key('k', { metaKey: true })
      const words = await until('quick entry', () => $('.quick textarea'))
      await focused('quick entry', '.quick textarea')
      type(words, 'Add rate limits to the export endpoint')
      words.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await toast('Filed')
      // Nobody listens in a scratch project: the app offers to start a session; in test mode that is a dry run.
      await until('start-session prompt', () => $('.confirm .primary'))
      await focused('start-session prompt', '.confirm .primary')
      await shot('start-session')
      $('.confirm .primary').click()
      await toast('test mode')
      await until('the brief selected, waiting for an AI', () => $('.mchip.brief'))
      await shot('brief')
    } else log('STEP brief-skipped (this CLI has no sessions command)')

    log('STEP project-menu')
    const projectRow = () => $('.project[data-ctx="project"]')
    rightClick(projectRow())
    await until('project menu', () => menuItem('Rename'))
    for (const want of ['Rename', 'Change letter', 'Unlink', 'Reveal in Finder', 'Copy path']) if (!menuItem(want)) throw new Error(`project menu lacks ${want}`)
    await shot('project-menu')
    menuItem('Rename').click()
    await until('rename field', () => $('.project input.rename'))
    await focused('rename field', '.project input.rename')
    // Looked up again: a live refresh may have redrawn the sidebar meanwhile.
    const field = $('.project input.rename')
    field.value = 'Shop front'
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await toast('Renamed')
    await until('sidebar shows the new name', () => projectRow()?.textContent.includes('Shop front'))

    rightClick(projectRow())
    await until('project menu again', () => menuItem('Change letter'))
    menuItem('Change letter').click()
    await until('letter picker', () => $('.letter-picker'))
    await focused('letter picker', '.letter-picker')
    await shot('letter-picker')
    $$('.lp').find((b) => b.textContent === 'Q').click()
    await toast('Letter changed')
    await until('sidebar shows Q', () => projectRow()?.querySelector('.letter').textContent === 'Q')

    rightClick(projectRow())
    await until('project menu for unlink', () => menuItem('Unlink'))
    menuItem('Unlink').click()
    await until('confirm', () => $('.confirm'))
    await focused('unlink confirm', '.confirm')
    await shot('unlink-confirm')
    $$('.confirm button').find((b) => b.textContent.trim() === 'Unlink').click()
    // It was the only project: the window goes back to "Add a project".
    await until('back to adding a project', () => $('.drop'))

    log('DONE')
  } catch (e) {
    log(`PAGE ${document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)}`)
    log(`FAIL ${e.message}`)
    await shot('failure')
  }
})()
