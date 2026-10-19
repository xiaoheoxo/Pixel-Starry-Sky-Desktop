// 设置 › 项目：从其他工具、文件夹或路径清单批量导入项目（原侧栏「批量导入项目…」弹窗）。
// 打开即读取本机工具清单；来源卡片决定列表里显示谁，表格按「可添加 / 已添加 / 失效」分开，底部操作栏添加并可放进分区。
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Check,
  ClipboardList,
  Folder,
  FolderInput,
  FolderPlus,
  FolderX,
  Inbox,
  Minus,
  Search,
  X,
} from 'lucide-react'
import type { ProjectImportBatch, ProjectImportCandidate } from '../../../../../shared/types/project-import'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { Button, EngineIcon, Segmented, Select, Spinner, cn, useToast } from '@/ui'
import { useMachines } from '@/features/machines/store'
import { addProjectPaths, pickProjectImports, previewProjectPaths, scanProjectImports } from '@/features/engine/store'
import { GROUP_NAME_LIMIT, getSidebarPrefs, setProjectGroups, useSidebarPrefs } from '@/features/appearance/sidebar'
import { addToGroup, createGroup, newGroupId } from '@/features/sidebar/projectGroups'
import { addedSummary, mergeImportCandidates } from '@/features/sidebar/projectImportModel'
import { SectionTitle } from '../SettingRow'
import { prefetchResumeCounts } from '@/features/resume/hint'
import { ResumeHintLink } from '@/features/resume/ResumeHintLink'
import { useSettings } from '../SettingsProvider'
import { ResumeScanCard } from './ResumeScanCard'
import {
  IMPORT_TOOLS,
  bucketOf,
  countBuckets,
  filterCandidates,
  isSelectable,
  isToolSource,
  isVisible,
  mergePicked,
  selectAllState,
  toolCounts,
  type ImportBucket,
} from './importModel'

const PAGE = 200
const NEW_GROUP = '__new'

const folderName = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path
const sourceLabel = (source: string): string =>
  source === 'Folders'
    ? tr('projectImport.foldersSource')
    : source === 'Paths'
      ? tr('projectImport.pathsSource')
      : isToolSource(source)
        ? source
        : folderName(source)

function ToolMark({ id }: { id: string }) {
  if (id === 'claude' || id === 'codex') return <EngineIcon engine={id} size={18} />
  return (
    <span className="grid size-[18px] shrink-0 place-items-center rounded bg-fg-secondary text-[10px] font-bold text-surface">
      {id === 'zcode' ? 'Z' : 'K'}
    </span>
  )
}

export function ProjectsSection() {
  useI18n()
  const local = useMachines().currentId === 'local'
  const toast = useToast()
  // 从「原来的 AI 会话」打开了新对话：关掉设置，看得到那个对话
  const { closeSettings } = useSettings()
  const groups = useSidebarPrefs().groups ?? []
  const [candidates, setCandidates] = useState<ProjectImportCandidate[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  /** 这次新加的项目：路径 → 项目 ID，结果行据此显示「终端里有 N 个会话」 */
  const [addedIds, setAddedIds] = useState<Record<string, string>>({})
  /** 取消勾选的工具卡片（工具名） */
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [warnings, setWarnings] = useState<string[]>([])
  const [failures, setFailures] = useState<Array<{ path: string; error: string }>>([])
  const [scanning, setScanning] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [bucket, setBucket] = useState<ImportBucket>('addable')
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [paths, setPaths] = useState('')
  const [group, setGroup] = useState('')
  const [groupName, setGroupName] = useState('')
  const known = useRef(new Set<string>())

  const load = useCallback(async (fn: () => Promise<ProjectImportBatch | null>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const next = await fn()
      if (!next) return false
      setWarnings(previous => [...new Set([...previous, ...next.warnings])])
      if (!next.candidates.some(c => !known.current.has(c.path))) setNotice(tr('projectImport.noDetected'))
      const before = new Set(known.current)
      for (const c of next.candidates) known.current.add(c.path)
      setCandidates(previous => mergeImportCandidates(previous, next.candidates))
      setPicked(previous => mergePicked(previous, before, next.candidates))
      return true
    } catch (e) {
      setError(translateMessage(e instanceof Error ? e.message : String(e)))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    await load(scanProjectImports)
    // 重新扫描时「没读到新的」不用提示：卡片上的数字已经说明了
    setNotice(null)
    setScanning(false)
  }, [load])

  useEffect(() => {
    if (local) void scan()
  }, [local, scan])

  if (!local)
    return (
      <section>
        <SectionTitle>{tr('projects.title')}</SectionTitle>
        <p className="mb-5 text-meta text-fg-muted">{tr('projectImport.localOnly')}</p>
        <ResumeScanCard onOpened={closeSettings} />
      </section>
    )

  const counts = countBuckets(candidates, hidden)
  const rows = filterCandidates(candidates, bucket, query, hidden)
  const allState = selectAllState(rows, picked)
  // 来源卡片取消勾选后，那些项目即使勾着也不加
  const chosen = candidates.filter(c => isSelectable(c) && picked.has(c.path) && isVisible(c, hidden))
  const newGroup = group === NEW_GROUP
  const trimmedName = Array.from(groupName.trim()).slice(0, GROUP_NAME_LIMIT).join('')
  const failedPaths = new Set(failures.map(f => f.path))

  const toggle = (path: string): void =>
    setPicked(previous => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const toggleAll = (): void =>
    setPicked(previous => {
      const next = new Set(previous)
      for (const c of rows.filter(isSelectable)) {
        if (allState === 'all') next.delete(c.path)
        else next.add(c.path)
      }
      return next
    })
  const remove = (paths: readonly string[]): void => {
    const drop = new Set(paths)
    setCandidates(previous => previous.filter(c => !drop.has(c.path)))
    setPicked(previous => new Set([...previous].filter(p => !drop.has(p))))
    for (const p of drop) known.current.delete(p)
  }

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await addProjectPaths(
        chosen.map(c => c.path),
        { quiet: true },
      )
      if (!result) return
      const ids = [...result.added, ...result.existing].map(p => p.id)
      if (ids.length && (newGroup ? trimmedName : group)) {
        const current = getSidebarPrefs().groups ?? []
        if (newGroup) {
          const id = newGroupId()
          setProjectGroups(createGroup(current, { id, name: trimmedName }, ids))
          // 之后的批次（包括重试）接着放进这个新分区
          setGroup(id)
          setGroupName('')
        } else setProjectGroups(addToGroup(current, group, ids))
      }
      const fresh = Object.fromEntries(result.added.map(p => [p.path, p.id]))
      setAddedIds(previous => ({ ...previous, ...fresh }))
      // 后台查，限制并发；失败当没有，不影响导入
      void prefetchResumeCounts(result.added.map(p => p.id)).catch(() => undefined)
      const done = new Set([...result.added, ...result.existing].map(p => p.path))
      setCandidates(previous => previous.map(c => (done.has(c.path) ? { ...c, added: true } : c)))
      setPicked(new Set(result.failed.map(f => f.path)))
      setFailures(result.failed)
      const summary = addedSummary(result) ?? (result.added.length ? tr('projectImport.added', { n: 1 }) : null)
      if (summary && !result.failed.length) toast(summary)
    } catch (e) {
      setError(translateMessage(e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || scanning
  const empty = !scanning && !candidates.length

  return (
    <section className="flex min-h-full flex-col">
      <SectionTitle>{tr('projects.title')}</SectionTitle>
      <p className="-mt-2 mb-5 text-meta text-fg-muted">{tr('projectImport.settingsIntro')}</p>
      <ResumeScanCard onOpened={closeSettings} />

      <div data-setting-title={tr('projectImport.fromTools')} className="mb-2 flex items-baseline justify-between">
        <span className="text-label font-medium text-fg-muted">{tr('projectImport.fromTools')}</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void scan()}
          className="text-label text-accent-fg hover:underline disabled:opacity-45"
        >
          {tr('projectImport.rescan')}
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2 @max-[720px]:grid-cols-2">
        {IMPORT_TOOLS.map(tool => {
          const { total, addable } = toolCounts(candidates, tool.name)
          const chooseList = (
            <button
              type="button"
              disabled={disabled}
              title={tr('projectImport.chooseListHint', { tool: tool.name })}
              onClick={() => void load(() => pickProjectImports(tool.id))}
              className="text-accent-fg hover:underline disabled:opacity-45"
            >
              {tr('projectImport.chooseList')}
            </button>
          )
          if (scanning || !total)
            return (
              <div
                key={tool.id}
                className={cn(
                  'flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2.5',
                  scanning ? 'border-line' : 'border-dashed border-line-strong bg-subtle',
                )}
              >
                <span className={cn('flex items-center gap-2 text-ui font-medium', !scanning && 'text-fg-muted')}>
                  <span className={cn(!scanning && 'opacity-50')}>
                    <ToolMark id={tool.id} />
                  </span>
                  {tool.name}
                </span>
                <span className="truncate pl-[26px] text-label text-fg-muted">
                  {scanning ? (
                    tr('projectImport.reading')
                  ) : (
                    <>
                      {tr('projectImport.toolNone')} · {chooseList}
                    </>
                  )}
                </span>
              </div>
            )
          const on = !hidden.has(tool.name)
          return (
            <div
              key={tool.id}
              className={cn(
                'relative flex min-w-0 flex-col gap-0.5 rounded-lg border px-3 py-2.5 transition-colors',
                on ? 'border-accent-line bg-accent-soft/45' : 'border-line hover:border-line-strong',
              )}
            >
              <button
                type="button"
                aria-pressed={on}
                aria-label={tr('projectImport.toggleTool', { tool: tool.name })}
                disabled={disabled}
                onClick={() =>
                  setHidden(previous => {
                    const next = new Set(previous)
                    if (on) next.add(tool.name)
                    else next.delete(tool.name)
                    return next
                  })
                }
                className="absolute inset-0 rounded-lg"
              />
              <span className="pointer-events-none flex items-center gap-2 text-ui font-medium">
                <ToolMark id={tool.id} />
                <span className="min-w-0 flex-1 truncate">{tool.name}</span>
                <span
                  className={cn(
                    'grid size-4 shrink-0 place-items-center rounded border-[1.5px]',
                    on ? 'border-accent bg-accent text-accent-on' : 'border-line-strong',
                  )}
                >
                  {on && <Check size={11} strokeWidth={3.2} />}
                </span>
              </span>
              <span className="pointer-events-none truncate pl-[26px] text-label text-fg-muted">
                {tr('projectImport.toolFound', { n: total })} ·{' '}
                {addable ? (
                  <span className="text-accent-fg">{tr('projectImport.toolAddable', { n: addable })}</span>
                ) : (
                  tr('projectImport.toolAllAdded')
                )}
              </span>
            </div>
          )
        })}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-label text-fg-faint">{tr('projectImport.manual')}</span>
        <Button
          variant="ghost"
          icon={FolderPlus}
          disabled={disabled}
          className="h-7 px-2 text-meta font-normal"
          onClick={() => void load(() => pickProjectImports('folders'))}
        >
          {tr('projectImport.chooseFolders')}
        </Button>
        <Button
          variant="ghost"
          icon={FolderInput}
          disabled={disabled}
          className="h-7 px-2 text-meta font-normal"
          onClick={() => void load(() => pickProjectImports('parent'))}
        >
          {tr('projectImport.scanParent')}
        </Button>
        <Button
          variant="ghost"
          icon={ClipboardList}
          disabled={disabled}
          aria-expanded={pasteOpen}
          className={cn('h-7 px-2 text-meta font-normal', pasteOpen && 'bg-selected text-fg')}
          onClick={() => setPasteOpen(open => !open)}
        >
          {tr('projectImport.pastePaths')}
        </Button>
      </div>
      {pasteOpen && (
        <div className="mt-2 rounded-lg border border-line bg-subtle p-2.5">
          <textarea
            autoFocus
            aria-label={tr('projectImport.pastePaths')}
            value={paths}
            disabled={disabled}
            rows={3}
            spellCheck={false}
            onChange={e => setPaths(e.target.value)}
            placeholder={tr('projectImport.pathHint')}
            className="w-full resize-y rounded-md border border-line bg-surface p-2 font-mono text-meta text-fg outline-none focus:border-accent-line"
          />
          <div className="mt-2 flex items-center gap-2">
            <span className="mr-auto text-label text-fg-faint">{tr('projectImport.pathFileHint')}</span>
            <Button
              disabled={disabled}
              className="h-7 px-2.5 text-meta"
              onClick={() => void load(() => pickProjectImports('paths'))}
            >
              {tr('projectImport.pathFile')}
            </Button>
            <Button
              disabled={disabled || !paths.trim()}
              className="h-7 px-2.5 text-meta"
              onClick={() =>
                void load(() => previewProjectPaths(paths)).then(ok => {
                  if (ok) setPaths('')
                })
              }
            >
              {tr('projectImport.addToList')}
            </Button>
          </div>
        </div>
      )}

      {(error || notice || !!warnings.length) && (
        <div className="mt-3 space-y-1 text-meta">
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-fg-muted">
              {notice}
            </p>
          )}
          {warnings.map(w => (
            <p key={w} className="text-warn-fg">
              {translateMessage(w)}
            </p>
          ))}
        </div>
      )}

      {!!failures.length && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/[0.08] px-3 py-2.5 text-meta"
        >
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-fg">{tr('projectImport.failedTitle', { n: failures.length })}</div>
            <ul className="mt-0.5 max-h-20 overflow-auto text-fg-muted">
              {failures.map(f => (
                <li key={f.path} className="break-all">
                  <span className="font-mono">{folderName(f.path)}</span>：{translateMessage(f.error)}
                </li>
              ))}
            </ul>
          </div>
          <Button disabled={disabled} className="h-7 px-2.5 text-meta" onClick={() => void confirm()}>
            {tr('projectImport.retry')}
          </Button>
        </div>
      )}

      {empty ? (
        <div className="mt-5 rounded-lg border border-dashed border-line-strong px-5 py-9 text-center text-meta text-fg-muted">
          <div className="mx-auto mb-3 grid size-11 place-items-center rounded-xl bg-subtle text-fg-faint">
            <Inbox size={22} strokeWidth={1.5} />
          </div>
          <div className="mb-1 text-ui font-medium text-fg">{tr('projectImport.emptyTitle')}</div>
          <div>{tr('projectImport.emptyHint')}</div>
          <div className="mt-3.5 flex justify-center gap-2">
            <Button
              icon={FolderPlus}
              disabled={disabled}
              onClick={() => void load(() => pickProjectImports('folders'))}
            >
              {tr('projectImport.chooseFolders')}
            </Button>
            <Button
              icon={FolderInput}
              disabled={disabled}
              onClick={() => void load(() => pickProjectImports('parent'))}
            >
              {tr('projectImport.scanParent')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-5 mb-2 flex flex-wrap items-center gap-2">
            <label className="flex h-8 min-w-48 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-line-strong">
              <Search size={14} className="shrink-0 text-fg-faint" />
              <input
                aria-label={tr('projectImport.search')}
                value={query}
                disabled={scanning}
                onChange={e => {
                  setQuery(e.target.value)
                  setVisibleCount(PAGE)
                }}
                placeholder={tr('projectImport.search')}
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-faint"
              />
            </label>
            <Segmented
              label={tr('projectImport.filter')}
              value={bucket}
              disabled={scanning}
              onChange={value => {
                setBucket(value)
                setVisibleCount(PAGE)
              }}
              options={(['addable', 'added', 'invalid'] as const).map(value => ({
                value,
                label: `${tr(`projectImport.bucket.${value}`)} ${counts[value]}`,
              }))}
            />
          </div>

          <div className="overflow-hidden rounded-lg border border-line">
            <div className="grid h-8 grid-cols-[36px_minmax(0,1fr)_176px_96px_32px] items-center border-b border-line bg-subtle text-label text-fg-muted @max-[720px]:grid-cols-[36px_minmax(0,1fr)_96px_32px]">
              <span className="grid place-items-center">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={allState === 'all' ? true : allState === 'some' ? 'mixed' : false}
                  aria-label={tr('projectImport.selectAllRows')}
                  disabled={disabled || !rows.some(isSelectable)}
                  onClick={toggleAll}
                  className={cn(
                    'grid size-4 place-items-center rounded border-[1.5px] disabled:opacity-40',
                    allState === 'none' ? 'border-line-strong bg-surface' : 'border-accent bg-accent text-accent-on',
                  )}
                >
                  {allState === 'all' ? (
                    <Check size={11} strokeWidth={3.2} />
                  ) : allState === 'some' ? (
                    <Minus size={11} strokeWidth={3.2} />
                  ) : null}
                </button>
              </span>
              <span>{tr('projectImport.column.project')}</span>
              <span className="@max-[720px]:hidden">{tr('projectImport.column.source')}</span>
              <span>{tr('projectImport.column.status')}</span>
              <span />
            </div>
            {scanning ? (
              Array.from({ length: 5 }, (_, i) => (
                <div
                  key={i}
                  className="grid h-12 grid-cols-[36px_minmax(0,1fr)_176px] items-center border-t border-line-subtle first:border-t-0"
                >
                  <span />
                  <span className="space-y-1.5 pr-4">
                    <span
                      className="block h-2.5 animate-pulse rounded bg-selected"
                      style={{ width: `${40 + ((i * 13) % 30)}%` }}
                    />
                    <span
                      className="block h-2 animate-pulse rounded bg-subtle"
                      style={{ width: `${55 + ((i * 7) % 25)}%` }}
                    />
                  </span>
                  <span className="block h-2.5 w-16 animate-pulse rounded bg-subtle" />
                </div>
              ))
            ) : rows.length ? (
              <ul>
                {rows.slice(0, visibleCount).map(c => {
                  const can = isSelectable(c)
                  const on = can && picked.has(c.path)
                  const status = bucketOf(c)
                  return (
                    <li
                      key={c.path}
                      className={cn(
                        'group grid min-h-12 grid-cols-[36px_minmax(0,1fr)_176px_96px_32px] items-center border-t border-line-subtle first:border-t-0 @max-[720px]:grid-cols-[36px_minmax(0,1fr)_96px_32px]',
                        on ? 'bg-accent-soft/40 hover:bg-accent-soft/65' : can && 'hover:bg-hover',
                      )}
                    >
                      <label className="contents">
                        <span className="grid place-items-center">
                          {can && (
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={disabled}
                              onChange={() => toggle(c.path)}
                              className="size-4 accent-[var(--color-accent)]"
                            />
                          )}
                        </span>
                        <span
                          className={cn('flex min-w-0 items-center gap-2.5 py-1.5 pr-2', can && 'cursor-pointer')}
                          title={c.path}
                        >
                          {status === 'invalid' ? (
                            <FolderX size={16} strokeWidth={1.5} className="shrink-0 text-fg-faint" />
                          ) : (
                            <Folder size={16} strokeWidth={1.5} className="shrink-0 text-fg-faint" />
                          )}
                          <span className="min-w-0">
                            <span className={cn('block truncate text-ui font-medium', !can && 'text-fg-muted')}>
                              {c.name}
                            </span>
                            {/* 路径太长时保留末尾（文件夹名比盘符更有用） */}
                            <span dir="rtl" className="block truncate text-left font-mono text-label text-fg-faint">
                              <bdi>{c.path}</bdi>
                            </span>
                            {addedIds[c.path] && (
                              <ResumeHintLink projectId={addedIds[c.path]} fetch={false} className="block" />
                            )}
                          </span>
                        </span>
                      </label>
                      <span className="flex min-w-0 flex-wrap gap-1 pr-2 @max-[720px]:hidden">
                        {c.sources.map(s => (
                          <span
                            key={s}
                            title={s}
                            className="max-w-full truncate rounded border border-line-subtle bg-subtle px-1.5 text-[11px] leading-[18px] text-fg-secondary"
                          >
                            {sourceLabel(s)}
                          </span>
                        ))}
                      </span>
                      <span>
                        {failedPaths.has(c.path) ? (
                          <span className="rounded-full bg-danger/10 px-2 text-label leading-5 text-danger">
                            {tr('projectImport.failedStatus')}
                          </span>
                        ) : status === 'added' ? (
                          <span className="rounded-full bg-subtle px-2 text-label leading-5 text-fg-muted">
                            {tr('projectImport.alreadyAdded')}
                          </span>
                        ) : status === 'invalid' ? (
                          <span className="rounded-full bg-warn/15 px-2 text-label leading-5 text-warn-fg">
                            {c.issue && tr(`projectImport.issue.${c.issue}`)}
                          </span>
                        ) : null}
                      </span>
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={tr('projectImport.removeCandidate', { name: c.name })}
                        title={tr('projectImport.removeCandidate', { name: c.name })}
                        onClick={() => remove([c.path])}
                        className="grid size-6 place-items-center rounded text-fg-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100"
                      >
                        <X size={14} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="px-4 py-7 text-center text-meta text-fg-faint">
                {query.trim()
                  ? tr('projectImport.noMatch')
                  : tr(
                      bucket === 'addable'
                        ? 'projectImport.allDone'
                        : bucket === 'added'
                          ? 'projectImport.noneAdded'
                          : 'projectImport.noneInvalid',
                    )}
              </p>
            )}
          </div>
          {rows.length > visibleCount && (
            <Button
              variant="ghost"
              className="mt-2 h-7 self-start px-2 text-meta"
              onClick={() => setVisibleCount(count => count + PAGE)}
            >
              {tr('projectImport.showMore', { n: Math.min(visibleCount, rows.length), total: rows.length })}
            </Button>
          )}
          {!scanning && (
            <div className="mt-2 flex items-center justify-between gap-3 text-label text-fg-faint">
              <span>
                {bucket === 'invalid'
                  ? tr('projectImport.footInvalid')
                  : bucket === 'added'
                    ? tr('projectImport.footAdded')
                    : tr('projectImport.footAddable', { n: counts.addable + counts.added + counts.invalid })}
              </span>
              {bucket === 'invalid' && !!counts.invalid && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    remove(rows.map(c => c.path))
                    setBucket('addable')
                  }}
                  className="shrink-0 text-accent-fg hover:underline"
                >
                  {tr('projectImport.clearInvalid')}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* 底部操作栏：贴在设置内容区底部，长列表滚动时也看得到 */}
      <div className="sticky bottom-0 z-10 -mx-8 mt-auto -mb-6 flex flex-wrap items-center gap-3 border-t border-line bg-surface/95 px-8 py-3 backdrop-blur @max-[640px]:-mx-5 @max-[640px]:px-5">
        <span className="text-ui tabular-nums">
          {scanning ? (
            <span className="flex items-center gap-2 text-fg-muted">
              <Spinner />
              {tr('projectImport.reading')}
            </span>
          ) : chosen.length ? (
            tr('projectImport.selectedCount', { n: chosen.length })
          ) : (
            <span className="text-fg-muted">{tr('projectImport.pickHint')}</span>
          )}
        </span>
        <span className="flex items-center gap-1.5 text-meta text-fg-muted">
          {tr('projectImport.groupLabel')}
          <Select
            label={tr('projectImport.groupLabel')}
            value={group}
            disabled={disabled}
            onChange={setGroup}
            options={[
              { value: '', label: tr('projectImport.noGroup') },
              ...groups.map(g => ({ value: g.id, label: g.name })),
              { value: NEW_GROUP, label: tr('projectImport.newGroup') },
            ]}
            fitContent
          />
          {newGroup && (
            <input
              autoFocus
              aria-label={tr('projectImport.groupName')}
              placeholder={tr('projectImport.groupName')}
              value={groupName}
              disabled={disabled}
              maxLength={GROUP_NAME_LIMIT * 2}
              onChange={e => setGroupName(e.target.value)}
              className="h-8 w-36 rounded-md border border-accent-line bg-surface px-2 text-ui text-fg outline-none"
            />
          )}
        </span>
        <Button
          variant="primary"
          className="ml-auto"
          disabled={disabled || !chosen.length || (newGroup && !trimmedName)}
          onClick={() => void confirm()}
        >
          {busy
            ? tr('projectImport.working')
            : chosen.length
              ? tr('projectImport.confirm', { n: chosen.length })
              : tr('projectImport.confirmNone')}
        </Button>
      </div>
    </section>
  )
}
