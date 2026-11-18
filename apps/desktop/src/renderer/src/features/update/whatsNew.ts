// 更新后的「更新内容」（GitHub #13，docs/release-update.md §8）：说明就是发布时写的 .github/release-notes/v<版本>.md，
// 打包进界面，不用联网。跳过了几个版本时，把中间每一版的说明都列出来（新的在前）。
import { useSyncExternalStore } from 'react'
import { isNewerVersion } from '@pixelsky/protocol'
import type { WhatsNew, WhatsNewPatch, WhatsNewState } from '../../../../shared/types/app-info'

const files = import.meta.glob<string>('../../../../../../../.github/release-notes/v*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
})

/** 说明里「（GitHub #12）」点开的地址 */
export const issueUrl = (n: number): string => `https://github.com/xiaoheoxo/Pixel-Starry-Sky-Desktop/issues/${n}`

export interface VersionNotes {
  version: string
  text: string
}

/** 文件名 → 版本号（v0.2.1-beta.md → 0.2.1-beta） */
export const RELEASE_NOTES: Record<string, string> = Object.fromEntries(
  Object.entries(files).map(([path, text]) => [path.replace(/^.*\/v(.+)\.md$/, '$1'), text.trim()]),
)

/** 版本 a 比 b 新：先按数字比，数字一样时正式版比测试版新、再按后缀比 */
function newer(a: string, b: string): boolean {
  if (isNewerVersion(a, b)) return true
  if (isNewerVersion(b, a)) return false
  const sa = a.split('-').slice(1).join('-'),
    sb = b.split('-').slice(1).join('-')
  if (!sa || !sb) return !sa && !!sb
  return sa.localeCompare(sb, 'en', { numeric: true }) > 0
}

const byNewest = (a: string, b: string): number => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0)

/** 这次要列哪几版的说明：比上次运行的新、不比当前新；不知道上次是哪版时只列当前这版 */
export function notesFor(
  { version, previous }: WhatsNew,
  notes: Record<string, string> = RELEASE_NOTES,
): VersionNotes[] {
  const versions = Object.keys(notes).filter(v => (previous ? newer(v, previous) && !newer(v, version) : v === version))
  return versions.sort(byNewest).map(v => ({ version: v, text: notes[v] }))
}

/** 更早的版本：比这次列出的都旧的各版说明（新的在前），弹窗底下折叠着，点开能翻 */
export function olderNotes(
  { version, previous }: WhatsNew,
  notes: Record<string, string> = RELEASE_NOTES,
): VersionNotes[] {
  const floor = previous ?? version
  return Object.keys(notes)
    .filter(v => (previous ? !newer(v, floor) : newer(floor, v)))
    .sort(byNewest)
    .map(v => ({ version: v, text: notes[v] }))
}

// ---- 说明的结构：## 分组（新功能 / 改动 / 修复），每组若干条；条目开头的 **加粗** 是标题 ----

/** highlight：「亮点」，这一版最值得看的几条，弹窗里排最前、做成卡片，不计入条数 */
export type SectionKind = 'highlight' | 'feature' | 'change' | 'fix' | 'other'

export interface NoteItem {
  /** 开头加粗的那句，没有时省略 */
  title?: string
  /** 其余的 Markdown（可以带缩进的子列表） */
  body: string
  /** 写在末尾的「（GitHub #12）」 */
  issues: number[]
}

export interface NoteSection {
  kind: SectionKind
  heading: string
  items: NoteItem[]
}

const KINDS: [RegExp, SectionKind][] = [
  [/亮点|重点|highlight/i, 'highlight'],
  [/新功能|新增|feature|new/i, 'feature'],
  [/改动|变更|change/i, 'change'],
  [/修复|fix/i, 'fix'],
]

const ISSUES = /\s*[（(]GitHub\s*((?:#\d+[\s、,，]*)+)[）)]/gi

function noteItem(raw: string): NoteItem {
  const issues: number[] = []
  const text = raw
    .replace(ISSUES, (_, refs: string) => {
      for (const n of refs.match(/\d+/g) ?? []) if (!issues.includes(Number(n))) issues.push(Number(n))
      return ''
    })
    .trim()
  const lead = /^\*\*(.+?)\*\*\s*[：:]?\s*/.exec(text)
  if (!lead) return { body: text, issues }
  return { title: lead[1].replace(/[：:]$/, ''), body: text.slice(lead[0].length).trim(), issues }
}

/** 把一版的 Markdown 说明拆成分组和条目；不是列表的段落各算一条 */
export function parseNotes(text: string): NoteSection[] {
  const sections: NoteSection[] = []
  let section: NoteSection | null = null
  let item: string[] | null = null
  const flush = (): void => {
    if (item && section) {
      const raw = item.join('\n').trim()
      if (raw) section.items.push(noteItem(raw))
    }
    item = null
  }
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flush()
      const title = heading[1]
      section = { kind: KINDS.find(([re]) => re.test(title))?.[1] ?? 'other', heading: title, items: [] }
      sections.push(section)
      continue
    }
    if (!section) {
      if (!line.trim()) continue
      section = { kind: 'other', heading: '', items: [] }
      sections.push(section)
    }
    if (/^[-*]\s+/.test(line)) {
      flush()
      item = [line.replace(/^[-*]\s+/, '')]
    } else if (!line.trim()) {
      if (item) item.push('')
    } else if (item && (/^\s/.test(line) || item.at(-1) !== '')) {
      // 缩进的（子列表）和紧跟着的行接在这一条里；空行后不缩进的另起一条
      item.push(line.replace(/^ {2}/, ''))
    } else {
      flush()
      item = [line]
    }
  }
  flush()
  return sections.filter(s => s.items.length)
}

/** 各组有几条：弹窗顶上和折叠的版本行里显示（「亮点」是从各组里挑的，不算） */
export function countKinds(sections: NoteSection[]): Partial<Record<SectionKind, number>> {
  const counts: Partial<Record<SectionKind, number>> = {}
  for (const s of sections) if (s.kind !== 'highlight') counts[s.kind] = (counts[s.kind] ?? 0) + s.items.length
  return counts
}

// ---- 状态：启动时问一次主进程；关于页能手动再打开 ----

/** manual：从关于页手动打开的（不显示「不再提示」） */
let state: { open: WhatsNew | null; manual: boolean; muted: boolean } = { open: null, manual: false, muted: false }
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(listener => listener())
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
let started = false

export function startWhatsNew(): void {
  if (started || !window.pixelsky?.app) return
  started = true
  void window.pixelsky.app.whatsNew().then(
    (s: WhatsNewState) => {
      // 这一版没写说明（例如自己打的包）就不弹，也记成看过
      const open = s.pending && notesFor(s.pending).length ? s.pending : null
      if (s.pending && !open) void window.pixelsky?.app.setWhatsNew({ seen: true, via: 'noNotes' })
      state = { open, manual: false, muted: s.muted }
      emit()
    },
    () => undefined,
  )
}

/** 当前页面在哪个窗口：写进日志，分得清是主窗口还是独立设置窗口（?view=settings）里点的 */
const from: NonNullable<WhatsNewPatch['from']> =
  typeof location !== 'undefined' && new URLSearchParams(location.search).get('view') === 'settings'
    ? 'settingsWindow'
    : 'main'

/** 弹窗真的画出来了（WhatsNewDialog 挂上时调）：和主进程的「更新内容状态」「更新内容已关」对着看 */
export function noteWhatsNewShown(open: WhatsNew, manual: boolean, notes: number): void {
  window.pixelsky?.log?.write('info', '更新内容弹出', {
    version: open.version,
    previous: open.previous,
    manual,
    notes,
    from,
  })
}

export const whatsNewActions = {
  /** 关于页「本版更新内容」 */
  show(version: string): void {
    window.pixelsky?.log?.write('info', '点了本版更新内容', { version, from })
    state = { ...state, open: { version, previous: null }, manual: true }
    emit()
  },
  /** 关掉弹窗：这一版记成看过；mute 为 true 时以后不再弹；via 是怎么关的（只写日志） */
  close(mute: boolean, via: NonNullable<WhatsNewPatch['via']>): void {
    state = { open: null, manual: false, muted: mute || state.muted }
    emit()
    void window.pixelsky?.app.setWhatsNew(mute ? { seen: true, muted: true, via } : { seen: true, via })
  },
  setMuted(muted: boolean): void {
    state = { ...state, muted }
    emit()
    void window.pixelsky?.app.setWhatsNew({ muted, from })
  },
}

export const useWhatsNew = () => useSyncExternalStore(subscribe, () => state)
