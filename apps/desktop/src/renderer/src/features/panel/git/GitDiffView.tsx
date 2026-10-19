import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { goToNextChunk, goToPreviousChunk, MergeView, unifiedMergeView } from '@codemirror/merge'
import { Button, IconButton, Segmented, Spinner } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { editorChrome } from '@/features/editor/code/theme'
import { diffPackExtensions } from '@/features/editor/code/packs'
import { useEditorPacksTick } from '@/features/editor/code/packEvents'
import { mergeTheme } from '@/features/editor/code/mergeTheme'
import { lineDiffConfig } from '@/features/editor/code/lineDiff'
import { firstLineOf } from '@/features/editor/code/languageIds'
import { loadLanguage } from '@/features/editor/code/languages'
import { useRemember } from '../ToolsUi'
import type { GitArea, GitDiff, GitFileChange } from '../../../../../shared/types/project-tools'
import { diffMode, sameGitDiff, SPLIT_MIN_WIDTH, splitPath } from './gitModel'

const COLLAPSE = { margin: 3, minSize: 4 }

/** 只读的差异编辑器：并排用 MergeView，行内用 unifiedMergeView；navRef 指向可以跳转改动的那个编辑器 */
function DiffEditor({
  diff,
  mode,
  navRef,
}: {
  diff: GitDiff
  mode: 'split' | 'inline'
  navRef: { current: EditorView | null }
}) {
  const host = useRef<HTMLDivElement>(null)
  // 扩展包、深浅色、颜色主题加载完都要重建（B4）
  const packsTick = useEditorPacksTick()
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    let destroy = (): void => {}
    let disposed = false
    void loadLanguage(diff.path, firstLineOf(diff.modified || diff.original || '')).then(language => {
      if (disposed) return
      const base = [
        editorChrome,
        ...diffPackExtensions(),
        mergeTheme,
        lineNumbers(),
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        language,
      ]
      const original = diff.original ?? '',
        modified = diff.modified ?? ''
      if (mode === 'split') {
        const view = new MergeView({
          a: { doc: original, extensions: base },
          b: { doc: modified, extensions: base },
          parent,
          collapseUnchanged: COLLAPSE,
          gutter: true,
          diffConfig: lineDiffConfig,
        })
        navRef.current = view.b
        destroy = () => view.destroy()
      } else {
        const view = new EditorView({
          parent,
          state: EditorState.create({
            doc: modified,
            extensions: [
              ...base,
              unifiedMergeView({
                original,
                mergeControls: false,
                collapseUnchanged: COLLAPSE,
                gutter: true,
                diffConfig: lineDiffConfig,
              }),
            ],
          }),
        })
        navRef.current = view
        destroy = () => view.destroy()
      }
    })
    return () => {
      disposed = true
      navRef.current = null
      destroy()
    }
  }, [diff, mode, packsTick])
  return (
    <div
      ref={host}
      data-git-diff={mode}
      className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-mergeView]:h-full [&_.cm-mergeView]:overflow-y-auto [&_.cm-mergeViewEditors]:min-h-full"
    />
  )
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
}: {
  file: GitFileChange
  /** commit：历史里一个提交的文件（docs/ui/git-panel.md §9.5） */
  area: GitArea | 'commit'
  load: () => Promise<GitDiff>
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
    load().then(
      d => {
        if (gone) return
        settled.current = true
        setDiff(prev => (quiet && prev && sameGitDiff(prev, d) ? prev : d))
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
  const jump = (delta: 1 | -1) => {
    const view = nav.current
    if (view) {
      ;(delta > 0 ? goToNextChunk : goToPreviousChunk)({ state: view.state, dispatch: view.dispatch })
      view.focus()
    }
  }
  const same = diff && !diff.binary && !diff.tooLarge && diff.original === diff.modified
  return (
    <div ref={box} data-git-diff-view className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line-subtle px-2 py-1.5">
        {onBack && <IconButton icon={ArrowLeft} label={tr('git.back')} size={28} iconSize={15} onClick={onBack} />}
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-list font-medium text-fg" title={file.path}>
            {name}
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
          disabled={!diff || !!same}
        />
        <IconButton
          icon={ChevronDown}
          label={tr('git.diff.next')}
          size={26}
          iconSize={14}
          onClick={() => jump(1)}
          disabled={!diff || !!same}
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
              { value: 'inline', label: tr('git.diff.inline') },
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
      {error ? (
        <p role="alert" className="m-3 rounded-md bg-subtle p-2 text-meta text-danger">
          {error}
        </p>
      ) : !diff ? (
        <div className="flex items-center justify-center gap-2 p-6 text-meta text-fg-muted">
          <Spinner size={13} />
          {tr('git.diff.loading')}
        </div>
      ) : diff.binary || diff.tooLarge || same ? (
        <p className="m-3 rounded-md bg-subtle p-3 text-center text-meta text-fg-muted">
          {tr(diff.binary ? 'git.diff.binary' : diff.tooLarge ? 'git.diff.tooLarge' : 'git.diff.same')}
        </p>
      ) : (
        <DiffEditor key={`${file.path}:${area}:${mode}`} diff={diff} mode={mode} navRef={nav} />
      )}
    </div>
  )
}
