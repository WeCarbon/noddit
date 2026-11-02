import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { bool, one, type Args } from '../args.ts'
import { resolveStore } from '../context.ts'
import { stripPrefix, upgradeAttachments, upgradeOptionLists, upgradeStatuses, type Step } from '../../core/upgrade.ts'
import { initLayout, layoutFor, listEntryFiles, type Layout } from '../../core/paths.ts'
import { serializeDecision } from '../../core/serialize.ts'
import { parseLegacyActive, parseLegacyArchive, toDecision, type LegacyEntry } from '../../migrate/legacy.ts'
import { t } from '../../i18n/index.ts'

const help = () => t('cli.help.migrate')

export async function run(args: Args): Promise<number> {
  if (bool(args, 'help', 'h')) {
    console.log(help())
    return 0
  }
  if (bool(args, 'upgrade') || bool(args, 'strip-prefix') || bool(args, 'attachments')) return upgrade(args)

  const dir = one(args, 'dir', 'd') ?? process.cwd()
  const dryRun = bool(args, 'dry-run')
  const force = bool(args, 'force')

  const activePath = join(dir, 'DECISIONS.md')
  const archivePath = join(dir, 'DECISIONS.old.md')
  const hasActive = existsSync(activePath)
  const hasArchive = existsSync(archivePath)
  if (!hasActive && !hasArchive) {
    console.error(t('cli.migrate.noLegacyFiles', { dir }))
    return 1
  }

  const project = basename(dir)
  const activeEntries = hasActive ? parseLegacyActive(readFileSync(activePath, 'utf8')) : []
  const archiveEntries = hasArchive ? parseLegacyArchive(readFileSync(archivePath, 'utf8')) : []

  const layout: Layout = dryRun ? layoutFor(dir) : initLayout(dir)
  const existingById = new Map(listEntryFiles(layout).map((f) => [f.id, f]))
  const seenIds = new Set<number>()

  // A legacy corpus can reuse ids across entries; two decisions can't share
  // one output file, so a same-run collision gets the next free id instead,
  // loudly, rather than overwriting anything.
  let nextFreeId =
    1 +
    Math.max(
      0,
      ...activeEntries.map((e) => e.id),
      ...archiveEntries.map((e) => e.id),
      ...existingById.keys(),
    )
  const renumbered: { from: number; to: number; title: string }[] = []

  let writtenActive = 0
  let writtenArchived = 0
  let skippedCount = 0
  let withOptions = 0
  let withoutOptions = 0
  const withWarnings: { id: number; warnings: string[] }[] = []
  const skippedLines: string[] = []

  const writeOne = (rawEntry: LegacyEntry, archived: boolean) => {
    let entry = rawEntry
    if (seenIds.has(entry.id)) {
      const from = entry.id
      const to = nextFreeId++
      entry = { ...entry, id: to, warnings: [...entry.warnings, t('core.migrate.legacyIdReused', { from, to })] }
      renumbered.push({ from, to, title: entry.title })
    }
    seenIds.add(entry.id)

    if (entry.warnings.length) withWarnings.push({ id: entry.id, warnings: entry.warnings })
    if (entry.options.length) withOptions++
    else withoutOptions++

    const decision = toDecision(entry, project)
    const targetDir = archived ? layout.archivedDir : layout.activeDir
    const fname = `D${entry.id}-${decision.slug}.md`
    const fpath = join(targetDir, fname)

    const prior = existingById.get(entry.id)
    if (prior && !force) {
      skippedCount++
      skippedLines.push(t('cli.migrate.skippedLine', { id: entry.id, fname, path: prior.path }))
      return
    }

    const tag = archived ? t('cli.migrate.archivedTag') : t('cli.migrate.activeTag')
    const warn = entry.warnings.length ? `  ⚠ ${entry.warnings.join('; ')}` : ''
    console.log(`${dryRun ? t('cli.migrate.wouldWrite') : t('cli.migrate.wrote')} ${tag}  D${entry.id} → ${fname}${warn}`)

    if (dryRun) return
    if (prior && prior.path !== fpath) rmSync(prior.path)
    writeFileSync(fpath, serializeDecision(decision))
    const idPath = join(layout.idsDir, String(entry.id))
    if (!existsSync(idPath)) closeSync(openSync(idPath, 'w'))
    if (archived) writtenArchived++
    else writtenActive++
  }

  for (const e of activeEntries) writeOne(e, false)
  for (const e of archiveEntries) writeOne(e, true)

  console.log('')
  console.log(t('cli.migrate.heading', { dir }))
  console.log(`  ${t('cli.migrate.activeSummary', { count: activeEntries.length, written: dryRun ? '' : t('cli.migrate.writtenSuffix', { count: writtenActive }) })}`)
  console.log(`  ${t('cli.migrate.archivedSummary', { count: archiveEntries.length, written: dryRun ? '' : t('cli.migrate.writtenSuffix', { count: writtenArchived }) })}`)
  if (skippedCount) console.log(`  ${t('cli.migrate.skippedSummary', { count: skippedCount })}`)
  console.log(`  ${t('cli.migrate.optionsSummary', { with: withOptions, without: withoutOptions })}`)
  console.log(`  ${t('cli.migrate.warningsSummary', { count: withWarnings.length })}`)
  if (renumbered.length) console.log(`  ⚠ ${t('cli.migrate.renumberedSummary', { count: renumbered.length })}`)

  if (renumbered.length) {
    console.log('')
    console.log(t('cli.migrate.renumberedHeading'))
    for (const r of renumbered) console.log(`  D${r.from} → D${r.to}  ${r.title}`)
  }

  if (withWarnings.length) {
    console.log('')
    console.log(t('cli.migrate.warningsHeading'))
    for (const w of withWarnings) console.log(`  D${w.id}: ${w.warnings.join('; ')}`)
  }

  if (skippedLines.length) {
    console.log('')
    console.log(t('cli.migrate.skippedHeading'))
    for (const l of skippedLines) console.log(`  ${l}`)
  }

  console.log('')
  if (dryRun) {
    console.log(t('cli.migrate.dryRunDone'))
  } else {
    console.log(
      `${t('cli.migrate.untouchedHint')}\n` +
        `  git rm ${hasActive ? 'DECISIONS.md ' : ''}${hasArchive ? 'DECISIONS.old.md' : ''}`.trimEnd(),
    )
  }

  return 0
}

/**
 * The in-place upgrades of an existing decisions/ — one project at a time,
 * because a person looks at the dry run of each before running it.
 */
function upgrade(args: Args): number {
  const store = resolveStore(args)
  const layout = store.primary
  const dryRun = bool(args, 'dry-run')
  const steps: Step[] = []
  // Prefix first: the status pass reads the files where they end up.
  if (bool(args, 'strip-prefix')) steps.push(...stripPrefix(layout, { dryRun }))
  if (bool(args, 'upgrade')) steps.push(...upgradeStatuses(store, { dryRun }), ...upgradeOptionLists(store, { dryRun }))
  const attachments = bool(args, 'attachments') ? upgradeAttachments(store, { dryRun }) : undefined
  if (attachments) steps.push(...attachments.steps)
  // join()'d paths use the host separator — a hard-coded `/` never matched on Windows.
  const rel = (p: string) => p.replace(`${layout.root}${sep}`, '')
  for (const s of steps) console.log(`${dryRun ? t('cli.migrate.wouldPrefix') : ''}${s.what}  ${rel(s.from)}${s.to ? ` → ${rel(s.to)}` : ''}`)
  console.log(
    steps.length
      ? `\n${t('cli.migrate.upgradeSteps', { count: steps.length, dryRun: dryRun ? t('cli.migrate.dryRunNoChange') : '' })}`
      : t('cli.migrate.alreadyUpToDate'),
  )
  if (attachments) {
    const ambiguous = attachments.plans.flatMap((p) => p.moves.filter((m) => m.ambiguous).map((m) => ({ p, m })))
    console.log('')
    console.log(
      t('cli.migrate.attachmentsSummary', {
        nodes: attachments.plans.filter((p) => p.changedCount).length,
        moved: attachments.plans.reduce((n, p) => n + p.changedCount, 0),
        ambiguous: ambiguous.length,
      }),
    )
    if (ambiguous.length) {
      console.log(t('cli.migrate.attachmentsAmbiguousHeading'))
      for (const { p, m } of ambiguous) console.log(`  ${p.project}#${p.id}  ${m.target}  ${m.from} → [${m.candidates.join(', ')}]`)
    }
  }
  return 0
}
