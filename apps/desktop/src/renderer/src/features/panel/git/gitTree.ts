// Git 面板「更改」页的分组、筛选、排序（docs/ui/git-panel.md §10、§10.1）：纯函数，界面在 GitChanges.tsx。
// 四个组（冲突 / 暂存 / 更改 / 未跟踪）不变，每组里按目录排成树、按模块分开，或者平铺。
import type { GitArea, GitCode, GitFileChange, GitModule } from '../../../../../shared/types/project-tools'

export type GitSort = 'name' | 'status' | 'lines'
/** 查看方式（全局记住）：分组依据可以同时勾；都不勾是平铺 */
export interface GitViewPrefs {
  dir: boolean
  mod: boolean
  sort: GitSort
  /** 显示改动行数（要多跑 git diff --numstat） */
  stats: boolean
  icons: boolean
  /** 一路只有一个子文件夹的合并成一行 */
  compact: boolean
}
export const DEFAULT_GIT_VIEW: GitViewPrefs = {
  dir: true,
  mod: false,
  sort: 'name',
  stats: true,
  icons: true,
  compact: true,
}

/** 存着的查看方式（可能是旧版本、被手改过）：逐项检查，不认识的用默认 */
export function gitViewPrefs(raw: unknown): GitViewPrefs {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const bool = (k: keyof GitViewPrefs) => (typeof v[k] === 'boolean' ? (v[k] as boolean) : DEFAULT_GIT_VIEW[k])
  return {
    dir: bool('dir') as boolean,
    mod: bool('mod') as boolean,
    sort: v.sort === 'status' || v.sort === 'lines' ? v.sort : 'name',
    stats: bool('stats') as boolean,
    icons: bool('icons') as boolean,
    compact: bool('compact') as boolean,
  }
}

// ---------------------------------------------------------------------------
// 筛选
// ---------------------------------------------------------------------------

export type GitStatusFilter = 'all' | 'modified' | 'added' | 'deleted'
/** 只看某个文件夹 / 模块（右键「只看这个」） */
export interface GitFocus {
  kind: 'folder' | 'module'
  /** 相对仓库根；根模块是 '' */
  path: string
  label: string
}
export interface GitFilter {
  text: string
  status: GitStatusFilter
  focus: GitFocus | null
}
export const NO_FILTER: GitFilter = { text: '', status: 'all', focus: null }
export const filterActive = (f: GitFilter): boolean => !!f.text.trim() || f.status !== 'all' || !!f.focus

/** 状态字母属于哪一类；冲突（U）只在「全部」里 */
export function statusKind(code: GitCode): Exclude<GitStatusFilter, 'all'> | null {
  if (code === 'A' || code === '?') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'U') return null
  return 'modified'
}

export function statusCounts(files: readonly GitFileChange[]): Record<GitStatusFilter, number> {
  const counts = { all: files.length, modified: 0, added: 0, deleted: 0 }
  for (const f of files) {
    const k = statusKind(f.code)
    if (k) counts[k]++
  }
  return counts
}

/** 仓库里的模块加上根模块（清单里没有根时用仓库文件夹名），按路径排序 */
export function withRootModule(modules: readonly GitModule[], rootName: string): GitModule[] {
  const list = modules.some(m => m.dir === '') ? [...modules] : [{ dir: '', name: rootName, kind: '' }, ...modules]
  return list.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}

/** 文件属于哪个模块：路径最长的那个前缀；modules 要含根模块 */
export function moduleOf(path: string, modules: readonly GitModule[]): GitModule {
  let best: GitModule | null = null
  for (const m of modules)
    if ((!m.dir || path.startsWith(m.dir + '/')) && (!best || m.dir.length > best.dir.length)) best = m
  return best ?? { dir: '', name: '', kind: '' }
}

export function filterFiles(
  files: readonly GitFileChange[],
  filter: GitFilter,
  modules: readonly GitModule[],
): GitFileChange[] {
  const text = filter.text.trim().toLowerCase()
  const focus = filter.focus
  return files.filter(
    f =>
      (!text || f.path.toLowerCase().includes(text)) &&
      (filter.status === 'all' || statusKind(f.code) === filter.status) &&
      (!focus ||
        (focus.kind === 'folder' ? f.path.startsWith(focus.path + '/') : moduleOf(f.path, modules).dir === focus.path)),
  )
}

/** 名字里匹配筛选字的段（不分大小写，所有出现的地方） */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase()
  if (!q) return [{ text, hit: false }]
  const out: { text: string; hit: boolean }[] = []
  const lower = text.toLowerCase()
  let at = 0
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    if (i > at) out.push({ text: text.slice(at, i), hit: false })
    out.push({ text: text.slice(i, i + q.length), hit: true })
    at = i + q.length
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false })
  return out
}

// ---------------------------------------------------------------------------
// 行数、排序
// ---------------------------------------------------------------------------

export interface GitStats {
  insertions: number
  deletions: number
}
/** 合计增删行数；一个都没有（未跟踪、二进制、没开行数）时是 null */
export function sumStats(files: readonly GitFileChange[]): GitStats | null {
  let insertions = 0,
    deletions = 0,
    known = false
  for (const f of files) {
    if (typeof f.insertions !== 'number' && typeof f.deletions !== 'number') continue
    known = true
    insertions += f.insertions ?? 0
    deletions += f.deletions ?? 0
  }
  return known ? { insertions, deletions } : null
}
const lines = (files: readonly GitFileChange[]): number => {
  const s = sumStats(files)
  return s ? s.insertions + s.deletions : 0
}

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const dirName = (path: string): string => {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
/** 改动类型的先后：冲突、删除、修改、新增 */
const RANK: Record<GitCode, number> = { U: 0, D: 1, M: 2, R: 2, C: 2, T: 2, A: 3, '?': 3 }

/** 文件排序；flat 为真（平铺）时名称排序按完整路径，和以前一样 */
export function sortFiles(files: readonly GitFileChange[], sort: GitSort, flat = false): GitFileChange[] {
  const name = flat
    ? (a: GitFileChange, b: GitFileChange) => byText(a.path, b.path)
    : (a: GitFileChange, b: GitFileChange) => byText(baseName(a.path), baseName(b.path)) || byText(a.path, b.path)
  return [...files].sort(
    sort === 'status'
      ? (a, b) => RANK[a.code] - RANK[b.code] || name(a, b)
      : sort === 'lines'
        ? (a, b) => lines([b]) - lines([a]) || name(a, b)
        : name,
  )
}

// ---------------------------------------------------------------------------
// 行
// ---------------------------------------------------------------------------

/** 超过这么多文件的文件夹默认收起（点开后记住） */
export const AUTO_COLLAPSE = 30
/** 构建输出：没被忽略时文件夹旁边出「忽略」 */
export const BUILD_DIRS: ReadonlySet<string> = new Set([
  'build',
  'dist',
  'out',
  'target',
  'coverage',
  '.dart_tool',
  'node_modules',
  '.next',
  '.gradle',
  '__pycache__',
])

export const rowKey = {
  file: (area: GitArea, path: string): string => `f|${area}|${path}`,
  folder: (area: GitArea, path: string): string => `d|${area}|${path}`,
  module: (area: GitArea, dir: string): string => `m|${area}|${dir}`,
}

export interface GitFileRow {
  type: 'file'
  key: string
  area: GitArea
  file: GitFileChange
  depth: number
  /** 平铺、只按模块时文件后面浅色的目录；树里是 null */
  dir: string | null
  /** 「更改」里这个文件还有已暂存的改动 */
  partial: boolean
}
export interface GitGroupRow {
  type: 'group'
  key: string
  area: GitArea
  group: 'folder' | 'module'
  /** 显示的名字：文件夹是（合并后的）相对上一层的路径，模块是模块名 */
  label: string
  /** 相对仓库根；根模块是 '' */
  path: string
  depth: number
  files: GitFileChange[]
  collapsed: boolean
  /** 因为文件多默认收起的（没点过） */
  auto: boolean
  /** 未跟踪的构建输出：建议加进 .gitignore 的路径 */
  ignore: string | null
  module: GitModule | null
}
export type GitRow = GitFileRow | GitGroupRow

export interface GitRowOptions {
  view: GitViewPrefs
  /** 含根模块（withRootModule） */
  modules: readonly GitModule[]
  collapsed: ReadonlySet<string>
  expanded: ReadonlySet<string>
  /** 正在按文字筛：全部展开 */
  filtering: boolean
  /** 已暂存的路径（标「部分已暂存」） */
  staged: ReadonlySet<string>
}

interface Node {
  folders: Map<string, Node>
  files: GitFileChange[]
  all: GitFileChange[]
}
function build(files: readonly GitFileChange[], base: string): Node {
  const root: Node = { folders: new Map(), files: [], all: [] }
  for (const f of files) {
    const rel = base ? f.path.slice(base.length + 1) : f.path
    const parts = rel.split('/')
    let node = root
    node.all.push(f)
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part)
      if (!next) node.folders.set(part, (next = { folders: new Map(), files: [], all: [] }))
      node = next
      node.all.push(f)
    }
    node.files.push(f)
  }
  return root
}

/** 这一行（含合并进来的几层）里有构建输出文件夹：建议忽略到那一层 */
function ignoreTarget(path: string, label: string): string | null {
  const segs = path.split('/')
  const first = segs.length - label.split('/').length
  const at = segs.findIndex((s, i) => i >= first && BUILD_DIRS.has(s))
  return at < 0 ? null : segs.slice(0, at + 1).join('/')
}

/** 一组（一个 area）的行：平铺、目录树、按模块，或者模块里再排成树 */
export function gitRows(area: GitArea, files: readonly GitFileChange[], o: GitRowOptions): GitRow[] {
  const out: GitRow[] = []
  const fileRow = (file: GitFileChange, depth: number, dir: string | null) =>
    out.push({
      type: 'file',
      key: rowKey.file(area, file.path),
      area,
      file,
      depth,
      dir,
      partial: area === 'unstaged' && o.staged.has(file.path),
    })
  const state = (key: string, n: number, auto: boolean) => {
    if (o.filtering) return { collapsed: false, auto: false }
    if (o.collapsed.has(key)) return { collapsed: true, auto: false }
    const big = auto && n > AUTO_COLLAPSE && !o.expanded.has(key)
    return { collapsed: big, auto: big }
  }
  const walk = (node: Node, depth: number, prefix: string) => {
    const folders = [...node.folders.entries()].sort(
      o.view.sort === 'lines'
        ? (a, b) => lines(b[1].all) - lines(a[1].all) || byText(a[0], b[0])
        : (a, b) => byText(a[0], b[0]),
    )
    for (const [name, first] of folders) {
      let label = name,
        child = first
      while (o.view.compact && !child.files.length && child.folders.size === 1) {
        const [next, node] = child.folders.entries().next().value as [string, Node]
        label += '/' + next
        child = node
      }
      const path = prefix ? prefix + '/' + label : label
      const key = rowKey.folder(area, path)
      const { collapsed, auto } = state(key, child.all.length, true)
      out.push({
        type: 'group',
        key,
        area,
        group: 'folder',
        label,
        path,
        depth,
        files: child.all,
        collapsed,
        auto,
        ignore: area === 'untracked' ? ignoreTarget(path, label) : null,
        module: null,
      })
      if (!collapsed) walk(child, depth + 1, path)
    }
    for (const f of sortFiles(node.files, o.view.sort)) fileRow(f, depth, null)
  }

  if (!o.view.dir && !o.view.mod) {
    for (const f of sortFiles(files, o.view.sort, true)) fileRow(f, 0, dirName(f.path))
    return out
  }
  // 整个仓库只有一个模块时不画模块这一层
  if (!o.view.mod || o.modules.length < 2) {
    walk(build(files, ''), 0, '')
    return out
  }
  const groups = new Map<string, { module: GitModule; files: GitFileChange[] }>()
  for (const f of files) {
    const m = moduleOf(f.path, o.modules)
    let g = groups.get(m.dir)
    if (!g) groups.set(m.dir, (g = { module: m, files: [] }))
    g.files.push(f)
  }
  const ordered = [...groups.values()].sort(
    o.view.sort === 'lines'
      ? (a, b) => lines(b.files) - lines(a.files) || byText(a.module.dir, b.module.dir)
      : (a, b) => byText(a.module.dir, b.module.dir),
  )
  for (const { module, files: list } of ordered) {
    const key = rowKey.module(area, module.dir)
    const { collapsed } = state(key, list.length, false)
    out.push({
      type: 'group',
      key,
      area,
      group: 'module',
      label: module.name,
      path: module.dir,
      depth: 0,
      files: list,
      collapsed,
      auto: false,
      ignore: null,
      module,
    })
    if (collapsed) continue
    if (o.view.dir) walk(build(list, module.dir), 1, module.dir)
    else
      for (const f of sortFiles(list, o.view.sort))
        fileRow(f, 1, dirName(module.dir ? f.path.slice(module.dir.length + 1) : f.path))
  }
  return out
}

/** 包含这个文件的分组行的键（定位当前文件时把它们都展开）：各级文件夹 + 所在模块 */
export function ancestorKeys(area: GitArea, path: string, modules: readonly GitModule[]): string[] {
  const keys: string[] = []
  const segs = path.split('/')
  for (let i = 1; i < segs.length; i++) keys.push(rowKey.folder(area, segs.slice(0, i).join('/')))
  keys.push(rowKey.module(area, moduleOf(path, modules).dir))
  return keys
}

/** 文件夹在工作区里的路径（在文件树中显示用）：从它下面一个文件的 local 推出来；文件不在工作区里时是 null */
export function folderLocal(file: GitFileChange, folder: string): string | null {
  if (file.local === null || !folder) return null
  const tail = file.path.length - folder.length
  return tail > 0 && file.local.length > tail ? file.local.slice(0, file.local.length - tail) : null
}
