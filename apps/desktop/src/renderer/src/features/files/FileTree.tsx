import { translateMessage } from '../../i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import {
  ChevronRight,
  FileClock,
  FilePlus,
  FolderPlus,
  FolderInput,
  RefreshCw,
  ChevronsDownUp,
  MoreHorizontal,
  Search,
  Copy,
  ExternalLink,
  Pencil,
  Trash2,
  MessageSquareShare,
  Scissors,
  ClipboardPaste,
} from 'lucide-react'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { IconButton, Spinner, cn, useToast } from '@/ui'
import { useEngineState } from '@/features/engine'
import { isDemo, projects as demoProjects } from '@/data'
import { useActiveWorkspace } from '@/features/editor/target'
import { useMinimal } from '@/features/appearance/ThemeProvider'
import {
  FILE_SAVED_EVENT,
  OPEN_FILES_EVENT,
  dirtyFile,
  displacedDirtyFiles,
  openFile,
  openFilesUnder,
  removeFile,
  renameOpenFiles,
  useFiles,
} from './store'
import type { DirectoryListing, FileEntry, WorkspaceRef } from '../../../../shared/types/workspace'
import type { ProjectFolder } from '@pixelsky/protocol'
import { demo } from '@/data/demo'
import { requestFileHistory } from '@/features/panel/git/fileHistory'
import { sendPathToChat } from './sendPath'
import { cutPasteKeys, dropTarget, hasFileDrag, join2, movedPath, parentOf, refKey, writeDragData } from './treeDrag'
import type { DragOver, DragSource } from './treeDrag'
import { REVEAL_FOLDER_EVENT, takeFolderReveal } from './treeReveal'
import { FileIcon } from './icons/FileIcon'
import { isHidingIgnored, isIgnoredPath, setHideIgnored, splitStatuses, useHideIgnoredMap } from './ignored'
const pathKey = (path: string): string => {
  const p = path.replaceAll('\\', '/').replace(/\/$/, '')
  return window.pixelsky?.platform === 'win32' ? p.toLowerCase() : p
}

/** 磁盘上 to 还在不在（看它所在文件夹的列表）；读不到、列表截断了没找到都按不在算 */
async function destinationExists(ref: WorkspaceRef, to: string): Promise<boolean> {
  const listing = await window.pixelsky!.files.listExisting(ref, parentOf(to)).catch(() => null)
  const name = to.split('/').pop() ?? to
  const same = (a: string): boolean =>
    window.pixelsky?.platform === 'win32' ? a.toLowerCase() === name.toLowerCase() : a === name
  return !!listing?.entries.some(entry => same(entry.name))
}

const TreeExpansion = createContext({ version: 0, expanded: false })
/** 状态上色方式：default 只有字母着色（原样）；vscode 文件名也上色，目录名后加小点（代码模式） */
export type FileTreeStatusColors = 'default' | 'vscode'
const TreeColors = createContext<FileTreeStatusColors>('default')
/**
 * 被 .gitignore 忽略的路径（变暗）、这棵树是否隐藏它们、以及这次被定位到而暂时露出来的路径（目标和它的上级）。
 * 每个 ProjectRoot 提供自己的；附加文件夹（::N/…）的行用同一份
 */
interface IgnoredInfo {
  ignored: ReadonlySet<string>
  hide: boolean
  exempt: ReadonlySet<string>
}
const NO_PATHS: ReadonlySet<string> = new Set()
const TreeIgnored = createContext<IgnoredInfo>({ ignored: NO_PATHS, hide: false, exempt: NO_PATHS })
const hiddenByIgnore = (info: IgnoredInfo, path: string): boolean =>
  info.hide && isIgnoredPath(path, info.ignored) && !info.exempt.has(path)
/** 状态字母的颜色：M 黄、A 和 ? 绿、D 和 ! 红 */
const statusTone = (status: string): string =>
  status === 'M' ? 'text-warn' : status === 'D' || status === '!' ? 'text-danger' : 'text-success'
/** 在项目根目录新建时，让折叠的 ProjectRoot 展开（detail 是 refKey） */
const EXPAND_ROOT_EVENT = 'pixelsky:file-tree-expand-root'
/** 移动后展开目标文件夹（detail 是 { key: refKey, path }） */
const EXPAND_FOLDER_EVENT = 'pixelsky:file-tree-expand-folder'
/**
 * 移动 / 粘贴后要展开的目标文件夹（「项目 key + 换行 + 路径」）。移动后整棵树重新读目录、行会重新挂载，
 * 只发展开事件的话新挂载的行收不到；行挂载时看这里，自己或子孙在里面就展开（自己那条用掉就删）
 */
const pendingExpand = new Set<string>()
/** 要滚进可视区的那一行（「项目 key + 换行 + 路径」），对话里的文件夹链接用（treeReveal.ts） */
let pendingScroll: string | null = null
function takePendingExpand(ref: WorkspaceRef, path: string): boolean {
  const prefix = refKey(ref) + '\n'
  let hit = false
  for (const item of pendingExpand) {
    if (!item.startsWith(prefix)) continue
    const target = item.slice(prefix.length)
    if (target === path) {
      pendingExpand.delete(item)
      hit = true
    } else if (target.startsWith(path + '/')) hit = true
  }
  return hit
}
/** 停在折叠文件夹上多久自动展开 */
const HOVER_EXPAND_MS = 600
/** 列表上下边缘多少像素内自动滚动 */
const SCROLL_EDGE = 24
/** 目标文件夹那一行 / 它展开的子项整块的样式 */
const DROP_ROW = 'bg-accent/10 outline outline-1 -outline-offset-1 outline-accent/40'
const DROP_BLOCK = 'rounded-md bg-accent/5 outline outline-1 -outline-offset-1 outline-accent/30'
const dropKeyOf = (ref: WorkspaceRef, folder: string): string => `${refKey(ref)}\0${folder}`

// 新建 / 重命名 / 删除（docs/ui/files-search-terminal-pins.md §3）
const NAME_OK = (name: string): boolean => !!name && !/[\\/:*?"<>|]/.test(name) && !/[ .]$/.test(name)
interface EditState {
  mode: 'file' | 'folder' | 'rename'
  ref: WorkspaceRef
  /** 新建时是所在文件夹；重命名时是原路径的上级 */
  parent: string
  /** 重命名的原路径 */
  path?: string
}
interface TreeOpsValue {
  editing: EditState | null
  edit(next: EditState | null): void
  submit(name: string): Promise<void>
  remove(ref: WorkspaceRef, entry: FileEntry): void
  /** 正在拖的那一项（拖动状态只在这里存一份） */
  drag: DragSource | null
  /** 当前高亮的目标文件夹（dropKeyOf） */
  dropKey: string | null
  startDrag(source: DragSource): void
  endDrag(): void
  hover(key: string | null): void
  /** 移动成功返回 true（拖动放下、粘贴共用） */
  move(source: DragSource, folder: string): Promise<boolean>
  /** 剪切的那一项（docs/ui/file-tree-drag-move.md：拖动之外的键盘 / 右键做法），粘贴后清掉 */
  cut: DragSource | null
  setCut(source: DragSource | null): void
  /** 粘贴到这里：和拖动放下同一套规则（dropTarget）、同一个移动和撤销 */
  paste(over: DragOver): void
}
const TreeOps = createContext<TreeOpsValue>({
  editing: null,
  edit: () => {},
  submit: async () => {},
  remove: () => {},
  drag: null,
  dropKey: null,
  startDrag: () => {},
  endDrag: () => {},
  hover: () => {},
  move: async () => false,
  cut: null,
  setCut: () => {},
  paste: () => {},
})

/** 右键菜单的「粘贴到这里」：有剪切的东西才出现，这里放不下时灰掉并说明 */
function pasteAction(ops: TreeOpsValue, over: DragOver): MenuAction[] {
  if (!ops.cut) return []
  const ok = !!dropTarget(ops.cut, over)
  return [
    {
      label: tr('workspace.pasteHere', { name: ops.cut.name }),
      icon: ClipboardPaste,
      disabled: !ok,
      title: ok ? undefined : tr('workspace.cannotPasteHere'),
      run: () => ops.paste(over),
    },
  ]
}

/** 一个可以放下的位置：算出目标文件夹、更新高亮、悬停展开、放下时移动；over 为 null 表示这里不接收 */
function useDropProps(ops: TreeOpsValue, over: DragOver | null, expand?: () => void) {
  const timer = useRef<number | undefined>(undefined)
  const clear = (): void => {
    window.clearTimeout(timer.current)
    timer.current = undefined
  }
  useEffect(() => clear, [])
  // 拖动结束（放下、取消）后不再等着展开
  useEffect(() => {
    if (!ops.drag) clear()
  }, [ops.drag])
  const target = ops.drag && over ? dropTarget(ops.drag, over) : null
  const mine = !!ops.drag && !!over
  return {
    'data-drop-target': target ? target.folder : undefined,
    onDragOver: (e: DragEvent) => {
      if (!mine || !hasFileDrag(e.dataTransfer)) return
      // 不管能不能放都不再往外层冒泡，否则外层（树下方空白处）会把它当成放到根目录
      e.stopPropagation()
      if (!target) {
        e.dataTransfer.dropEffect = 'none'
        clear()
        ops.hover(null)
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      ops.hover(dropKeyOf(ops.drag!.ref, target.folder))
    },
    onDragEnter: (e: DragEvent) => {
      if (mine && expand && !timer.current && hasFileDrag(e.dataTransfer))
        timer.current = window.setTimeout(() => {
          timer.current = undefined
          expand()
        }, HOVER_EXPAND_MS)
    },
    onDragLeave: (e: DragEvent) => {
      // 在行内的子元素之间移动也会触发，只有真的离开这一行才算
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      clear()
    },
    onDrop: (e: DragEvent) => {
      if (!mine || !hasFileDrag(e.dataTransfer)) return
      e.stopPropagation()
      e.preventDefault()
      clear()
      if (target) void ops.move(ops.drag!, target.folder)
      else ops.endDrag()
    },
  }
}

/** 树里就地输入名称：回车确认，Esc 或离开取消；出错时留在输入框并显示原因 */
function NameInput({ initial, depth, folder }: { initial: string; depth: number; folder: boolean }) {
  const ops = useContext(TreeOps)
  const [value, setValue] = useState(initial),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    // 重命名文件时只选中扩展名前面的部分
    const dot = folder ? -1 : initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [folder, initial])
  const commit = async (): Promise<void> => {
    const name = value.trim()
    if (name === initial && initial) return ops.edit(null)
    if (!NAME_OK(name)) return setError(tr('errors.files.invalidName'))
    setBusy(true)
    try {
      await ops.submit(name)
    } catch (e) {
      setError(translateMessage((e as Error).message))
      setBusy(false)
      input.current?.focus()
    }
  }
  return (
    <div style={{ paddingLeft: 10 + Math.min(depth, 20) * 12 }} className="pr-2">
      <div className="flex min-h-7 items-center gap-1.5">
        <ChevronRight size={12} className="invisible shrink-0" />
        <FileIcon name={initial} kind={folder ? 'directory' : 'file'} />
        <input
          ref={input}
          value={value}
          disabled={busy}
          aria-label={tr(folder ? 'workspace.folderName' : 'workspace.fileName')}
          aria-invalid={!!error}
          onChange={e => {
            setValue(e.target.value)
            setError('')
          }}
          onKeyDown={e => {
            e.stopPropagation()
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') {
              e.preventDefault()
              void commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              ops.edit(null)
            }
          }}
          onBlur={() => {
            if (!busy && !error) ops.edit(null)
          }}
          className={cn(
            'h-6 min-w-0 flex-1 rounded-sm border bg-surface px-1.5 text-meta text-fg outline-none',
            error ? 'border-danger' : 'border-accent',
          )}
        />
      </div>
      {error && (
        <p role="alert" className="pb-1 pl-8 text-label text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
export function FileTree({
  requested,
  compact = false,
  scoped = false,
  heading = true,
  refreshKey = 0,
  statusColors = 'default',
  statuses: externalStatuses,
}: {
  requested: WorkspaceRef | null
  compact?: boolean
  scoped?: boolean
  /** 顶上写不写「文件」：右侧「文件」标签页里标签已经写了，不再重复（docs/ui/workbench-ux-3.md §2.3） */
  heading?: boolean
  /** 外部触发刷新：和内部的 revision 一起放进读目录和读状态的依赖里 */
  refreshKey?: number
  statusColors?: FileTreeStatusColors
  /** 外部传入的状态表（路径到状态字母）；传了就不再自己去读（演示模式不读状态） */
  statuses?: Record<string, string>
}) {
  useI18n()
  const projects = useEngineState(s => s.projects),
    active = useActiveWorkspace()
  // 极简模式下不写标题时，新建 / 刷新 / 折叠这排按钮并进过滤框那一行（docs/ui/minimal-mode.md §9）
  const merged = useMinimal() && !heading
  const [query, setQuery] = useState(''),
    [revision, setRevision] = useState(0),
    [collapsed, setCollapsed] = useState(0),
    [expandAll, setExpandAll] = useState(false),
    // 标题栏「⋯」菜单（隐藏被忽略的文件）
    [moreMenu, setMoreMenu] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(null)
  const hideMap = useHideIgnoredMap()
  const [requestedTarget, setRequestedTarget] = useState<{ path: string; name: string } | null>(null)
  const source = isDemo ? demoProjects.map(p => ({ id: p.id, name: p.name, path: p.name })) : projects
  useEffect(() => {
    let cancelled = false
    if (!requested || isDemo) {
      setRequestedTarget(null)
      return
    }
    void window.pixelsky!.files.target(requested).then(
      t => {
        if (!cancelled) setRequestedTarget(t)
      },
      () => {
        if (!cancelled) setRequestedTarget(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [requested?.sessionId, requested?.projectId])
  const chosenPath = requestedTarget?.path ?? active.path
  let roots = [...source]
  if (!isDemo && active.ref && active.path && !roots.some(p => pathKey(p.path) === pathKey(active.path)))
    roots.push({ id: 'history', path: active.path, name: active.name })
  if (!isDemo && requestedTarget && requested && !roots.some(p => pathKey(p.path) === pathKey(requestedTarget.path)))
    roots.push({ id: 'requested-history', path: requestedTarget.path, name: requestedTarget.name })
  if (scoped) {
    const ref = requested ?? active.ref
    const project = ref?.projectId ? source.find(p => p.id === ref.projectId) : null
    const resolved =
      project ??
      (requestedTarget
        ? { id: 'requested-history', ...requestedTarget }
        : !requested && active.ref
          ? { id: 'history', name: active.name, path: active.path }
          : isDemo
            ? source.find(p => p.id === ref?.projectId)
            : null)
    roots = resolved ? [resolved] : []
  }
  const rootRef = (project: { id: string }): WorkspaceRef =>
    project.id === 'history' ? active.ref! : project.id === 'requested-history' ? requested! : { projectId: project.id }
  // 新建 / 重命名 / 删除（docs/ui/files-search-terminal-pins.md §3）
  const [editing, setEditing] = useState<EditState | null>(null),
    [deleting, setDeleting] = useState<{ ref: WorkspaceRef; entry: FileEntry } | null>(null),
    [deleteBusy, setDeleteBusy] = useState(false),
    // 改名 / 移动会顶掉目标位置有未保存修改的标签：先问，run 收到确认丢弃的标签 id
    [displacing, setDisplacing] = useState<{
      paths: string[]
      run: (discard: readonly string[]) => Promise<void>
      discard: string[]
    } | null>(null),
    [displaceBusy, setDisplaceBusy] = useState(false),
    [opError, setOpError] = useState('')
  const [drag, setDrag] = useState<DragSource | null>(null),
    [dropKey, setDropKey] = useState<string | null>(null),
    [cut, setCut] = useState<DragSource | null>(null)
  const toast = useToast()
  // 只记最近一次移动；之后有新的移动 / 新建 / 重命名 / 删除就作废
  const lastMove = useRef<{ ref: WorkspaceRef; from: string; to: string } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const refresh = (): void => setRevision(n => n + 1)
  const rev = revision + refreshKey
  const startEdit = (next: EditState | null): void => {
    setOpError('')
    if (next) lastMove.current = null
    if (next && isDemo) return setOpError(tr('workspace.demoCannotModify'))
    // 在折叠的项目里新建时先展开（ProjectRoot 按这个事件展开）
    if (next && next.mode !== 'rename' && !next.parent)
      window.dispatchEvent(new CustomEvent(EXPAND_ROOT_EVENT, { detail: refKey(next.ref) }))
    setEditing(next)
  }
  /**
   * 改名 / 移动 from → to 会顶掉目标位置有未保存修改的标签（外部程序把目标文件移走了、标签还开着）：
   * 弹确认框、返回 true，调用方先不动磁盘；用户确认后 run 带着要丢弃的标签 id 再做一次。没有这种标签返回 false。
   * 目标在磁盘上还在时不问：改名本身会报「已存在」，什么都不会丢
   */
  const askDisplace = async (
    ref: WorkspaceRef,
    from: string,
    to: string,
    run: (discard: readonly string[]) => Promise<void>,
  ): Promise<boolean> => {
    const dirty = displacedDirtyFiles(ref, from, to)
    if (!dirty.length || (await destinationExists(ref, to))) return false
    setOpError('')
    setDisplacing({ paths: dirty.map(tab => tab.path), discard: dirty.map(tab => tab.id), run })
    return true
  }
  const confirmDisplace = async (): Promise<void> => {
    if (!displacing) return
    setDisplaceBusy(true)
    setOpError('')
    try {
      await displacing.run(displacing.discard)
      setDisplacing(null)
    } catch (e) {
      setOpError((e as Error).message)
    } finally {
      setDisplaceBusy(false)
    }
  }
  const submit = async (name: string): Promise<void> => {
    const current = editing
    if (!current) return
    const bridge = window.pixelsky!.files
    lastMove.current = null
    if (current.mode === 'rename') {
      const from = current.path
      if (!from) return
      const to = join2(current.parent, name)
      const rename = async (discard: readonly string[]): Promise<void> => {
        const { path } = await bridge.rename(current.ref, from, to)
        renameOpenFiles(current.ref, from, path, discard)
      }
      if (
        await askDisplace(current.ref, from, to, async discard => {
          await rename(discard)
          refresh()
        })
      )
        return setEditing(null)
      await rename([])
    } else {
      const { path } = await bridge.create(current.ref, join2(current.parent, name), current.mode)
      if (current.mode === 'file') void openFile(current.ref, path).catch(() => {})
    }
    setEditing(null)
    refresh()
  }
  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return
    setDeleteBusy(true)
    setOpError('')
    lastMove.current = null
    try {
      await window.pixelsky!.files.remove(deleting.ref, deleting.entry.path)
      for (const tab of openFilesUnder(deleting.ref, deleting.entry.path)) removeFile(tab.id)
      setDeleting(null)
      refresh()
    } catch (e) {
      setOpError((e as Error).message)
    } finally {
      setDeleteBusy(false)
    }
  }
  const remove = (ref: WorkspaceRef, entry: FileEntry): void => {
    setOpError('')
    if (isDemo) return setOpError(tr('workspace.demoCannotModify'))
    setDeleting({ ref, entry })
  }
  const single = roots.length === 1 ? rootRef(roots[0]) : null
  const expandFolder = (ref: WorkspaceRef, folder: string): void => {
    if (folder) {
      if (pendingExpand.size > 50) pendingExpand.clear()
      pendingExpand.add(refKey(ref) + '\n' + folder)
    }
    window.dispatchEvent(
      new CustomEvent(folder ? EXPAND_FOLDER_EVENT : EXPAND_ROOT_EVENT, {
        detail: folder ? { key: refKey(ref), path: folder } : refKey(ref),
      }),
    )
  }
  // 对话里的文件夹链接：找根目录相同的那棵树，展开项目、再一层层展开到文件夹（行挂上时看 pendingExpand），最后滚过去。
  // 每次渲染重新挂：roots、expandFolder 都是这次渲染算出来的
  useEffect(() => {
    const take = (): void => {
      const want = takeFolderReveal(path => roots.some(p => pathKey(p.path) === pathKey(path)))
      const root = want && roots.find(p => pathKey(p.path) === pathKey(want.root))
      if (!want || !root) return
      const ref = rootRef(root)
      pendingScroll = refKey(ref) + '\n' + want.path
      expandFolder(ref, '')
      expandFolder(ref, want.path)
    }
    take()
    window.addEventListener(REVEAL_FOLDER_EVENT, take)
    return () => window.removeEventListener(REVEAL_FOLDER_EVENT, take)
  })
  const endDrag = (): void => {
    setDrag(null)
    setDropKey(null)
  }
  const undoMove = async (
    record: { ref: WorkspaceRef; from: string; to: string },
    discard?: readonly string[],
  ): Promise<void> => {
    if (lastMove.current !== record)
      return void toast(tr('workspace.undoFailed', { reason: tr('workspace.undoStale') }))
    if (!discard && (await askDisplace(record.ref, record.to, record.from, ids => undoMove(record, ids)))) return
    lastMove.current = null
    try {
      const { path } = await window.pixelsky!.files.rename(record.ref, record.to, record.from)
      renameOpenFiles(record.ref, record.to, path, discard)
      expandFolder(record.ref, parentOf(path))
      refresh()
    } catch (e) {
      toast(tr('workspace.undoFailed', { reason: translateMessage((e as Error).message) }))
    }
  }
  const move = async (source: DragSource, folder: string, discard?: readonly string[]): Promise<boolean> => {
    endDrag()
    setOpError('')
    if (isDemo) {
      setOpError(tr('workspace.demoCannotModify'))
      return false
    }
    const target = movedPath(source, folder)
    if (
      !discard &&
      (await askDisplace(source.ref, source.path, target, async ids => {
        // 确认后移动成功：剪切的那一项也作废（粘贴时）
        if (await move(source, folder, ids)) setCut(current => (current === source ? null : current))
      }))
    )
      return false
    lastMove.current = null
    try {
      const { path } = await window.pixelsky!.files.rename(source.ref, source.path, target)
      renameOpenFiles(source.ref, source.path, path, discard)
      const record = { ref: source.ref, from: source.path, to: path }
      lastMove.current = record
      expandFolder(source.ref, folder)
      refresh()
      toast(
        folder
          ? tr('workspace.moved', { name: source.name, folder })
          : tr('workspace.movedRoot', { name: source.name }),
        {
          action: { label: tr('workspace.undo'), run: () => void undoMove(record) },
        },
      )
      return true
    } catch (e) {
      setOpError((e as Error).message)
      return false
    }
  }
  const paste = (over: DragOver): void => {
    if (!cut) return
    const target = dropTarget(cut, over)
    if (!target) return void toast(tr('workspace.cannotPasteHere'))
    const source = cut
    void move(source, target.folder).then(moved => {
      // 移动成功，或者那一项已经不在了（别处删掉 / 改名），剪切都作废
      if (moved) setCut(current => (current === source ? null : current))
    })
  }
  const treeOps: TreeOpsValue = {
    editing,
    edit: startEdit,
    submit,
    remove,
    drag,
    dropKey,
    startDrag: source => {
      // 拖动开始时取消正在进行的新建 / 重命名输入
      setEditing(null)
      setOpError('')
      setDrag(source)
    },
    endDrag,
    hover: key => setDropKey(key),
    move,
    cut,
    setCut: source => {
      setOpError('')
      setCut(source)
      if (source) toast(tr('workspace.cutDone', { name: source.name }))
    },
    paste,
  }
  // 树下方空白处：只有一个项目时放到根目录
  const blankDrop = useDropProps(treeOps, single ? { ref: single, kind: 'root' } : null)
  // 拖动期间靠近列表上下边缘时自动滚动；拖动结束清理
  const dragging = !!drag
  useEffect(() => {
    const el = scroller.current
    if (!dragging || !el) return
    let y = -1,
      frame = 0
    const over = (e: globalThis.DragEvent): void => {
      y = e.clientY
    }
    const leave = (e: globalThis.DragEvent): void => {
      if (!el.contains(e.relatedTarget as Node | null)) y = -1
    }
    const stop = (): void => setDrag(null)
    const tick = (): void => {
      const r = el.getBoundingClientRect()
      if (y >= r.top && y <= r.bottom) {
        if (y < r.top + SCROLL_EDGE) el.scrollTop -= 4 + ((r.top + SCROLL_EDGE - y) / SCROLL_EDGE) * 10
        else if (y > r.bottom - SCROLL_EDGE) el.scrollTop += 4 + ((y - (r.bottom - SCROLL_EDGE)) / SCROLL_EDGE) * 10
      }
      frame = requestAnimationFrame(tick)
    }
    el.addEventListener('dragover', over, true)
    el.addEventListener('dragleave', leave, true)
    // 源元素被刷新掉时收不到它自己的 dragend，这里兜底
    window.addEventListener('dragend', stop)
    window.addEventListener('drop', stop)
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('dragover', over, true)
      el.removeEventListener('dragleave', leave, true)
      window.removeEventListener('dragend', stop)
      window.removeEventListener('drop', stop)
      setDropKey(null)
    }
  }, [dragging])
  const dirtyCount = deleting ? openFilesUnder(deleting.ref, deleting.entry.path).filter(dirtyFile).length : 0
  const actions = (
    <>
      {single && (
        <>
          <IconButton
            icon={FilePlus}
            size={26}
            iconSize={14}
            label={tr('workspace.newFile')}
            onClick={() => startEdit({ mode: 'file', ref: single, parent: '' })}
          />
          <IconButton
            icon={FolderPlus}
            size={26}
            iconSize={14}
            label={tr('workspace.newFolder')}
            onClick={() => startEdit({ mode: 'folder', ref: single, parent: '' })}
          />
        </>
      )}
      <IconButton
        icon={RefreshCw}
        size={26}
        iconSize={14}
        label={tr('files.FileTree.refreshFilesAndGit')}
        onClick={() => setRevision(n => n + 1)}
      />
      <IconButton
        icon={ChevronsDownUp}
        size={26}
        iconSize={14}
        label={tr(expandAll ? 'workspace.collapseAll' : 'workspace.expandAll')}
        onClick={() => {
          setExpandAll(v => !v)
          setCollapsed(n => n + 1)
        }}
      />
      {roots.length > 0 && (
        <IconButton
          icon={MoreHorizontal}
          size={26}
          iconSize={14}
          label={tr('fileIcons.treeMenu')}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMoreMenu({ x: rect.left, y: rect.bottom + 4, trigger: e.currentTarget })
          }}
        />
      )}
    </>
  )
  return (
    <TreeExpansion.Provider value={{ version: collapsed, expanded: expandAll }}>
      <TreeColors.Provider value={statusColors}>
        <TreeOps.Provider value={treeOps}>
          <div
            data-file-tree
            className={cn(
              'flex min-h-0 flex-1 flex-col',
              compact && 'w-52 shrink-0 flex-none border-r border-line-layout',
            )}
          >
            {!merged && (
              <div data-file-tree-head className="flex h-10 shrink-0 items-center gap-1 px-2">
                <span className="flex-1 px-1 text-ui font-medium text-fg">{heading && tr('files.FileTree.files')}</span>
                <span data-file-tree-actions className="flex shrink-0 items-center gap-1">
                  {actions}
                </span>
              </div>
            )}
            <div className={cn('mx-2 mb-2 flex shrink-0 items-center gap-1', merged && 'mt-1')}>
              <label
                data-file-tree-filter
                className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line bg-subtle px-2"
              >
                <Search size={14} className="shrink-0 text-fg-muted" />
                <input
                  aria-label={tr('files.FileTree.filterFilesByName')}
                  placeholder={tr('files.FileTree.filterFilesByName2')}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-meta text-fg outline-none"
                />
                {query && (
                  <button
                    type="button"
                    aria-label={tr('files.FileTree.clearFileFilter')}
                    onClick={() => setQuery('')}
                    className="text-meta text-fg-muted"
                  >
                    {tr('files.FileTree.clear')}
                  </button>
                )}
              </label>
              {merged && (
                <span data-file-tree-actions className="flex shrink-0 items-center gap-0.5">
                  {actions}
                </span>
              )}
            </div>
            {opError && !deleting && (
              <p role="alert" className="mx-3 mb-2 text-label text-danger">
                {translateMessage(opError)}
              </p>
            )}
            <div
              ref={scroller}
              data-file-tree-scroll
              {...blankDrop}
              onDragLeave={e => {
                blankDrop.onDragLeave(e)
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropKey(null)
              }}
              className="min-h-0 flex-1 overflow-auto pb-3"
            >
              {roots.length ? (
                roots.map(project => (
                  <ProjectRoot
                    key={project.id}
                    name={project.name}
                    folders={(project as { folders?: ProjectFolder[] }).folders}
                    refTarget={rootRef(project)}
                    autoOpen={
                      scoped ||
                      pathKey(project.path) === pathKey(chosenPath) ||
                      (isDemo && (requested?.projectId ?? active.ref?.projectId) === project.id)
                    }
                    query={query}
                    revision={rev}
                    collapsed={collapsed}
                    externalStatuses={externalStatuses}
                    rootPath={project.path}
                  />
                ))
              ) : (
                <p className="px-4 py-6 text-meta text-fg-muted">{tr('files.FileTree.noProjectYetAdd')}</p>
              )}
            </div>
          </div>
          {moreMenu && (
            <ActionMenu
              x={moreMenu.x}
              y={moreMenu.y}
              label={tr('fileIcons.treeMenu')}
              onClose={() => {
                setMoreMenu(null)
                moreMenu.trigger.focus({ preventScroll: true })
              }}
              actions={roots.map(project => {
                const hidden = isHidingIgnored(hideMap, project.path)
                return {
                  label: tr('fileIcons.hideIgnored'),
                  checked: hidden,
                  // 多个根时每个根一组，标题是根的名字
                  section: roots.length > 1 ? project.name : undefined,
                  run: () => setHideIgnored(project.path, !hidden),
                }
              })}
            />
          )}
          {displacing && (
            <ConfirmDialog
              title={tr('workspace.displaceTitle', { count: displacing.paths.length })}
              description={
                <div className="flex flex-col gap-2">
                  <p>{tr('workspace.displaceHint')}</p>
                  <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
                    {displacing.paths.map(path => (
                      <li key={path} className="truncate font-mono text-meta text-fg" title={path}>
                        {path}
                      </li>
                    ))}
                  </ul>
                </div>
              }
              confirmLabel={tr('workspace.displaceConfirm')}
              cancelLabel={tr('workspace.cancel')}
              busy={displaceBusy}
              error={opError ? translateMessage(opError) : null}
              danger
              onConfirm={() => void confirmDisplace()}
              onCancel={() => {
                setDisplacing(null)
                setOpError('')
              }}
            />
          )}
          {deleting && (
            <ConfirmDialog
              title={tr('workspace.deleteTitle', { name: deleting.entry.name })}
              description={
                <div className="flex flex-col gap-2">
                  <p>{tr('workspace.deleteHint')}</p>
                  {dirtyCount > 0 && (
                    <p className="text-danger">{tr('workspace.deleteDirty', { count: dirtyCount })}</p>
                  )}
                </div>
              }
              confirmLabel={deleteBusy ? tr('workspace.deleting') : tr('workspace.deleteEntry')}
              cancelLabel={tr('workspace.cancel')}
              busy={deleteBusy}
              error={opError ? translateMessage(opError) : null}
              danger
              onConfirm={() => void confirmDelete()}
              onCancel={() => {
                setDeleting(null)
                setOpError('')
              }}
            />
          )}
        </TreeOps.Provider>
      </TreeColors.Provider>
    </TreeExpansion.Provider>
  )
}

function ProjectRoot({
  name,
  folders,
  refTarget,
  autoOpen,
  query,
  revision,
  collapsed,
  externalStatuses,
  rootPath,
}: {
  name: string
  /** 多文件夹项目的附加文件夹（docs/ui/multi-root-projects.md §3.4）：主文件夹的内容下面各一行，展开看 */
  folders?: readonly ProjectFolder[]
  refTarget: WorkspaceRef
  autoOpen: boolean
  query: string
  revision: number
  collapsed: number
  externalStatuses?: Record<string, string>
  /** 根目录路径：「隐藏被忽略的文件」按它记，.gitignore 保存时按它认是不是这棵树 */
  rootPath: string
}) {
  useI18n()
  const [expanded, setExpanded] = useState(autoOpen),
    [statusTick, setStatusTick] = useState(0),
    [fetchedStatuses, setStatuses] = useState<Record<string, string>>({}),
    [results, setResults] = useState<DirectoryListing | null>(null),
    [error, setError] = useState(''),
    [searching, setSearching] = useState(false)
  const allStatuses = externalStatuses ?? fetchedStatuses,
    hasExternal = !!externalStatuses
  // 'I' 是被忽略（变暗），不是改动：拆开后改动照旧上色，也不会让文件夹冒出「•」
  const { changes: statuses, ignored } = useMemo(() => splitStatuses(allStatuses), [allStatuses])
  const hide = isHidingIgnored(useHideIgnoredMap(), rootPath)
  // 定位到被隐藏的文件时，目标和它的上级暂时露出来（变暗显示）；切换隐藏开关时清掉
  const [exempt, setExempt] = useState<ReadonlySet<string>>(NO_PATHS)
  useEffect(() => setExempt(prev => (prev.size ? NO_PATHS : prev)), [hide])
  const ignoredInfo = useMemo<IgnoredInfo>(() => ({ ignored, hide, exempt }), [ignored, hide, exempt])
  const expansion = useContext(TreeExpansion),
    ops = useContext(TreeOps)
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(null)
  const initial = useRef(true)
  const headerDrop = useDropProps(ops, { ref: refTarget, kind: 'root' }, expanded ? undefined : () => setExpanded(true))
  useEffect(() => {
    if (autoOpen) setExpanded(true)
  }, [autoOpen])
  const rootKey = refKey(refTarget)
  useEffect(() => {
    const open = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === rootKey) setExpanded(true)
    }
    window.addEventListener(EXPAND_ROOT_EVENT, open)
    return () => window.removeEventListener(EXPAND_ROOT_EVENT, open)
  }, [rootKey])
  const openTabs = useFiles()
  const activeTab = openTabs.tabs.find(t => t.id === openTabs.active)
  const activePath = activeTab && refKey(activeTab.ref) === rootKey ? activeTab.path : null
  useEffect(() => {
    const expose = (path: string | null | undefined): void => {
      if (!path) return
      const paths: string[] = []
      for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) paths.push(path.slice(0, i))
      paths.push(path)
      setExempt(prev => {
        if (paths.every(p => prev.has(p))) return prev
        return new Set([...prev, ...paths])
      })
    }
    expose(activePath)
    const opened = (e: Event): void => {
      const detail = (e as CustomEvent<{ ref?: WorkspaceRef; path?: string }>).detail
      if (!detail?.ref || refKey(detail.ref) === rootKey) expose(detail?.path)
    }
    const expanding = (e: Event): void => {
      const detail = (e as CustomEvent<{ key: string; path: string }>).detail
      if (detail.key === rootKey) expose(detail.path)
    }
    window.addEventListener(OPEN_FILES_EVENT, opened)
    window.addEventListener(EXPAND_FOLDER_EVENT, expanding)
    return () => {
      window.removeEventListener(OPEN_FILES_EVENT, opened)
      window.removeEventListener(EXPAND_FOLDER_EVENT, expanding)
    }
  }, [rootKey, activePath])
  // .gitignore 保存后重新读状态，变暗的范围跟着变
  useEffect(() => {
    const saved = (e: Event): void => {
      const detail = (e as CustomEvent<{ root?: string; path?: string }>).detail
      if (detail?.root && detail.path?.split('/').pop() === '.gitignore' && pathKey(detail.root) === pathKey(rootPath))
        setStatusTick(n => n + 1)
    }
    window.addEventListener(FILE_SAVED_EVENT, saved)
    return () => window.removeEventListener(FILE_SAVED_EVENT, saved)
  }, [rootPath])
  useEffect(() => {
    if (initial.current) initial.current = false
    else setExpanded(expansion.expanded)
  }, [collapsed])
  useEffect(() => {
    let cancelled = false
    if (!expanded || isDemo || externalStatuses) return
    void window.pixelsky!.files.status(refTarget).then(
      s => {
        if (!cancelled) setStatuses(s)
      },
      () => {
        if (!cancelled) setStatuses({})
      },
    )
    return () => {
      cancelled = true
    }
  }, [expanded, revision, statusTick, hasExternal, refTarget.projectId, refTarget.sessionId])
  useEffect(() => {
    let cancelled = false
    setError('')
    setResults(null)
    if (!query.trim() || !expanded) {
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      const result = isDemo
        ? Promise.resolve({
            entries: Object.keys(demo().files.contents)
              .filter(p => p.toLowerCase().includes(query.toLowerCase()))
              .map(path => ({ path, name: path.split('/').pop()!, kind: 'file' as const })),
            truncated: false,
          })
        : window.pixelsky!.files.search(refTarget, query)
      void result.then(
        r => {
          if (!cancelled) {
            setResults(r)
            setSearching(false)
          }
        },
        e => {
          if (!cancelled) {
            setError(e.message)
            setSearching(false)
          }
        },
      )
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, expanded, revision, refTarget.projectId, refTarget.sessionId])
  return (
    <section className="border-t border-line-layout">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={tr('files.FileTree.project', { p0: expanded ? '收起' : '展开', p1: name })}
        onClick={() => setExpanded(v => !v)}
        onContextMenu={e => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, trigger: e.currentTarget })
        }}
        onKeyDown={e => cutPasteKeys(e.nativeEvent, ops, null, { ref: refTarget, kind: 'root' })}
        {...headerDrop}
        className={cn(
          'flex h-9 w-full items-center gap-2 px-3 text-left text-ui text-fg hover:bg-hover',
          ops.dropKey === dropKeyOf(refTarget, '') && DROP_ROW,
        )}
      >
        <ChevronRight
          size={13}
          className={cn('shrink-0 transition-transform duration-(--dur-fast)', expanded && 'rotate-90')}
        />
        <FileIcon name={name} kind="directory" expanded={expanded} root className="text-accent-fg" />
        <span className="truncate font-medium">{name}</span>
      </button>
      <TreeIgnored.Provider value={ignoredInfo}>
        {expanded &&
          (query.trim() ? (
            <div className="px-2 pb-1">
              {searching && (
                <p className="flex items-center gap-2 px-2 py-2 text-meta text-fg-muted">
                  <Spinner size={12} />
                  {tr('files.FileTree.filtering')}
                </p>
              )}
              {error && (
                <p role="status" className="px-2 py-2 text-meta text-danger">
                  {translateMessage(error)}
                </p>
              )}
              {results?.entries
                .filter(e => !hiddenByIgnore(ignoredInfo, e.path))
                .map(e => (
                  <FileRow
                    key={e.path}
                    entry={e}
                    refTarget={refTarget}
                    depth={0}
                    revision={revision}
                    statuses={statuses}
                    showPath
                  />
                ))}
              {results && !results.entries.length && (
                <p className="px-2 py-2 text-meta text-fg-muted">{tr('files.FileTree.noMatchingFiles')}</p>
              )}
              {results?.truncated && (
                <p className="px-2 py-2 text-label text-fg-muted">{tr('files.FileTree.showingPartialResultsNarrow')}</p>
              )}
              <p className="px-2 py-1 text-label text-fg-faint">{tr('files.FileTree.filterByNameSkips')}</p>
            </div>
          ) : (
            <>
              <Directory refTarget={refTarget} path="" depth={0} revision={revision} statuses={statuses} />
              {folders?.map((folder, i) => (
                <ExtraFolder
                  key={folder.path}
                  folder={folder}
                  path={`::${i + 1}`}
                  refTarget={refTarget}
                  revision={revision}
                  statuses={statuses}
                />
              ))}
            </>
          ))}
      </TreeIgnored.Provider>
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={name}
          onClose={() => {
            setMenu(null)
            menu.trigger.focus({ preventScroll: true })
          }}
          actions={[
            {
              label: tr('workspace.newFile'),
              icon: FilePlus,
              run: () => ops.edit({ mode: 'file', ref: refTarget, parent: '' }),
            },
            {
              label: tr('workspace.newFolder'),
              icon: FolderPlus,
              run: () => ops.edit({ mode: 'folder', ref: refTarget, parent: '' }),
            },
            ...pasteAction(ops, { ref: refTarget, kind: 'root' }),
            {
              label: tr('fileIcons.hideIgnored'),
              checked: hide,
              separator: true,
              run: () => setHideIgnored(rootPath, !hide),
            },
          ]}
        />
      )}
    </section>
  )
}

/** 多文件夹项目的一个附加文件夹：一行文件夹名（悬停写完整路径），展开列出它的内容；不能重命名、删除 */
function ExtraFolder({
  folder,
  path,
  refTarget,
  revision,
  statuses,
}: {
  folder: ProjectFolder
  path: string
  refTarget: WorkspaceRef
  revision: number
  statuses: Record<string, string>
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  const name = folder.name || folder.path.split(/[\\/]/).filter(Boolean).pop() || folder.path
  return (
    <div data-extra-folder={path}>
      <button
        type="button"
        aria-expanded={open}
        title={folder.path}
        onClick={() => setOpen(v => !v)}
        className="flex h-7 w-full items-center gap-1.5 border-t border-line-subtle px-3 text-left text-list text-fg hover:bg-hover"
      >
        <ChevronRight
          size={13}
          className={cn('shrink-0 transition-transform duration-(--dur-fast)', open && 'rotate-90')}
        />
        <FolderInput size={14} className="shrink-0 text-accent-fg" />
        <span className="truncate font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-label text-fg-faint">{tr('files.extraFolder')}</span>
      </button>
      {open && <Directory refTarget={refTarget} path={path} depth={0} revision={revision} statuses={statuses} />}
    </div>
  )
}

function Directory({
  refTarget,
  path,
  depth,
  revision,
  statuses,
  linked,
}: {
  refTarget: WorkspaceRef
  path: string
  depth: number
  revision: number
  statuses: Record<string, string>
  linked?: boolean
}) {
  useI18n()
  const ops = useContext(TreeOps),
    { editing } = ops
  // 文件夹里的空隙（空文件夹提示、行与行之间）也算放进这个文件夹
  const drop = useDropProps(
    ops,
    path ? { ref: refTarget, kind: 'directory', path, linked } : { ref: refTarget, kind: 'root' },
  )
  const creating =
    editing && editing.mode !== 'rename' && editing.parent === path && refKey(editing.ref) === refKey(refTarget)
      ? editing
      : null
  const ignoredInfo = useContext(TreeIgnored)
  const [list, setList] = useState<DirectoryListing | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    setList(null)
    setError('')
    const result = isDemo ? Promise.resolve(demo().files.directory(path)) : window.pixelsky!.files.list(refTarget, path)
    void result.then(
      r => {
        if (!cancelled) setList(r)
      },
      e => {
        if (!cancelled) setError(e.message)
      },
    )
    return () => {
      cancelled = true
    }
  }, [path, revision, refTarget.projectId, refTarget.sessionId])
  if (error)
    return (
      <p role="status" className="px-4 py-2 text-meta text-danger">
        {translateMessage(error)}
      </p>
    )
  if (!list)
    return (
      <p className="flex items-center gap-2 px-4 py-2 text-meta text-fg-muted">
        <Spinner size={12} />
        {tr('editor.FileEditor.loadingFile')}
      </p>
    )
  // 隐藏被忽略的文件时，一个文件夹里的内容全被藏起来就按空文件夹显示
  const visible = list.entries.filter(entry => !hiddenByIgnore(ignoredInfo, entry.path))
  return (
    <div {...drop} className={cn(ops.dropKey === dropKeyOf(refTarget, path) && DROP_BLOCK)}>
      {creating && <NameInput key={creating.mode} initial="" depth={depth} folder={creating.mode === 'folder'} />}
      {visible.map(entry => (
        <FileRow
          key={entry.path}
          entry={entry}
          refTarget={refTarget}
          depth={depth}
          revision={revision}
          statuses={statuses}
        />
      ))}
      {!visible.length && !creating && (
        <p className="px-4 py-1 text-meta text-fg-faint">{tr('files.FileTree.emptyFolder')}</p>
      )}
      {list.truncated && (
        <p className="px-4 py-1 text-meta text-fg-muted">{tr('files.FileTree.largeDirectoryShowingFirst')}</p>
      )}
    </div>
  )
}

function FileRow({
  entry,
  refTarget,
  depth,
  revision,
  statuses,
  showPath,
}: {
  entry: FileEntry
  refTarget: WorkspaceRef
  depth: number
  revision: number
  statuses: Record<string, string>
  showPath?: boolean
}) {
  useI18n()
  const expansion = useContext(TreeExpansion)
  const vscode = useContext(TreeColors) === 'vscode'
  const dim = isIgnoredPath(entry.path, useContext(TreeIgnored).ignored)
  const [expanded, setExpanded] = useState(
      () =>
        (expansion.expanded && entry.kind === 'directory' && !entry.linked && depth < 20) ||
        (entry.kind === 'directory' && takePendingExpand(refTarget, entry.path)),
    ),
    [error, setError] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(null)
  useEffect(() => {
    if (expansion.version) setExpanded(expansion.expanded && entry.kind === 'directory' && !entry.linked && depth < 20)
  }, [expansion.version])
  const ops = useContext(TreeOps),
    mine = !!ops.editing && refKey(ops.editing.ref) === refKey(refTarget)
  const renaming = mine && ops.editing!.mode === 'rename' && ops.editing!.path === entry.path
  // 在这个文件夹里新建时先展开它
  const creatingInside = mine && ops.editing!.mode !== 'rename' && ops.editing!.parent === entry.path
  useEffect(() => {
    if (creatingInside) setExpanded(true)
  }, [creatingInside])
  const files = useFiles(),
    active = files.tabs.find(t => t.id === files.active)
  const sameTarget = active?.ref.projectId === refTarget.projectId && active?.ref.sessionId === refTarget.sessionId
  useEffect(() => {
    const reveal = (e: Event): void => {
      const detail = (e as CustomEvent<{ ref?: WorkspaceRef; path?: string }>).detail
      if (
        (!detail.ref ||
          (detail.ref.projectId === refTarget.projectId && detail.ref.sessionId === refTarget.sessionId)) &&
        detail?.path?.startsWith(entry.path + '/') &&
        entry.kind === 'directory'
      )
        setExpanded(true)
    }
    if (sameTarget && entry.kind === 'directory' && active?.path.startsWith(entry.path + '/')) setExpanded(true)
    window.addEventListener(OPEN_FILES_EVENT, reveal)
    return () => window.removeEventListener(OPEN_FILES_EVENT, reveal)
  }, [entry.path, entry.kind, active?.path, sameTarget])
  const targetRoot = useEngineState(s =>
    refTarget.projectId
      ? s.projects.find(p => p.id === refTarget.projectId)?.path
      : refTarget.sessionId
        ? (s.snapshots[refTarget.sessionId]?.record.cwd ??
          s.sessions.find(x => x.record.id === refTarget.sessionId)?.record.cwd)
        : undefined,
  )
  const sameRef =
    (active?.ref.projectId === refTarget.projectId && active?.ref.sessionId === refTarget.sessionId) ||
    (!!active?.root && !!targetRoot && pathKey(active.root) === pathKey(targetRoot))
  const status =
    statuses[entry.path] ??
    (entry.kind === 'directory' && Object.keys(statuses).some(p => p.startsWith(entry.path + '/')) ? '•' : '')
  const row = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = row.current,
      list = el?.closest<HTMLElement>('[data-file-tree-scroll]')
    if (!el || !list || !sameRef || active?.path !== entry.path) return
    const r = el.getBoundingClientRect(),
      bounds = list.getBoundingClientRect()
    if (r.top < bounds.top) list.scrollTop -= bounds.top - r.top
    else if (r.bottom > bounds.bottom) list.scrollTop += r.bottom - bounds.bottom
  }, [active?.path, sameRef, entry.path])
  // 对话里的文件夹链接要定位的就是这一行：挂上（或已经在）时滚进可视区
  useLayoutEffect(() => {
    const scroll = (): void => {
      if (pendingScroll !== refKey(refTarget) + '\n' + entry.path) return
      pendingScroll = null
      row.current?.scrollIntoView({ block: 'nearest' })
    }
    scroll()
    window.addEventListener(EXPAND_FOLDER_EVENT, scroll)
    return () => window.removeEventListener(EXPAND_FOLDER_EVENT, scroll)
  }, [entry.path, refTarget.projectId, refTarget.sessionId])
  // 过滤结果是平铺的：结果里的文件行不接收，文件夹行只放不展开
  const dropOver: DragOver | null =
    entry.kind === 'directory'
      ? { ref: refTarget, kind: 'directory', path: entry.path, linked: entry.linked }
      : showPath
        ? null
        : { ref: refTarget, kind: 'file', path: entry.path }
  const canHoverExpand = entry.kind === 'directory' && !entry.linked && !expanded && !showPath
  const rowDrop = useDropProps(ops, dropOver, canHoverExpand ? () => setExpanded(true) : undefined)
  const dragged = !!ops.drag && refKey(ops.drag.ref) === refKey(refTarget) && ops.drag.path === entry.path
  const cutting = !!ops.cut && refKey(ops.cut.ref) === refKey(refTarget) && ops.cut.path === entry.path
  const source: DragSource = { ref: refTarget, path: entry.path, kind: entry.kind, name: entry.name }
  useEffect(() => {
    const open = (e: Event): void => {
      const detail = (e as CustomEvent<{ key: string; path: string }>).detail
      if (
        entry.kind === 'directory' &&
        detail.key === refKey(refTarget) &&
        (detail.path === entry.path || detail.path.startsWith(entry.path + '/'))
      )
        setExpanded(true)
    }
    window.addEventListener(EXPAND_FOLDER_EVENT, open)
    return () => window.removeEventListener(EXPAND_FOLDER_EVENT, open)
  }, [entry.path, entry.kind, refTarget.projectId, refTarget.sessionId])
  return (
    <div>
      {renaming ? (
        <NameInput initial={entry.name} depth={depth} folder={entry.kind === 'directory'} />
      ) : (
        <div
          ref={row}
          draggable
          onDragStart={e => {
            writeDragData(e.dataTransfer, source)
            ops.startDrag(source)
          }}
          onDragEnd={ops.endDrag}
          onKeyDown={e => cutPasteKeys(e.nativeEvent, ops, source, dropOver)}
          {...rowDrop}
          onContextMenu={e => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, trigger: e.currentTarget.querySelector('button')! })
          }}
          className={cn(
            'group/file flex min-w-0 items-center rounded-md pr-2 hover:bg-hover',
            active?.path === entry.path && sameRef && 'bg-selected',
            (dragged || cutting) && 'opacity-50',
            entry.kind === 'directory' && ops.dropKey === dropKeyOf(refTarget, entry.path) && DROP_ROW,
          )}
          style={{ paddingLeft: 10 + Math.min(depth, 20) * 12 }}
        >
          <button
            type="button"
            aria-label={`${entry.kind === 'directory' ? (expanded ? tr('files.FileTree.collapseFolder') : tr('files.FileTree.expandFolder')) : tr('files.FileTree.openFile')} ${entry.path}`}
            aria-expanded={entry.kind === 'directory' ? expanded : undefined}
            title={entry.path + (entry.linked ? tr('files.FileTree.link') : '')}
            onClick={() =>
              entry.kind === 'directory'
                ? setExpanded(v => !v)
                : void openFile(refTarget, entry.path).catch(e => setError(e.message))
            }
            className={cn(
              'flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-left text-meta',
              active?.path === entry.path && sameRef
                ? 'text-accent-fg'
                : vscode && status && entry.kind !== 'directory'
                  ? statusTone(status)
                  : dim
                    ? 'text-fg-faint'
                    : 'text-fg-secondary',
            )}
          >
            <ChevronRight
              size={12}
              className={cn('shrink-0', entry.kind !== 'directory' && 'invisible', expanded && 'rotate-90')}
            />
            <FileIcon name={entry.name} kind={entry.kind} expanded={expanded} dim={dim} />
            <span className={cn('min-w-0 truncate', !(vscode && entry.kind === 'directory' && status) && 'flex-1')}>
              {showPath ? entry.path : entry.name}
            </span>
            {vscode && entry.kind === 'directory' && status && (
              <span
                aria-hidden
                title={tr('files.FileTree.gitStatus', { p0: status })}
                className="mr-auto size-1.5 shrink-0 rounded-full bg-warn"
              />
            )}
            {status && !(vscode && entry.kind === 'directory') && (
              <span
                title={tr('files.FileTree.gitStatus', { p0: status })}
                className={cn(
                  'shrink-0 text-label',
                  vscode ? statusTone(status) : status === 'D' || status === '!' ? 'text-danger' : 'text-success',
                )}
              >
                {status}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label={tr('files.FileTree.copyFilePath', { p0: entry.path })}
            title={tr('files.FileTree.copyPath')}
            className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-fg-muted opacity-0 hover:bg-hover focus:opacity-100 group-hover/file:opacity-100"
            onClick={() => {
              if (isDemo) setError(tr('files.FileTree.demoModeCannotCopy'))
              else void window.pixelsky!.files.copyPath(refTarget, entry.path).catch(e => setError(e.message))
            }}
          >
            <Copy size={11} />
          </button>
        </div>
      )}
      {error && (
        <p role="status" className="px-4 text-label text-danger">
          {translateMessage(error)}
        </p>
      )}
      {expanded && (
        <Directory
          refTarget={refTarget}
          path={entry.path}
          depth={depth + 1}
          revision={revision}
          statuses={statuses}
          linked={entry.linked}
        />
      )}
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={entry.name}
          onClose={() => {
            setMenu(null)
            menu.trigger.focus({ preventScroll: true })
          }}
          actions={[
            {
              label: tr('workspace.sendPath'),
              icon: MessageSquareShare,
              hint: '@',
              run: () => {
                const error = sendPathToChat({ root: targetRoot ?? '', path: entry.path }, entry.kind === 'directory')
                if (error) setError(error)
              },
            },
            ...(entry.kind === 'directory'
              ? [
                  {
                    label: tr('workspace.newFile'),
                    separator: true,
                    icon: FilePlus,
                    run: () => ops.edit({ mode: 'file', ref: refTarget, parent: entry.path }),
                  },
                  {
                    label: tr('workspace.newFolder'),
                    icon: FolderPlus,
                    run: () => ops.edit({ mode: 'folder', ref: refTarget, parent: entry.path }),
                  },
                ]
              : []),
            ...(entry.kind === 'directory' && dropOver ? pasteAction(ops, dropOver) : []),
            {
              label: tr('workspace.renameEntry'),
              icon: Pencil,
              separator: entry.kind !== 'directory',
              run: () => ops.edit({ mode: 'rename', ref: refTarget, parent: parentOf(entry.path), path: entry.path }),
            },
            {
              label: tr('workspace.cut'),
              icon: Scissors,
              run: () => ops.setCut(source),
            },
            {
              label: tr('workspace.deleteEntry'),
              icon: Trash2,
              danger: true,
              run: () => ops.remove(refTarget, entry),
            },
            ...(entry.kind === 'directory'
              ? []
              : [
                  {
                    label: tr('git.history.file.show'),
                    icon: FileClock,
                    separator: true,
                    run: () => requestFileHistory({ ref: refTarget, path: entry.path, base: 'workspace' }),
                  },
                ]),
            {
              label: tr('panes.PaneView.copyFilePath'),
              icon: Copy,
              separator: entry.kind === 'directory',
              run: () => {
                if (!isDemo) void window.pixelsky!.files.copyPath(refTarget, entry.path).catch(e => setError(e.message))
              },
            },
            {
              label: tr('panes.PaneView.openWithExternalEditor'),
              icon: ExternalLink,
              run: () => {
                if (!isDemo)
                  void window.pixelsky!.editor.open(refTarget, undefined, entry.path).catch(e => setError(e.message))
              },
            },
          ]}
        />
      )}
    </div>
  )
}
