import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUpRight,
  ChevronRight,
  File,
  FileArchive,
  FileCode2,
  FileText,
  Film,
  Globe,
  Image,
  MessageSquareText,
  Package,
  RefreshCw,
  Sheet,
  type LucideIcon,
} from 'lucide-react'
import { cn, DiffStat, EngineIcon, IconButton, Segmented, Spinner, useToast } from '@/ui'
import { DiffView } from '@/ui/code/DiffView'
import { scrollInPane } from '@/ui/scrollInPane'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { OPEN_SESSION_EVENT } from '@/features/engine/openRequests'
import { relativeTime } from '@/features/engine'
import { motionEnabled } from '@/features/panes/motion'
import { openFile } from '@/features/files/store'
import { machineOf } from '@/features/machines/store'
import type { ArtifactDelivery, ArtifactFile, ArtifactResponse, ArtifactTurn, DeliveryType } from '@pixelsky/protocol'
import type { WorkspaceRef } from '../../../../../shared/types/workspace'
import { useProjectContext } from '../projectContext'
import { NoProject, useRemember } from '../ToolsUi'
import { EmptyState, PanelCard } from '../PanelSurface'
import { artifactDiffs, groupBySession, nextArtifactsRequest, splitArtifactPath } from './artifactsModel'
import { ArtifactPreview } from './ArtifactPreview'
import {
  DELIVERED_MAX,
  EMPTY_FOLD,
  TURN_FILES_MAX,
  collapseAll,
  collapseAllDelivered,
  deliveredOpen,
  expandAll,
  expandAllDelivered,
  groupDelivered,
  readFold,
  revealTurn,
  sessionOpen,
  toggleDelivered,
  toggleSession,
  toggleTurn,
  turnOpen,
  turnsSummary,
  type DeliveredGroup,
  type FoldState,
} from './fold'
import { demo as demoData } from '@/data/demo'
import {
  FOCUS_OPEN_MAX,
  findFocusTurn,
  finishArtifactsFocus,
  finishPreviewRequest,
  freshFocus,
  turnKey,
  useArtifactsFocus,
  usePreviewRequest,
  type ArtifactsFocus,
} from './focus'

const DAYS = 7
/** Windows 上同一个文件的路径不区分大小写 */
const caseInsensitive = typeof window !== 'undefined' && window.pixelsky?.platform === 'win32'
const TYPE_ICON: Record<DeliveryType | 'other', LucideIcon> = {
  document: FileText,
  image: Image,
  table: Sheet,
  web: Globe,
  archive: FileArchive,
  media: Film,
  other: File,
}
const openSession = (sessionId: string, itemId: string | null) =>
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId, ...(itemId ? { itemId } : {}) } }))

export function ArtifactsPanel({ active }: { active: boolean }) {
  useI18n()
  const context = useProjectContext()
  if (!context.ref && !context.demo) return <NoProject />
  return (
    <ArtifactsBody
      key={context.key + ':' + JSON.stringify(context.ref)}
      target={context.ref ?? { projectId: 'demo' }}
      name={context.name}
      demo={context.demo}
      active={active}
    />
  )
}

function ArtifactsBody({
  target,
  name,
  demo,
  active,
}: {
  target: WorkspaceRef
  name: string
  demo: boolean
  active: boolean
}) {
  useI18n()
  const [tab, setTab] = useRemember<'changes' | 'delivered'>('pixelsky.artifacts.tab', 'changes')
  const [data, setData] = useState<ArtifactResponse | null>(demo ? demoData().artifacts.response : null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<ArtifactDelivery | null>(null)
  const request = useRef(0)
  const [now, setNow] = useState(Date.now)
  const remote = machineOf(target.sessionId ?? target.projectId) !== 'local'
  const toast = useToast()
  // 伸缩（fold.ts）：按项目记在本机；「交付」按类型筛选只在这次打开里有效
  const [storedFold, storeFold] = useRemember<FoldState>('pixelsky.artifacts.fold.' + target.projectId, EMPTY_FOLD)
  const fold = readFold(storedFold)
  const latestFold = useRef({ fold, storeFold })
  latestFold.current = { fold, storeFold }
  const [deliveredType, setDeliveredType] = useState<ArtifactDelivery['type'] | 'all'>('all')

  const load = async () => {
    if (demo || !window.pixelsky) return
    const id = (request.current = nextArtifactsRequest())
    setLoading(true)
    try {
      const res = await window.pixelsky.artifacts.list({
        requestId: id,
        ...(target.sessionId ? { sessionId: target.sessionId } : { projectId: target.projectId }),
        days: DAYS,
      })
      if (id === request.current && !res.cancelled) {
        setData(res)
        setError('')
        setNow(Date.now())
      }
    } catch (e) {
      if (id === request.current) setError((e as Error).message)
    } finally {
      if (id === request.current) setLoading(false)
    }
  }

  // 打开产物页时读取；可见时回合结束（去抖）再读
  useEffect(() => {
    if (!active || demo || !window.pixelsky) return
    void load()
    let timer = 0
    const off = window.pixelsky.engine.onEvent(e => {
      if (e.kind === 'session' && e.event.type === 'turn_completed') {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => void load(), 800)
      }
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [active])

  // 「审查」（docs/ui/conversation-ux.md §2.1）：切到「改动」并重新读一次（这一轮可能刚结束，数据还没刷新），
  // 读完后滚到这一轮、闪一下、展开各文件的 diff；找不到时提示
  const focus = useArtifactsFocus()
  const pendingFocus = useRef<{ focus: ArtifactsFocus; after: number } | null>(null)
  const [focused, setFocused] = useState<{ key: string; token: number } | null>(null)
  const latest = useRef({ load, setTab })
  latest.current = { load, setTab }
  useEffect(() => {
    if (!active || !freshFocus(focus) || pendingFocus.current?.focus.token === focus.token) return
    latest.current.setTab('changes')
    const reload = !demo && !!window.pixelsky
    pendingFocus.current = { focus, after: request.current + (reload ? 1 : 0) }
    if (reload) void latest.current.load()
  }, [focus, active, demo])
  useEffect(() => {
    const pending = pendingFocus.current
    if (!pending || loading || !data || request.current < pending.after) return
    pendingFocus.current = null
    finishArtifactsFocus(pending.focus.token)
    const turn = findFocusTurn(data.turns, pending.focus)
    if (turn) {
      // 定位的这一轮和它的会话可能收着：先展开，TurnBlock 才在、才能滚过去
      latestFold.current.storeFold(revealTurn(latestFold.current.fold, turn))
      setFocused({ key: turnKey(turn), token: pending.focus.token })
    } else toast(tr('artifacts.focusMissing'))
  }, [data, loading, toast])
  useEffect(() => {
    if (!focused) return
    const timer = window.setTimeout(() => setFocused(null), 2000)
    return () => window.clearTimeout(timer)
  }, [focused])

  // 概况「产出」点了一个文件：直接打开它的预览
  const wanted = usePreviewRequest()
  useEffect(() => {
    if (!active || !wanted) return
    finishPreviewRequest(wanted.token)
    if (freshFocus(wanted)) setPreview(wanted.item)
  }, [wanted, active])

  const groups = useMemo(() => groupBySession(data?.turns ?? []), [data])
  const deliveredTypes = useMemo(() => [...new Set((data?.delivered ?? []).map(d => d.type))], [data])
  // 刷新后选的类型没有了：回到全部
  const activeType = deliveredType !== 'all' && deliveredTypes.includes(deliveredType) ? deliveredType : 'all'
  const deliveredGroups = useMemo(
    () => groupDelivered((data?.delivered ?? []).filter(d => activeType === 'all' || d.type === activeType)),
    [data, activeType],
  )
  const turnCount = groups.reduce((n, g) => n + g.turns.length, 0)
  const deliveredCount = deliveredGroups.reduce((n, g) => n + g.items.length, 0)
  if (preview)
    return (
      <ArtifactPreview
        item={preview}
        demo={demo}
        remote={remote}
        onBack={() => setPreview(null)}
        onError={setError}
        onOpenInEditor={
          preview.local && preview.inside && preview.exists ? () => void openFile(target, preview.local!) : undefined
        }
      />
    )

  return (
    <div data-artifacts-panel className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-ui font-medium text-fg">{tr('artifacts.title')}</h2>
          <p className="truncate text-meta text-fg-muted">
            {name} · {tr('artifacts.window', { days: DAYS })}
          </p>
        </div>
        {loading && <Spinner size={13} />}
        <IconButton
          icon={RefreshCw}
          label={tr('artifacts.refresh')}
          disabled={loading || demo}
          onClick={() => void load()}
        />
      </div>
      <div className="shrink-0 px-3 pt-2">
        <Segmented
          label={tr('artifacts.tabs')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'changes', label: tr('artifacts.tab.changes') },
            {
              value: 'delivered',
              label: `${tr('artifacts.tab.delivered')}${data?.delivered.length ? ` ${data.delivered.length}` : ''}`,
            },
          ]}
        />
      </div>
      {data && tab === 'delivered' && deliveredTypes.length > 1 && (
        <div
          role="radiogroup"
          aria-label={tr('artifacts.typeFilter')}
          className="flex shrink-0 flex-wrap gap-1 px-3 pt-2"
        >
          {(['all', ...deliveredTypes] as const).map(t => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={activeType === t}
              onClick={() => setDeliveredType(t)}
              className={cn(
                'rounded-full border px-2 text-meta leading-5',
                activeType === t
                  ? 'border-transparent bg-accent-soft text-accent-fg'
                  : 'border-line text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              {tr(`artifacts.type.${t}`)}{' '}
              {t === 'all' ? data.delivered.length : data.delivered.filter(d => d.type === t).length}
            </button>
          ))}
        </div>
      )}
      {data && (tab === 'changes' ? groups.length > 0 : deliveredGroups.length > 0) && (
        <div className="flex shrink-0 items-center gap-0.5 px-3 pt-1.5 text-meta text-fg-muted">
          <span className="min-w-0 flex-1 truncate">
            {tab === 'changes'
              ? tr('artifacts.countChanges', { sessions: groups.length, turns: turnCount })
              : tr('artifacts.countDelivered', { sessions: deliveredGroups.length, files: deliveredCount })}
          </span>
          <button
            type="button"
            onClick={() =>
              storeFold(
                tab === 'changes'
                  ? expandAll(fold, groups)
                  : expandAllDelivered(
                      fold,
                      deliveredGroups.map(g => g.sessionId),
                    ),
              )
            }
            className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg"
          >
            {tr('artifacts.expandAll')}
          </button>
          <button
            type="button"
            onClick={() =>
              storeFold(
                tab === 'changes'
                  ? collapseAll(fold, groups)
                  : collapseAllDelivered(
                      fold,
                      deliveredGroups.map(g => g.sessionId),
                    ),
              )
            }
            className="shrink-0 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-fg"
          >
            {tr('artifacts.collapseAll')}
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {error && (
          <p role="alert" className="shrink-0 rounded-md bg-subtle p-2 text-meta text-danger">
            {translateMessage(error)}
          </p>
        )}
        {!data ? (
          <div className="flex items-center justify-center gap-2 p-6 text-meta text-fg-muted">
            <Spinner size={13} />
            {tr('projectTools.loading')}
          </div>
        ) : tab === 'changes' ? (
          groups.length === 0 ? (
            <PanelCard>
              <EmptyState
                icon={Package}
                title={tr('artifacts.changesEmpty', { days: DAYS })}
                hint={tr('artifacts.changesHint')}
              />
            </PanelCard>
          ) : (
            groups.map(g => {
              const open = sessionOpen(fold, g.sessionId)
              const sum = open ? null : turnsSummary(g.turns)
              return (
                <section
                  key={g.sessionId}
                  data-artifact-session={g.sessionId}
                  className="shrink-0 rounded-lg border border-line-card bg-surface shadow-sm"
                >
                  <CardHead
                    open={open}
                    onToggle={() => storeFold(toggleSession(fold, g.sessionId))}
                    onJump={() => openSession(g.sessionId, null)}
                  >
                    <EngineIcon engine={g.engine} size={14} />
                    <span className="min-w-0 flex-1 truncate text-list font-medium text-fg">{g.title}</span>
                    {g.archived && (
                      <span className="shrink-0 rounded bg-subtle px-1.5 text-meta text-fg-muted">
                        {tr('artifacts.archived')}
                      </span>
                    )}
                    {sum && (
                      <>
                        <span className="shrink-0 text-meta text-fg-faint">
                          {tr('artifacts.sessionSummary', { turns: g.turns.length, files: sum.files })}
                        </span>
                        <DiffStat added={sum.added} removed={sum.removed} className="text-meta" />
                      </>
                    )}
                  </CardHead>
                  {open &&
                    g.turns.map(turn => (
                      <TurnBlock
                        key={turnKey(turn)}
                        turn={turn}
                        target={target}
                        demo={demo}
                        now={now}
                        open={turnOpen(fold, g, turn)}
                        onToggle={() => storeFold(toggleTurn(fold, g, turn))}
                        focusToken={focused?.key === turnKey(turn) ? focused.token : undefined}
                      />
                    ))}
                </section>
              )
            })
          )
        ) : data.delivered.length === 0 ? (
          <PanelCard>
            <EmptyState icon={Package} title={tr('artifacts.deliveredEmpty')} hint={tr('artifacts.deliveredHint')} />
          </PanelCard>
        ) : (
          deliveredGroups.map(g => (
            <DeliveredCard
              key={g.sessionId}
              group={g}
              now={now}
              open={deliveredOpen(fold, g.sessionId)}
              onToggle={() => storeFold(toggleDelivered(fold, g.sessionId))}
              onOpen={setPreview}
            />
          ))
        )}
        {data && tab === 'changes' && data.outsideCount > 0 && (
          <button
            type="button"
            onClick={() => setTab('delivered')}
            className="shrink-0 self-start rounded-md px-1 text-meta text-accent-fg hover:underline"
          >
            {tr('artifacts.outside', { count: data.outsideCount })}
          </button>
        )}
        {data?.truncated && <p className="shrink-0 text-meta text-warn">{tr('artifacts.truncated')}</p>}
        {data?.partial && <p className="shrink-0 text-meta text-fg-faint">{tr('artifacts.partial')}</p>}
      </div>
    </div>
  )
}

/** 会话卡片的标题行：点它收起 / 展开；行尾「跳到对话」鼠标移上去才出现（原来点标题就是跳转，现在改成伸缩） */
function CardHead({
  open,
  onToggle,
  onJump,
  children,
}: {
  open: boolean
  onToggle(): void
  onJump(): void
  children: ReactNode
}) {
  useI18n()
  return (
    <div
      className={cn(
        'group/head flex min-w-0 items-center gap-1 pr-1.5 hover:bg-hover',
        open ? 'rounded-t-lg border-b border-line-subtle' : 'rounded-lg',
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2 text-left"
      >
        <ChevronRight size={12} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
        {children}
      </button>
      <IconButton
        icon={ArrowUpRight}
        label={tr('artifacts.jump')}
        size={22}
        iconSize={12}
        onClick={onJump}
        className="opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100"
      />
    </div>
  )
}

function TurnBlock({
  turn,
  target,
  demo,
  now,
  open,
  onToggle,
  focusToken,
}: {
  turn: ArtifactTurn
  target: WorkspaceRef
  demo: boolean
  now: number
  open: boolean
  onToggle(): void
  /** 「审查」定位到这一轮：滚过来、闪一下、展开前几个文件的 diff */
  focusToken?: number
}) {
  useI18n()
  const ref = useRef<HTMLDivElement>(null)
  // 文件太多时先列一部分；「审查」定位过来时全列出（记在状态里：定位的高亮两秒后就撤，列表不能跟着缩回去）
  const [all, setAll] = useState(!!focusToken)
  useEffect(() => {
    if (!focusToken) return
    setAll(true)
    if (ref.current) scrollInPane(ref.current, 'start', { behavior: motionEnabled() ? 'smooth' : 'auto' })
  }, [focusToken])
  const full = all || turn.files.length <= TURN_FILES_MAX
  const files = full ? turn.files : turn.files.slice(0, TURN_FILES_MAX)
  const sum = open ? null : turnsSummary([turn])
  return (
    <div
      ref={ref}
      data-artifact-turn={turnKey(turn)}
      className={cn('border-b border-line-subtle px-1.5 py-1 last:border-b-0', !!focusToken && 'search-hit')}
    >
      <div className="group/turn flex min-w-0 items-center gap-1 rounded-md pr-0.5 hover:bg-hover">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5 text-left text-meta',
            open ? 'text-fg-secondary' : 'text-fg-muted',
          )}
        >
          <ChevronRight size={12} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
          <span className="min-w-0 flex-1 truncate">{turn.prompt || tr('artifacts.noPrompt')}</span>
          {sum && (
            <>
              <span className="shrink-0 rounded bg-subtle px-1 leading-4 text-fg-muted">
                {tr('artifacts.turnFiles', { count: sum.files })}
              </span>
              <DiffStat added={sum.added} removed={sum.removed} />
            </>
          )}
          <span className="shrink-0 text-fg-faint tabular-nums">{relativeTime(turn.at, now)}</span>
        </button>
        <IconButton
          icon={ArrowUpRight}
          label={tr('artifacts.jumpTurn')}
          size={22}
          iconSize={12}
          onClick={() => openSession(turn.sessionId, turn.userItemId)}
          className="opacity-0 group-hover/turn:opacity-100 focus-visible:opacity-100"
        />
      </div>
      {open && (
        <>
          <ul className="flex flex-col pl-3">
            {files.map((f, i) => (
              <FileRow
                key={f.absolute}
                file={f}
                turn={turn}
                target={target}
                demo={demo}
                autoOpen={focusToken && i < FOCUS_OPEN_MAX ? focusToken : undefined}
              />
            ))}
          </ul>
          {!full && (
            <button
              type="button"
              onClick={() => setAll(true)}
              className="mt-0.5 ml-5 rounded-md px-1 text-meta text-accent-fg hover:underline"
            >
              {tr('artifacts.moreFiles', { count: turn.files.length - TURN_FILES_MAX })}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function FileRow({
  file,
  turn,
  target,
  demo,
  autoOpen,
}: {
  file: ArtifactFile
  turn: ArtifactTurn
  target: WorkspaceRef
  demo: boolean
  /** 变成新的数字时展开（「审查」） */
  autoOpen?: number
}) {
  useI18n()
  const [open, setOpen] = useState(false)
  // 这一轮改过这个文件的每次 diff（按先后）；同一轮改了几次时行数是合计，要全显示
  const [diffs, setDiffs] = useState<string[] | null | 'loading'>(null)
  const { name, dir } = splitArtifactPath(file.local ?? file.path)
  const toggle = async () => {
    if (open) {
      setOpen(false)
      return
    }
    await show()
  }
  // 取到的 diff 对应哪组改动记录；这一轮之后又改了这个文件（列表刷新）时重新取
  const idsKey = file.itemIds.join('\n')
  const loadedFor = useRef('')
  const show = async () => {
    setOpen(true)
    if (diffs && diffs !== 'loading' && loadedFor.current === idsKey) return
    loadedFor.current = idsKey
    setDiffs('loading')
    if (demo) {
      const changes = file.itemIds.map(itemId => demoData().artifacts.changes(itemId))
      setDiffs(artifactDiffs(file, changes, caseInsensitive))
      return
    }
    const items = await Promise.all(
      file.itemIds.map(itemId =>
        window.pixelsky!.artifacts.change({ sessionId: turn.sessionId, itemId }).catch(() => null),
      ),
    )
    if (loadedFor.current !== idsKey) return
    const changes = items.map(item => item?.changes ?? null)
    setDiffs(artifactDiffs(file, changes, caseInsensitive))
  }
  const latestShow = useRef(show)
  latestShow.current = show
  useEffect(() => {
    if (autoOpen) void latestShow.current()
  }, [autoOpen])
  const latestOpen = useRef(open)
  latestOpen.current = open
  useEffect(() => {
    if (latestOpen.current && loadedFor.current && loadedFor.current !== idsKey) void latestShow.current()
  }, [idsKey])
  return (
    <li className="group/file">
      <div className="flex h-7 min-w-0 items-center gap-1 rounded-md pr-0.5 hover:bg-hover">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => void toggle()}
          title={open ? tr('artifacts.hideDiff') : tr('artifacts.viewDiff')}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md pl-1.5 text-left"
        >
          <ChevronRight size={12} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
          {/* 长文件名能缩（最少留几个字），目录只拿剩下的空间、先缩没；标签和 +N −M 不缩，不会被挤到悬停按钮底下 */}
          <span
            title={file.path}
            className={cn(
              'min-w-[4em] truncate text-list',
              file.kind === 'delete' ? 'text-fg-muted line-through' : 'text-fg',
            )}
          >
            {name}
          </span>
          {dir && <span className="min-w-0 flex-[1_1_0] truncate text-meta text-fg-faint">{dir}</span>}
          {file.kind !== 'update' && (
            <span
              className={cn(
                'shrink-0 rounded px-1 text-[10px] leading-4 font-medium',
                file.kind === 'add' ? 'bg-subtle text-success' : 'bg-subtle text-danger',
              )}
            >
              {tr(file.kind === 'add' ? 'artifacts.kind.add' : 'artifacts.kind.delete')}
            </span>
          )}
          {!dir && <span className="flex-1" />}
          <DiffStat added={file.added} removed={file.removed} className="text-meta" />
        </button>
        <span className="flex shrink-0 items-center opacity-0 group-hover/file:opacity-100 group-focus-within/file:opacity-100">
          {file.local && file.kind !== 'delete' && (
            <IconButton
              icon={FileCode2}
              label={tr('artifacts.openFile')}
              size={22}
              iconSize={12}
              onClick={() => void openFile(target, file.local!)}
            />
          )}
          <IconButton
            icon={MessageSquareText}
            label={tr('artifacts.jump')}
            size={22}
            iconSize={12}
            onClick={() => openSession(turn.sessionId, file.itemId)}
          />
        </span>
      </div>
      {open && (
        <div className="mb-1.5 ml-5 overflow-hidden rounded-md border border-line-subtle">
          {diffs === 'loading' ? (
            <div className="flex items-center gap-2 p-2 text-meta text-fg-muted">
              <Spinner size={12} />
              {tr('projectTools.loading')}
            </div>
          ) : diffs?.length ? (
            <div className="max-h-80 overflow-auto">
              {diffs.map((diff, i) => (
                <DiffView
                  key={i}
                  diff={diff}
                  path={file.path}
                  className={i > 0 ? 'border-t border-line-subtle' : undefined}
                />
              ))}
            </div>
          ) : (
            <p className="p-2 text-meta text-fg-faint">{tr('artifacts.diffMissing')}</p>
          )}
        </div>
      )}
    </li>
  )
}

/** 「交付」的一个会话：标题行能收起；交付多时先列几个 */
function DeliveredCard({
  group,
  now,
  open,
  onToggle,
  onOpen,
}: {
  group: DeliveredGroup
  now: number
  open: boolean
  onToggle(): void
  onOpen(item: ArtifactDelivery): void
}) {
  useI18n()
  const [all, setAll] = useState(false)
  const full = all || group.items.length <= DELIVERED_MAX
  const items = full ? group.items : group.items.slice(0, DELIVERED_MAX)
  return (
    <section
      data-artifact-delivered-session={group.sessionId}
      className="shrink-0 rounded-lg border border-line-card bg-surface shadow-sm"
    >
      <CardHead open={open} onToggle={onToggle} onJump={() => openSession(group.sessionId, null)}>
        <span className="min-w-0 flex-1 truncate text-list font-medium text-fg">{group.title}</span>
        {!open && (
          <span className="shrink-0 text-meta text-fg-faint">
            {tr('artifacts.deliveredSummary', { count: group.items.length, time: relativeTime(group.at, now) })}
          </span>
        )}
      </CardHead>
      {open && (
        <ul className="flex flex-col px-1.5 py-1">
          {items.map(d => (
            <DeliveryRow key={d.absolute} item={d} now={now} onOpen={() => onOpen(d)} />
          ))}
          {!full && (
            <li>
              <button
                type="button"
                onClick={() => setAll(true)}
                className="ml-1 rounded-md px-1 text-meta text-accent-fg hover:underline"
              >
                {tr('artifacts.moreDelivered', { count: group.items.length - DELIVERED_MAX })}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

/** 交付的一个文件：一行（类型图标、文件名、目录、时间），点开预览 */
function DeliveryRow({ item, now, onOpen }: { item: ArtifactDelivery; now: number; onOpen: () => void }) {
  useI18n()
  const Icon = TYPE_ICON[item.type]
  const { name, dir } = splitArtifactPath(item.local ?? item.absolute)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        data-artifact-delivery={item.absolute}
        title={item.absolute}
        className={cn(
          'flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-hover',
          !item.exists && 'opacity-60',
        )}
      >
        <Icon size={14} className="shrink-0 text-fg-muted" />
        <span className="min-w-[4em] truncate text-list text-fg">{name}</span>
        {dir ? (
          <span className="min-w-0 flex-[1_1_0] truncate text-meta text-fg-faint">{dir}</span>
        ) : (
          <span className="flex-1" />
        )}
        {!item.inside && (
          <span className="shrink-0 rounded bg-subtle px-1 text-[10px] leading-4 text-fg-muted">
            {tr('artifacts.outsideBadge')}
          </span>
        )}
        {!item.exists && <span className="shrink-0 text-meta text-danger">{tr('artifacts.missing')}</span>}
        <span className="shrink-0 text-meta text-fg-faint tabular-nums">{relativeTime(item.at, now)}</span>
      </button>
    </li>
  )
}
