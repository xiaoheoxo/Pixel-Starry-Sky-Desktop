import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileClock,
  FileCode2,
  Minus,
  Plus,
  Undo2,
} from 'lucide-react'
import type { EditorView } from '@codemirror/view'
import { goToNextChunk, goToPreviousChunk } from '@codemirror/merge'
import { Button, IconButton, Segmented, Spinner } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { DiffEditor } from '@/features/editor/code/DiffEditor'
import { aiBusyFor, getAutoSave, subscribeAutoSave } from '@/features/editor/autoSaveModel'
import { refKey } from '@/features/editor/target'
import { getEngineState, subscribeEngine } from '@/features/engine/store'
import { dirtyFile, holdFile, releaseFile, useFiles, type OpenFile } from '@/features/files/store'
import { isMac } from '@/features/layout/keybindings'
import { useRemember } from '../ToolsUi'
import type { GitArea, GitDiff, GitFileChange } from '../../../../../shared/types/project-tools'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { diffEditable, diffMode, sameGitDiff, SPLIT_MIN_WIDTH, splitPath } from './gitModel'
import { GitImageDiff } from './GitImageDiff'

const caseInsensitive = (): boolean => (window.pixelsky?.platform ?? 'win32') !== 'linux'

/**
 * 能直接改的差异：在文件 store 里拿着这个文件（和编辑器标签是同一份草稿、同一套保存），不开标签；
 * 离开时放下（docs/ui/git-diff-copy-edit.md）。读不到时返回 null，差异照旧只读显示
 */
function useHeldFile(ref: WorkspaceRef | undefined, path: string | undefined): OpenFile | null {
  const key = ref && path ? `${refKey(ref)}\n${path}` : ''
  const [id, setId] = useState<string | null>(null)
  useEffect(() => {
    if (!ref || !path) return
    let gone = false
    let held: string | null = null
    holdFile(ref, path).then(
      got => {
        if (gone) releaseFile(got)
        else {
          held = got
          setId(got)
        }
      },
      () => undefined,
    )
    return () => {
      gone = true
      setId(null)
      if (held) releaseFile(held)
    }
  }, [key])
  const files = useFiles()
  const tab = (id && files.tabs.find(t => t.id === id)) || null
  return tab && !tab.loading && tab.document?.kind === 'text' ? tab : null
}

/** Git 面板里点进去看一个文件的差异（docs/ui/git-panel.md §2.5、§9.5） */
export function GitDiffView({
  file,
  area,
  load,
  onBack,
  onNeighbour,
  onStage,
  onUnstage,
  onDiscard,
  onOpen,
  onHistory,
  caption,
  busy,
  labelled,
  revision,
  editRef,
}: {
  file: GitFileChange
  /** commit：历史里一个提交的文件（docs/ui/git-panel.md §9.5） */
  area: GitArea | 'commit'
  /** known：上次读到的图片对比的 version，两端都没变时 main 只回 unchanged */
  load: (known?: string) => Promise<GitDiff>
  /** 中栏的 Git 对比标签没有「返回」和上一个 / 下一个文件（左栏的列表一直在） */
  onBack?: () => void
  onNeighbour?: (delta: 1 | -1) => void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
  onOpen?: () => void
  /** 看这个文件的历史（docs/ui/git-panel.md §9.15） */
  onHistory?: () => void
  /** 文件名下面的说明（历史里写是哪个提交 / 哪两个版本）；没有时写目录 */
  caption?: string
  busy: boolean
  /** 暂存 / 取消暂存 / 撤销写成带文字的按钮（中栏地方够） */
  labelled?: boolean
  /**
   * Git 状态的版本（每读到一次新状态就变）：变了就在后台重读，内容一样不替换。
   * 文件还在同一区、状态字母也没变时（比如再次 git add 了新内容），靠它跟上；历史里的提交不会变，不传
   */
  revision?: unknown
  /** 能直接改时文件所在的工作区（和「在编辑器中打开」用的同一个）；不给就只读（docs/ui/git-diff-copy-edit.md） */
  editRef?: WorkspaceRef
}) {
  useI18n()
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [error, setError] = useState('')
  const [preferred, setPreferred] = useRemember<'split' | 'inline'>('pixelsky.git.diffMode', 'inline')
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const nav = useRef<EditorView | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])
  // 换了文件 / 区 / 状态字母：清空重读；只是状态版本变了：后台重读，读完内容不同才替换，读失败保留原来的
  // 只有这个文件已经显示出结果（对比或报错）才算后台重读：第一次还没读完就被刷新打断时照常重读、报错照常显示
  const shown = useRef('')
  const settled = useRef(false)
  const latest = useRef(diff)
  latest.current = diff
  useEffect(() => {
    let gone = false
    const key = `${area}|${file.code}|${file.path}`
    const quiet = shown.current === key && settled.current
    if (!quiet) {
      shown.current = key
      settled.current = false
      setDiff(null)
      setError('')
    }
    load(quiet ? latest.current?.version : undefined).then(
      d => {
        if (gone) return
        settled.current = true
        setDiff(prev => (quiet && prev && (d.unchanged || sameGitDiff(prev, d)) ? prev : d))
        setError('')
      },
      e => {
        if (gone || quiet) return
        settled.current = true
        setError((e as Error).message)
      },
    )
    return () => {
      gone = true
    }
  }, [file.path, area, file.code, revision])
  const mode = diffMode(preferred, width)
  const { name, dir } = splitPath(file.path)
  // 新版本就是磁盘文件的（未暂存 / 未跟踪 / 冲突）：拿着这个文件直接改，保存、自动保存和编辑器一样
  const canEdit = !!editRef && diffEditable(area, file)
  const tab = useHeldFile(canEdit ? editRef : undefined, canEdit ? (file.local ?? undefined) : undefined)
  const aiBusy = useSyncExternalStore(
    subscribeEngine,
    () => !!tab && aiBusyFor(tab, getEngineState().sessions, caseInsensitive()),
  )
  const autoSave = useSyncExternalStore(subscribeAutoSave, () => getAutoSave().mode !== 'off')
  const fileReadOnly = !tab || aiBusy || (tab.document?.kind === 'text' && !!tab.document.readonly)
  const dirty = !!tab && dirtyFile(tab)
  const jump = (delta: 1 | -1) => {
    const view = nav.current
    if (view) {
      ;(delta > 0 ? goToNextChunk : goToPreviousChunk)({ state: view.state, dispatch: view.dispatch })
      view.focus()
    }
  }
  const modified = tab ? tab.draft : (diff?.modified ?? '')
  // 按 Git 读到的判断，不按草稿：在差异里把改动改回原样时编辑器不能突然消失
  const same = diff && !diff.binary && !diff.tooLarge && diff.original === diff.modified
  const textDiff = !!diff && !error && !diff.images && !diff.binary && !diff.tooLarge && !same
  // 编辑器上面一行：能改时说怎么存 / 为什么暂时只读，磁盘被别处改了时提醒；暂存区、提交里的版本说只能复制
  const notice: { text: string; tone: 'muted' | 'warn'; open?: boolean } | null = !textDiff
    ? null
    : tab && (tab.external || tab.error)
      ? {
          text: tab.error ? translateMessage(tab.error) : tr('editor.FileEditor.fileChangedExternallyYour'),
          tone: 'warn',
          open: true,
        }
      : tab
        ? {
            text: aiBusy
              ? tr('coding.editor.diff.aiRunning')
              : autoSave
                ? tr('git.diff.editable.auto')
                : tr('coding.editor.diff.editable', { keys: isMac ? '⌘S' : 'Ctrl+S' }),
            tone: aiBusy ? 'warn' : 'muted',
          }
        : area === 'staged' || area === 'commit'
          ? {
              text: tr(area === 'staged' ? 'git.diff.readonly.staged' : 'git.diff.readonly.commit'),
              tone: 'muted',
              open: true,
            }
          : null
  return (
    <div ref={box} data-git-diff-view className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line-subtle px-2 py-1.5">
        {onBack && <IconButton icon={ArrowLeft} label={tr('git.back')} size={28} iconSize={15} onClick={onBack} />}
        <div className="min-w-0 flex-1 px-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-list font-medium text-fg" title={file.path}>
              {name}
            </span>
            {dirty && (
              <span
                data-git-diff-dirty
                title={tr('git.diff.unsaved')}
                aria-label={tr('git.diff.unsaved')}
                className="size-1.5 shrink-0 rounded-full bg-fg-muted"
              />
            )}
          </div>
          {caption ? (
            <div className="truncate text-meta text-fg-faint" title={caption}>
              {caption}
            </div>
          ) : (
            (dir || file.origPath) && (
              <div className="truncate text-meta text-fg-faint">
                {file.origPath ? `${file.origPath} → ` : ''}
                {dir}
              </div>
            )
          )}
        </div>
        <IconButton
          icon={ChevronUp}
          label={tr('git.diff.prev')}
          size={26}
          iconSize={14}
          onClick={() => jump(-1)}
          disabled={!diff || diff.binary || diff.tooLarge || !!same}
        />
        <IconButton
          icon={ChevronDown}
          label={tr('git.diff.next')}
          size={26}
          iconSize={14}
          onClick={() => jump(1)}
          disabled={!diff || diff.binary || diff.tooLarge || !!same}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line-subtle px-3 py-1.5">
        <span title={width < SPLIT_MIN_WIDTH ? tr('git.diff.narrow') : undefined}>
          <Segmented
            label={tr('git.diff.mode')}
            value={mode}
            disabled={width < SPLIT_MIN_WIDTH}
            onChange={setPreferred}
            options={[
              { value: 'inline', label: tr(diff?.images ? 'git.diff.image.stacked' : 'git.diff.inline') },
              { value: 'split', label: tr('git.diff.split') },
            ]}
          />
        </span>
        <span className="flex-1" />
        {onNeighbour && (
          <>
            <IconButton
              icon={ChevronLeft}
              label={tr('git.diff.prevFile')}
              size={26}
              iconSize={14}
              onClick={() => onNeighbour(-1)}
            />
            <IconButton
              icon={ChevronRight}
              label={tr('git.diff.nextFile')}
              size={26}
              iconSize={14}
              onClick={() => onNeighbour(1)}
            />
          </>
        )}
        {onOpen && <IconButton icon={FileCode2} label={tr('git.open')} size={26} iconSize={14} onClick={onOpen} />}
        {onHistory && (
          <IconButton
            icon={FileClock}
            label={tr('git.history.file.show')}
            size={26}
            iconSize={14}
            onClick={onHistory}
          />
        )}
        {onStage &&
          (labelled ? (
            <Button className="h-7 px-2.5 text-meta" icon={Plus} disabled={busy} onClick={onStage}>
              {tr('git.stage')}
            </Button>
          ) : (
            <IconButton icon={Plus} label={tr('git.stage')} size={26} iconSize={14} disabled={busy} onClick={onStage} />
          ))}
        {onUnstage &&
          (labelled ? (
            <Button className="h-7 px-2.5 text-meta" icon={Minus} disabled={busy} onClick={onUnstage}>
              {tr('git.unstage')}
            </Button>
          ) : (
            <IconButton
              icon={Minus}
              label={tr('git.unstage')}
              size={26}
              iconSize={14}
              disabled={busy}
              onClick={onUnstage}
            />
          ))}
        {onDiscard &&
          (labelled ? (
            <Button className="h-7 px-2.5 text-meta" icon={Undo2} disabled={busy} onClick={onDiscard}>
              {tr('git.discard')}
            </Button>
          ) : (
            <IconButton
              icon={Undo2}
              label={tr('git.discard')}
              size={26}
              iconSize={14}
              disabled={busy}
              onClick={onDiscard}
            />
          ))}
      </div>
      {notice && (
        <div
          data-git-diff-notice
          role={notice.tone === 'warn' ? 'status' : undefined}
          className={`flex shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-1 text-meta ${notice.tone === 'warn' ? 'text-fg' : 'text-fg-faint'}`}
        >
          <span className="min-w-0 flex-1 truncate">{notice.text}</span>
          {notice.open && onOpen && (
            <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={onOpen}>
              {tr(tab ? 'git.open' : 'git.diff.openToEdit')}
            </button>
          )}
        </div>
      )}
      {error ? (
        <p role="alert" className="m-3 rounded-md bg-subtle p-2 text-meta text-danger">
          {translateMessage(error)}
        </p>
      ) : !diff ? (
        <div className="flex items-center justify-center gap-2 p-6 text-meta text-fg-muted">
          <Spinner size={13} />
          {tr('git.diff.loading')}
        </div>
      ) : diff.images ? (
        // 历史里不同提交的同一张图各记各的缩放
        <GitImageDiff
          diff={diff}
          mode={mode}
          id={`git:${area}:${file.path}${area === 'commit' && diff.version ? ':' + diff.version : ''}`}
        />
      ) : diff.binary || diff.tooLarge || same ? (
        <p className="m-3 rounded-md bg-subtle p-3 text-center text-meta text-fg-muted">
          {tr(
            diff.tooLarge
              ? diff.image
                ? 'git.diff.image.tooLarge'
                : 'git.diff.tooLarge'
              : diff.binary
                ? 'git.diff.binary'
                : 'git.diff.same',
          )}
        </p>
      ) : (
        <DiffEditor
          key={`${file.path}:${area}:${mode}`}
          tabId={tab?.id ?? null}
          path={file.path}
          original={diff.original ?? ''}
          modified={modified}
          mode={mode}
          readOnly={fileReadOnly}
          navRef={nav}
          marker="git-diff"
        />
      )}
    </div>
  )
}
