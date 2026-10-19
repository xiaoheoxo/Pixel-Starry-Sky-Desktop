import { extText } from '@pixelsky/protocol'
import type { ExtLocale, ExtPackContributionKind, ExtPackManifest } from '@pixelsky/protocol'

// 「包含什么」：按清单算（商店详情的 contents[] 只有种类和条数，拿不到语言名）。本机详情和商店详情共用

/** 显示顺序 */
export const CONTRIBUTION_KIND_ORDER: readonly ExtPackContributionKind[] = [
  'grammars',
  'themes',
  'snippets',
  'iconThemes',
  'taskTemplates',
  'skills',
  'prompts',
]

export interface ManifestContributionRow {
  kind: ExtPackContributionKind
  /** 清单下标 */
  index: number
  label: string
}

function labelOf(manifest: ExtPackManifest, kind: ExtPackContributionKind, index: number, locale: ExtLocale): string {
  const c = manifest.contributes
  switch (kind) {
    case 'grammars': {
      const g = c.grammars?.[index]
      return g ? (g.language ?? g.scopeName) : ''
    }
    case 'themes': {
      const t = c.themes?.[index]
      return t ? extText(t.label, locale) : ''
    }
    case 'snippets':
      return c.snippets?.[index]?.language ?? ''
    case 'iconThemes': {
      const t = c.iconThemes?.[index]
      return t ? extText(t.label, locale) : ''
    }
    case 'taskTemplates': {
      const t = c.taskTemplates?.[index]
      return t ? extText(t.label, locale) : ''
    }
    case 'skills':
      return c.skills?.[index]?.path ?? ''
    case 'prompts': {
      const t = c.prompts?.[index]
      return t ? extText(t.title, locale) : ''
    }
  }
}

/** 清单里的每一条贡献（按显示顺序、清单下标）；没有清单是空数组 */
export function contributionRowsOf(
  manifest: ExtPackManifest | null | undefined,
  locale: ExtLocale,
): ManifestContributionRow[] {
  const rows: ManifestContributionRow[] = []
  if (!manifest) return rows
  for (const kind of CONTRIBUTION_KIND_ORDER) {
    const list = manifest.contributes?.[kind]
    if (!Array.isArray(list)) continue
    list.forEach((_, index) => rows.push({ kind, index, label: labelOf(manifest, kind, index, locale) }))
  }
  return rows
}

export interface ContributionGroup {
  kind: ExtPackContributionKind
  count: number
  /** 去重后的名字（语言、主题名…） */
  names: string[]
}

/** 按种类合并：「1 个语法高亮（Swift）」 */
export function contributionGroupsOf(
  manifest: ExtPackManifest | null | undefined,
  locale: ExtLocale,
): ContributionGroup[] {
  const groups = new Map<ExtPackContributionKind, ContributionGroup>()
  for (const row of contributionRowsOf(manifest, locale)) {
    const g = groups.get(row.kind) ?? { kind: row.kind, count: 0, names: [] }
    g.count++
    if (row.label && !g.names.includes(row.label)) g.names.push(row.label)
    groups.set(row.kind, g)
  }
  return [...groups.values()]
}
