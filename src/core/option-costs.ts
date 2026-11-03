import type { Decision } from './types.ts'

const OPTION_HEADING = /^###[ \t]+([A-Za-z0-9]{1,4})[ \t]*(?:[·:：．.\-—–]|$)/

/** A plan to confirm (「按计划开始 / 要改」) needs no cost per option: the plan above is the cost. */
const PLAN_CONFIRM = /按计划|按計劃|要改|start as planned|change it|commencer comme prévu|à modifier|ابدأ|عدّل/i

/** Keys of `d`'s options that say nothing about what choosing them costs — under the option or in a `### <key> · …` section. */
export function optionsWithoutCost(d: Pick<Decision, 'options' | 'body'>): string[] {
  if (d.options.length < 2 || d.options.every((o) => PLAN_CONFIRM.test(o.label))) return []
  const explained = new Set<string>()
  const lines = d.body.split('\n')
  lines.forEach((line, i) => {
    const m = OPTION_HEADING.exec(line)
    if (!m) return
    let end = i + 1
    while (end < lines.length && !/^#{2,3}[ \t]+\S/.test(lines[end])) end++
    if (lines.slice(i + 1, end).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim()) explained.add(m[1])
  })
  return d.options.filter((o) => !o.body.trim() && !explained.has(o.key)).map((o) => o.key)
}
