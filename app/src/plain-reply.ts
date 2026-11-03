/** A note's markdown as one plain paragraph: what a notice has room for. */
export function plainReply(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g, '')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A brief's title is the owner's words cut to fit a list row; a notice has room for all of them. */
export function noticeTitle(n: { title: string; intake?: boolean; original?: string | null }): string {
  const cut = n.title.endsWith('…') ? n.title.slice(0, -1).trimEnd() : null
  const words = n.original?.replace(/\s+/g, ' ').trim()
  return n.intake && cut && words?.startsWith(cut) ? words : n.title
}
