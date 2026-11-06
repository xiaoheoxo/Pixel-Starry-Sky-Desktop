import { extText, grammarMatchScore, packName } from '@pixelsky/protocol'
import type { ExtLocale, ExtPackContributionKind, ExtPackInfo, ExtPackIssue } from '@pixelsky/protocol'
import { isContributionActive } from '@/features/extpacks/model'
import { grammarBuiltinConflicts, grammarOverrideKey } from '@/features/editor/code/languageIds'

// 设置 › 扩展页的纯函数：分类、筛选、贡献清单、语法冲突、问题文字。不碰 window

export type PackGroup = 'all' | 'code' | 'ai'

const CODE_KINDS: ExtPackContributionKind[] = ['grammars', 'themes', 'snippets', 'iconThemes', 'taskTemplates']
const AI_KINDS: ExtPackContributionKind[] = ['skills', 'prompts', 'mcpServers']
/** 「包含什么」里的显示顺序 */
export const KIND_ORDER: ExtPackContributionKind[] = [...CODE_KINDS, ...AI_KINDS, 'uiThemes']

/** 列表里显示的名字：清单名（按语言），读不到清单就退回 id / 路径末段 */
export function packTitle(p: ExtPackInfo, locale: ExtLocale): string {
  if (p.manifest) return packName(p.manifest, locale)
  return p.id ?? (p.path.split(/[\\/]/).filter(Boolean).pop() || p.key)
}

function contributionLabel(p: ExtPackInfo, kind: ExtPackContributionKind, index: number, locale: ExtLocale): string {
  const c = p.manifest?.contributes
  switch (kind) {
    case 'grammars': {
      const g = c?.grammars?.[index]
      return g ? (g.language ?? g.scopeName) : ''
    }
    case 'themes': {
      const t = c?.themes?.[index]
      return t ? extText(t.label, locale) : ''
    }
    case 'snippets':
      return c?.snippets?.[index]?.language ?? ''
    case 'iconThemes': {
      const t = c?.iconThemes?.[index]
      return t ? extText(t.label, locale) : ''
    }
    case 'taskTemplates': {
      const t = c?.taskTemplates?.[index]
      return t ? extText(t.label, locale) : ''
    }
    case 'skills':
      return c?.skills?.[index]?.path ?? ''
    case 'prompts': {
      const t = c?.prompts?.[index]
      return t ? extText(t.title, locale) : ''
    }
    case 'mcpServers':
      return c?.mcpServers?.[index]?.name ?? ''
    case 'commands': {
      const t = c?.commands?.[index]
      return t ? extText(t.title, locale) : ''
    }
    case 'uiThemes': {
      const t = c?.uiThemes?.[index]
      return t ? extText(t.label, locale) : ''
    }
  }
}

export interface ContributionRow {
  kind: ExtPackContributionKind
  /** 清单下标 */
  index: number
  label: string
  active: boolean
  issues: ExtPackIssue[]
}

export function contributionRows(p: ExtPackInfo, locale: ExtLocale): ContributionRow[] {
  const rows: ContributionRow[] = []
  for (const kind of KIND_ORDER) {
    const list = p.manifest?.contributes[kind]
    if (!Array.isArray(list)) continue
    list.forEach((_, index) => {
      rows.push({
        kind,
        index,
        label: contributionLabel(p, kind, index, locale),
        active: isContributionActive(p, kind, index),
        issues: p.issues.filter(i => i.contribution?.kind === kind && i.contribution.index === index),
      })
    })
  }
  return rows
}

export interface GrammarConflict {
  index: number
  overrideKey: string
  builtin: string[]
  otherPacks: string[]
}

/** 每条语法（清单下标）撞上的内置语言，以及其他生效扩展里认领同一扩展名 / 文件名的包 */
export function grammarConflicts(p: ExtPackInfo, all: ExtPackInfo[]): GrammarConflict[] {
  const out: GrammarConflict[] = []
  const grammars = p.manifest?.contributes.grammars ?? []
  grammars.forEach((g, index) => {
    const builtin = grammarBuiltinConflicts(g)
    const exts = (g.extensions ?? []).map(e => e.toLowerCase())
    const names = (g.filenames ?? []).map(f => f.toLowerCase())
    const others = new Set<string>()
    for (const o of all) {
      if (o.key === p.key || !o.live) continue
      for (const og of o.manifest?.contributes.grammars ?? []) {
        const hit =
          (og.filenames ?? []).some(f => names.includes(f.toLowerCase())) ||
          (og.extensions ?? []).some(e => exts.includes(e.toLowerCase())) ||
          // 对方的扩展名能匹配我方的文件名
          (g.filenames ?? []).some(n => grammarMatchScore(og, n) > 0)
        if (hit) others.add(o.id ?? o.key)
      }
    }
    if (builtin.length || others.size) {
      out.push({ index, overrideKey: grammarOverrideKey(g), builtin, otherPacks: [...others] })
    }
  })
  return out
}

export function issueText(i: ExtPackIssue, locale: ExtLocale): string {
  return locale === 'en-US' ? i.message.en || i.message.zh : i.message.zh
}
