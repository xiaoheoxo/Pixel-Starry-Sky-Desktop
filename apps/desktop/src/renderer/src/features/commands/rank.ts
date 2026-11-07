export interface SearchableCommand {
  id: string
  label: string
  keywords: string
  category: string
}
export interface CommandGroup<T> {
  /** null：搜索结果，按相关度排，不分组 */
  title: string | null
  items: T[]
}
/** 面板的显示顺序（上下键也按这个走）：没搜索时最近使用在最前，其余按分类；搜索时保持相关度顺序 */
export function groupCommands<T extends SearchableCommand>(
  ranked: T[],
  query: string,
  history: string[],
  recentTitle: string,
): CommandGroup<T>[] {
  if (query.trim()) return ranked.length ? [{ title: null, items: ranked }] : []
  const recent = ranked.filter(item => history.includes(item.id))
  const byCategory = new Map<string, T[]>()
  for (const item of ranked) {
    if (!history.includes(item.id)) byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item])
  }
  return [
    ...(recent.length ? [{ title: recentTitle, items: recent }] : []),
    ...[...byCategory].map(([title, items]) => ({ title, items })),
  ]
}
export function rankCommands<T extends SearchableCommand>(commands: T[], query: string, history: string[]): T[] {
  const normalized = query.trim().toLocaleLowerCase(),
    words = normalized.split(/\s+/).filter(Boolean)
  const recent = (id: string): number => {
    const n = history.indexOf(id)
    return n >= 0 && n < 8 ? n : 99
  }
  return commands
    .map((item, order) => {
      const label = item.label.toLocaleLowerCase(),
        haystack = (label + ' ' + item.keywords + ' ' + item.category).toLocaleLowerCase()
      const score = !words.length
        ? 0
        : !words.every(word => haystack.includes(word))
          ? -1
          : label === normalized
            ? 3
            : label.startsWith(normalized)
              ? 2
              : 1
      return { item, order, score }
    })
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || recent(a.item.id) - recent(b.item.id) || a.order - b.order)
    .map(item => item.item)
}
