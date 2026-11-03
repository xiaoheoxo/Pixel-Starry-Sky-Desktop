import { useCallback, useEffect, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import { FileText } from 'lucide-react'
import type { Extension } from '@codemirror/state'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, DiffStat, cn } from '@/ui'
import { FileEditor } from '@/features/editor/FileEditor'
import { MarkdownPreview } from '@/features/editor/MarkdownPreview'
import { isDemo } from '@/data'
import { fileLanguage } from '@/features/editor/code/languages'
import {
  dirtyFile,
  ensureFile,
  getFiles,
  openFile,
  setCodeOpener,
  updateFile,
  useFiles,
  type OpenFile,
} from '@/features/files/store'
import { CLOSE_TAB, CYCLE_TAB } from '@/features/layout/shortcuts'
import { SPLIT_MIN_WIDTH } from '@/features/panel/git/gitModel'
import { useRecentFiles } from '@/features/panel/recentFiles'
import { parseFileTab } from '@/features/panes/tree'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import type { TurnChanges } from '../ai/turnChangesModel'
import { useTurnChanges } from '../ai/useTurnChanges'
import { kindTone } from '../left/files/filesModel'
import { codingLayout } from '../layoutStore'
import { AiReviewBar, useAiReviewExtensions, useTurnBaseline } from '../review'
import { SymbolCrumb, useEditorExtras } from './extras'
import { useCodingSessionId, useCodingWorkspace } from '../workspace'
import {
  activateCodeTab,
  closeCodeTab,
  cycleCodeTab,
  focusCodeGroup,
  openCodeTab,
  setCodeProject,
  setCodeView,
  splitCodeRight,
  useCodeTabs,
} from './codeTabs'
import { baseName, isGitDiffId, pathKey, type CodeTabGroup } from './codeTabsModel'
import { diffTag } from './gitDiffModel'
import { emptyTurnList } from './emptyModel'
import { CodeTabs, type TabItem } from './TabBar'
import { DiffPane } from './DiffPane'
import { MirrorView } from './MirrorView'
import { GitDiffTab } from './GitDiffTab'
import { GitWorkBar } from './GitWorkBar'
import { getGitDiffTab, useGitDiffRev } from './gitDiffTabs'
import { defaultMode, effectiveBase, effectiveMode, viewAvailability } from './viewModel'
import type { MenuAction } from '@/ui/ActionMenu'

const EMPTY: readonly Extension[] = []
const caseInsensitive = typeof window !== 'undefined' && window.pixelsky?.platform === 'win32'

/** 中栏当前文件；没有时 null */
export function useActiveCodeTab(): OpenFile | null {
  const { group } = useCodeTabs()
  const files = useFiles()
  return (group.active && files.tabs.find(t => t.id === group.active)) || null
}

/** 打开到中栏并切到「变更」（对比这一轮，算不出来 DiffPane 会退回 HEAD） */
export async function openCodeDiff(ref: WorkspaceRef, path: string): Promise<void> {
  const id = await openFile(ref, path, undefined, 1, undefined, { target: 'code' })
  if (id) setCodeView(id, 'diff', 'turn')
}

/** 没有标签时的空状态：提示、这一轮 AI 改的文件、最近打开的文件 */
function EmptyState({ scope, turn, target }: { scope: string; turn: TurnChanges | null; target: WorkspaceRef | null }) {
  useI18n()
  const recent = useRecentFiles(scope)
  const list = emptyTurnList(turn?.files)
  const first = list.first
  return (
    <div
      data-coding-editor-empty
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center text-ui text-fg-muted"
    >
      <FileText size={24} strokeWidth={1.5} />
      <p>{tr('coding.editor.empty.title')}</p>
      {target && first && (
        <div data-coding-empty-turn className="flex w-full max-w-72 flex-col gap-0.5 text-left">
          <p className="flex items-center gap-2 px-2 pb-1 text-label text-fg-muted">
            <span>{tr('coding.files.aiTurn')}</span>
            {turn?.running && (
              <span className="flex items-center gap-1 font-normal">
                <span aria-hidden className="size-1.5 rounded-full bg-active" />
                {tr('coding.files.aiTurnRunning')}
              </span>
            )}
          </p>
          {list.shown.map(f => (
            <button
              key={f.path}
              type="button"
              title={f.path}
              aria-label={tr('coding.files.aiTurnOpen', { name: f.name })}
              className="press flex min-h-7 min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-meta hover:bg-hover"
              onClick={() => void openCodeDiff(target, f.path)}
            >
              <span className={cn('min-w-[4em] truncate', kindTone(f.kind))}>{f.name}</span>
              <span className="min-w-0 flex-[1_1_0] truncate text-fg-muted">{f.dir}</span>
              <DiffStat added={f.added} removed={f.removed} className="text-label" />
            </button>
          ))}
          {list.more > 0 && (
            <button
              type="button"
              className="press flex min-h-7 items-center rounded-md px-2 text-meta text-fg-muted hover:bg-hover"
              onClick={() => codingLayout.showLeft('files')}
            >
              {tr('coding.editor.empty.more', { n: list.more })}
            </button>
          )}
          <Button
            variant="primary"
            data-open-first-change
            className="mt-2 justify-center"
            onClick={() => void openCodeDiff(target, first.path)}
          >
            {tr('coding.editor.empty.openFirst')}
          </Button>
        </div>
      )}
      {recent.length > 0 && (
        <div className="flex w-full max-w-72 flex-col gap-0.5 text-left">
          <p className="px-2 pb-1 text-label text-fg-muted">{tr('coding.editor.empty.recent')}</p>
          {recent.map(item => {
            const path = parseFileTab(item.id)?.path ?? item.id
            return (
              <button
                key={item.id}
                type="button"
                title={path}
                className="press flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-ui text-fg hover:bg-hover"
                onClick={() => {
                  void ensureFile(item.id)
                  openCodeTab(item.id)
                }}
              >
                <span className="max-w-[60%] min-w-0 shrink-0 truncate">{baseName(path)}</span>
                <span className="min-w-0 truncate text-meta text-fg-muted">{path}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 分屏要放下两组：每组至少 320（按中栏最小宽度 420 算的话，右栏对话开着时一般就分不了屏） */
const SPLIT_GROUPS_MIN_WIDTH = 640

/** 中栏：一组标签，向右分屏后左右两组（docs/ui/coding-tier1.md §5） */
export function EditorArea({ visible, width }: { visible: boolean; width: number }) {
  useI18n()
  const workspace = useCodingWorkspace()
  const { pane, group } = useCodeTabs()
  const turn = useTurnChanges(useCodingSessionId())
  useGitDiffRev()

  useEffect(() => {
    setCodeOpener(openCodeTab)
    return () => setCodeOpener(null)
  }, [])
  useEffect(() => {
    setCodeProject(workspace.key)
  }, [workspace.key])

  const aiPaths = useMemo(() => new Set((turn?.files ?? []).map(f => pathKey(f.path, caseInsensitive))), [turn])
  const splitted = pane.groups.length > 1
  const narrow = width < SPLIT_GROUPS_MIN_WIDTH

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const native = e.nativeEvent
    const delta = CYCLE_TAB.delta(native)
    if (CLOSE_TAB.match(native) && group.active) {
      e.preventDefault()
      void closeCodeTab(group.active, pane.focus)
    } else if (delta) {
      e.preventDefault()
      cycleCodeTab(delta > 0 ? 1 : -1)
    }
  }

  return (
    <div data-coding-editor className="flex min-h-0 min-w-0 flex-1 bg-app" onKeyDownCapture={onKeyDown}>
      {pane.groups.map((g, index) => (
        <EditorGroup
          key={index}
          index={index}
          group={g}
          focused={!splitted || index === pane.focus}
          // 另一组正挂着同一个文件的编辑器：这组先显示只读副本（MirrorView）
          mirror={splitted && index !== pane.focus && g.active === group.active}
          visible={visible}
          width={width / pane.groups.length}
          split={
            splitted
              ? undefined
              : { disabled: !g.active || narrow, hint: narrow ? tr('coding.editor.splitNarrow') : undefined }
          }
          aiPaths={aiPaths}
          empty={<EmptyState scope={workspace.key} turn={turn} target={workspace.ref} />}
        />
      ))}
    </div>
  )
}

/** 一组标签：标签栏 + 代码 / 变更 / 并排 三种视图 */
function EditorGroup({
  index,
  group,
  focused,
  mirror,
  visible,
  width,
  split,
  aiPaths,
  empty,
}: {
  index: number
  group: CodeTabGroup
  focused: boolean
  mirror: boolean
  visible: boolean
  width: number
  split?: { disabled: boolean; hint?: string }
  aiPaths: ReadonlySet<string>
  empty: ReactNode
}) {
  useI18n()
  const files = useFiles()

  const active = group.active
  const tab = (active && files.tabs.find(t => t.id === active)) || null

  const items: TabItem[] = group.tabs.map(id => {
    const git = isGitDiffId(id) ? getGitDiffTab(id) : undefined
    if (git) {
      const tag = diffTag(git.area, git.to)
      return {
        id,
        name: baseName(git.path),
        title: tr('coding.gitDiff.title', { name: git.path }),
        dirty: false,
        ai: false,
        tag:
          tag.kind === 'commit'
            ? tag.hash
            : tr(tag.kind === 'staged' ? 'coding.gitDiff.tag.staged' : 'coding.gitDiff.tag.work'),
      }
    }
    const file = files.tabs.find(t => t.id === id)
    const path = file?.path ?? parseFileTab(id)?.path ?? id
    return {
      id,
      name: file?.name ?? baseName(path),
      title: path,
      dirty: !!file && dirtyFile(file),
      ai: aiPaths.has(pathKey(path, caseInsensitive)),
    }
  })

  // 两个扩展 hook 都在顶层调用，再合并；两边都为空时用同一个常量，避免多余的 reconfigure
  const review = useAiReviewExtensions(tab)
  const extras = useEditorExtras(tab)
  const merged = useMemo(() => (review.length || extras.length ? [...review, ...extras] : EMPTY), [review, extras])
  const turnBaseline = useTurnBaseline(tab)

  const avail = useMemo(
    () =>
      tab
        ? viewAvailability({
            head: tab.head,
            draft: tab.draft,
            text: tab.document?.kind === 'text',
            markdown: fileLanguage(tab.path) === 'Markdown',
            turnBaseline,
            width,
            splitMinWidth: SPLIT_MIN_WIDTH,
          })
        : null,
    [tab, turnBaseline, width],
  )
  const saved = active ? group.views?.[active] : undefined
  const mode = avail ? effectiveMode(saved?.mode ?? defaultMode(avail), avail) : 'code'
  const base = avail ? effectiveBase(saved?.base ?? 'head', avail) : 'head'
  // 打开时指名了行（搜索结果、路径链接）：files/store 把标签的 preview 设成 false，这里切到「代码」并把这个请求用掉
  const leavePreview = tab?.preview === false && mode === 'preview'
  useEffect(() => {
    if (!leavePreview || !active) return
    setCodeView(active, 'code', undefined, index)
    updateFile(active, { preview: undefined })
  }, [leavePreview, active, index])

  const menu = useCallback((): MenuAction[] => {
    const file = active ? files.tabs.find(t => t.id === active) : undefined
    const closeAll = async (keep: string | null): Promise<void> => {
      for (const id of [...group.tabs]) if (id !== keep) await closeCodeTab(id, index)
    }
    return [
      { label: tr('coding.editor.closeOthers'), disabled: group.tabs.length < 2, run: () => void closeAll(active) },
      { label: tr('coding.editor.closeAll'), run: () => void closeAll(null) },
      {
        label: tr('coding.editor.copyPath'),
        separator: true,
        disabled: !file,
        // 主进程按引用找真实路径：附加文件夹里的文件（「::N/…」）、远程机器上的都对
        run: () =>
          file &&
          void (isDemo
            ? navigator.clipboard.writeText(`${file.root.replace(/\/$/, '')}/${file.path}`)
            : window.pixelsky!.files.copyPath(file.ref, file.path)),
      },
      {
        label: tr('coding.editor.copyRelPath'),
        disabled: !file,
        run: () => file && void navigator.clipboard.writeText(file.path),
      },
      { label: tr('coding.editor.reveal'), disabled: !file, run: () => codingLayout.showLeft('files') },
    ]
  }, [files.tabs, group.tabs, active, index])

  return (
    <div
      data-coding-editor-group={index}
      data-focused={focused || undefined}
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col', index > 0 && 'border-l border-line-layout')}
      // 点到这组里任何地方（标签栏、编辑器、只读副本）这组就成为当前
      onMouseDownCapture={() => focusCodeGroup(index)}
    >
      <CodeTabs
        tabs={items}
        active={active}
        focused={focused}
        mode={mode}
        avail={avail}
        split={split}
        onActivate={id => activateCodeTab(id, index)}
        onClose={id => void closeCodeTab(id, index)}
        onMode={next => active && setCodeView(active, next, undefined, index)}
        onSplit={splitCodeRight}
        menu={menu()}
      />
      {!active ? (
        empty
      ) : isGitDiffId(active) ? (
        <GitDiffTab key={active} id={active} />
      ) : (
        <>
          {tab && <GitWorkBar tab={tab} />}
          {mirror && tab?.document?.kind === 'text' && (mode === 'code' || mode === 'preview') ? (
            mode === 'preview' ? (
              // 双击跳行交给成为当前之后的那个编辑器：按下鼠标时这组就已经成为当前
              <MarkdownPreview text={tab.draft} onJump={() => {}} />
            ) : (
              <MirrorView tab={tab} />
            )
          ) : mode === 'code' || mode === 'preview' || !tab ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <FileEditor
                key={active}
                id={active}
                active={visible && focused}
                preview={mode === 'preview'}
                onExitPreview={line => {
                  setCodeView(active, 'code', undefined, index)
                  updateFile(active, {
                    reveal: {
                      line,
                      column: 1,
                      seq: (getFiles().tabs.find(t => t.id === active)?.reveal?.seq ?? 0) + 1,
                    },
                  })
                }}
                extensions={merged}
                footer={false}
                crumbExtra={tab ? <SymbolCrumb tab={tab} /> : null}
              />
              <AiReviewBar tabId={active} />
            </div>
          ) : (
            <DiffPane
              key={active}
              tab={tab}
              mode={mode}
              base={base}
              turnBaseline={turnBaseline}
              fellBack={(saved?.base ?? 'head') === 'turn' && base === 'head'}
              onBase={next => setCodeView(active, mode, next, index)}
            />
          )}
        </>
      )}
    </div>
  )
}
