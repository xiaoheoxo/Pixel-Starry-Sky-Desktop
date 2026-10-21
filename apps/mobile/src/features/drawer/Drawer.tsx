// 抽屉（docs/mobile-remote.md §18.3、§21.3 C3）：窄屏从左边拉出来，宽屏常驻左边。从上到下：
// 电脑切换、搜索会话、新建会话（右边是当前项目）、最近对话（「等你处理」置顶，和首页同一种行），
// 最下面是会话列表、更多、我的。「更多」里是换当前项目、加项目、当前项目的工具（Git / 文件 / 产物 / 任务）和刷新。
import { useState } from 'react'
import {
  Check,
  ChevronsUpDown,
  FileCode2,
  Folder,
  FolderPlus,
  GitBranch,
  LayoutList,
  ListChecks,
  MoreHorizontal,
  Package,
  Plus,
  RefreshCw,
  SquarePen,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import type { ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import { connections } from '@/connection'
import { desktopLists } from '@/data/desktop'
import { useConnections, useContentSearch, useDesktop } from '@/data/hooks'
import { ago, filterTasks, groupTasks, sessionList, sessionStatus, taskTitle } from '@/data/tasks'
import { TOOL_NAMES, toolError, type ToolId } from '@/data/tools'
import { linkStateText } from '@/i18n/zh'
import { Dot, Spinner, cn } from '@/ui'
import { ContentResults, SearchField } from '@/ui/search'
import { SessionRow } from '@/ui/SessionRow'
import { Sheet } from '@/ui/sheet'

const TOOLS: readonly { id: ToolId; icon: LucideIcon }[] = [
  { id: 'git', icon: GitBranch },
  { id: 'files', icon: FileCode2 },
  { id: 'artifacts', icon: Package },
  { id: 'tasks', icon: ListChecks },
]

/** 抽屉里先列几个会话，点「显示更多」再加这么多 */
const DRAWER_STEP = 30

export interface DrawerProps {
  deviceId: string
  /** 当前打开的页面（高亮用） */
  page: 'home' | 'me' | 'session' | 'other'
  openSession: string | null
  /** 当前项目：「新建会话」和工具作用于它 */
  project: ProjectRecord | null
  onSession(sessionId: string): void
  onNew(projectId: string | null): void
  onTool(tool: ToolId, projectId: string): void
  /** 换当前项目 */
  onProject(projectId: string): void
  onAddProject(): void
  onHome(): void
  onMe(): void
  /** 扫码加电脑（能扫码时才有） */
  onAddComputer(): void
}

export function Drawer(props: DrawerProps) {
  const { deviceId, page, openSession, project, onSession, onNew, onHome, onMe } = props
  const { link, state, sessions, projects, loaded } = useDesktop(deviceId)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(DRAWER_STEP)
  const [more, setMore] = useState(false)
  const ready = state === 'ready'
  const canAct = ready && link?.hello?.access === 'act'
  const searching = !!query.trim()
  const content = useContentSearch(deviceId, query, null)
  const projectName = (s: SessionSummary) => projects.find(p => p.id === s.record.projectId)?.name ?? ''
  const list = sessionList(filterTasks(sessions, query, null, projectName), searching ? Infinity : limit)
  const rows = [...list.waiting, ...list.rest]
  const waiting = groupTasks(sessions).waiting.length
  const manyProjects = projects.length > 1

  return (
    <nav aria-label="导航" className="flex h-full min-h-0 flex-col bg-sidebar text-fg">
      <div className="flex shrink-0 flex-col gap-2 px-3 pt-[max(env(safe-area-inset-top),12px)] pb-2">
        <ComputerSwitcher deviceId={deviceId} onAdd={props.onAddComputer} />
        <SearchField value={query} onChange={setQuery} placeholder="搜索会话" className="bg-surface" />
        <button
          type="button"
          disabled={!canAct || !projects.length}
          onClick={() => onNew(project?.id ?? null)}
          className="flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-ui text-fg active:bg-hover disabled:opacity-40"
        >
          <SquarePen size={18} strokeWidth={1.75} className="shrink-0 text-fg-secondary" />
          <span className="shrink-0">新建会话</span>
          {project && <span className="ml-auto truncate text-meta text-fg-muted">{project.name}</span>}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {searching && !content.unsupported && (
          <ContentResults
            className="px-1 pt-1 pb-3"
            results={content.results}
            loading={content.loading}
            truncated={content.truncated}
            when={ago}
            onOpen={onSession}
          />
        )}
        <h2 className="px-3 pt-1 pb-1.5 text-meta font-medium text-fg-muted">{searching ? '标题匹配' : '最近对话'}</h2>
        {!loaded ? (
          <div className="flex items-center justify-center gap-2 py-10 text-meta text-fg-muted">
            {state && state !== 'ready' ? linkStateText[state] : <Spinner />}
          </div>
        ) : !rows.length ? (
          <p className="px-3 py-6 text-meta text-fg-muted">
            {searching ? '没有匹配的会话' : projects.length ? '还没有会话' : '电脑上还没有项目，到「更多」里添加一个。'}
          </p>
        ) : (
          <div className="flex flex-col">
            {rows.map(s => (
              <SessionRow
                key={s.record.id}
                dense
                engine={s.record.engine}
                title={taskTitle(s)}
                time={ago(s.record.updatedAt)}
                project={manyProjects ? projectName(s) : undefined}
                preview={s.record.lastReply}
                status={sessionStatus(s)}
                pinned={!!s.record.pinnedAt && s.state !== 'waiting'}
                active={s.record.id === openSession}
                onClick={() => onSession(s.record.id)}
              />
            ))}
            {!searching && list.more > 0 && (
              <button
                type="button"
                onClick={() => setLimit(n => n + DRAWER_STEP)}
                className="min-h-10 rounded-xl px-3 text-left text-meta text-accent-fg active:bg-hover"
              >
                显示更多（还有 {list.more} 个）
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 gap-1 border-t border-line-subtle px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom),6px)]">
        <FooterButton icon={LayoutList} label="会话" active={page === 'home'} badge={waiting} onClick={onHome} />
        <FooterButton icon={MoreHorizontal} label="更多" active={false} onClick={() => setMore(true)} />
        <FooterButton icon={UserRound} label="我的" active={page === 'me'} onClick={onMe} />
      </div>
      {more && <MoreSheet {...props} canAct={canAct} onClose={() => setMore(false)} />}
    </nav>
  )
}

function FooterButton({
  icon: Icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  badge?: number
  onClick(): void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl text-ui active:bg-hover',
        active ? 'bg-selected font-medium text-fg' : 'text-fg-secondary',
      )}
    >
      <Icon size={18} strokeWidth={1.75} />
      {label}
      {!!badge && (
        <span className="min-w-5 rounded-full bg-danger px-1.5 text-center text-label leading-5 text-accent-on">
          {badge}
        </span>
      )}
    </button>
  )
}

/** 「更多」：当前项目（点一个换）、加项目、当前项目的工具、刷新列表 */
function MoreSheet({
  deviceId,
  project,
  canAct,
  onTool,
  onProject,
  onAddProject,
  onClose,
}: DrawerProps & { canAct: boolean; onClose(): void }) {
  const { link, state, projects } = useDesktop(deviceId)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const ready = state === 'ready'
  const tools = ready && !!link?.hello?.tools
  const refresh = () => {
    setRefreshing(true)
    setRefreshError(null)
    void desktopLists
      .refresh(deviceId)
      .catch(e => setRefreshError(`刷新失败：${toolError(e)}`))
      .finally(() => setRefreshing(false))
  }
  return (
    <Sheet title="更多" onClose={onClose}>
      <div className="flex flex-col gap-5 py-3">
        {project && (
          <section className="flex flex-col">
            <h3 className="px-4 pb-1.5 text-meta font-medium text-fg-muted">「{project.name}」的工具</h3>
            <div className="mx-3 grid grid-cols-4 gap-1.5">
              {TOOLS.map(({ id, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  disabled={!tools}
                  onClick={() => {
                    onClose()
                    onTool(id, project.id)
                  }}
                  className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-line-subtle bg-surface text-label text-fg-secondary active:bg-hover disabled:opacity-40"
                >
                  <Icon size={20} strokeWidth={1.75} />
                  {TOOL_NAMES[id]}
                </button>
              ))}
            </div>
            {!tools && ready && (
              <p className="px-4 pt-1.5 text-label text-fg-faint">电脑上的像素星空版本较旧，更新后才能用。</p>
            )}
          </section>
        )}
        <section className="flex flex-col">
          <h3 className="px-4 pb-1.5 text-meta font-medium text-fg-muted">当前项目</h3>
          <div className="mx-3 overflow-hidden rounded-xl border border-line-subtle bg-surface">
            {projects.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={p.id === project?.id}
                onClick={() => onProject(p.id)}
                className={cn(
                  'flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-hover',
                  i > 0 && 'border-t border-line-subtle',
                )}
              >
                <Folder size={18} strokeWidth={1.75} className="shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-ui">{p.name}</span>
                {p.id === project?.id && <Check size={18} className="shrink-0 text-accent-fg" />}
              </button>
            ))}
            <button
              type="button"
              disabled={!canAct || !tools}
              onClick={() => {
                onClose()
                onAddProject()
              }}
              className={cn(
                'flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left text-ui text-accent-fg active:bg-hover disabled:opacity-40',
                projects.length > 0 && 'border-t border-line-subtle',
              )}
            >
              <FolderPlus size={18} strokeWidth={1.75} className="shrink-0" />
              添加项目
            </button>
          </div>
        </section>
        <button
          type="button"
          disabled={!ready || refreshing}
          onClick={refresh}
          className="mx-3 flex min-h-12 items-center justify-center gap-2 rounded-xl border border-line-subtle bg-surface text-ui text-fg-secondary active:bg-hover disabled:opacity-40"
        >
          <RefreshCw size={16} className={cn(refreshing && 'animate-spin')} />
          刷新列表
        </button>
        {refreshError && <p className="-mt-3 px-4 text-meta text-danger">{refreshError}</p>}
      </div>
    </Sheet>
  )
}

/** 电脑切换：名字、状态；点开列出配对过的电脑和「添加电脑」 */
function ComputerSwitcher({ deviceId, onAdd }: { deviceId: string; onAdd(): void }) {
  const { list } = useConnections()
  const [open, setOpen] = useState(false)
  const active = list.find(p => p.deviceId === deviceId)
  const state = connections.state(deviceId)
  const tone = (s: typeof state) =>
    s === 'ready' ? 'online' : s === 'removed' || s === 'incompatible' ? 'danger' : 'muted'
  return (
    <div className="overflow-hidden rounded-2xl border border-line-subtle bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="flex min-h-14 w-full items-center gap-3 px-3.5 text-left active:bg-hover"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-ui font-medium">{active?.desktopName ?? '电脑'}</span>
          <span className="flex items-center gap-1.5 text-meta text-fg-muted">
            <Dot tone={tone(state)} pulse={state === 'connecting' || state === 'handshaking'} />
            <span className="truncate">{state ? linkStateText[state] : ''}</span>
          </span>
        </span>
        <ChevronsUpDown size={17} className="shrink-0 text-fg-faint" />
      </button>
      {open && (
        <div className="border-t border-line-subtle">
          {list.map(p => {
            const s = connections.state(p.deviceId)
            return (
              <button
                key={p.deviceId}
                type="button"
                onClick={() => {
                  connections.select(p.deviceId)
                  setOpen(false)
                }}
                className="flex min-h-12 w-full items-center gap-2.5 px-3.5 text-left active:bg-hover"
              >
                <Dot tone={tone(s)} />
                <span className="min-w-0 flex-1 truncate text-ui">{p.desktopName}</span>
                {p.deviceId === deviceId && <Check size={17} className="shrink-0 text-accent-fg" />}
              </button>
            )
          })}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onAdd()
            }}
            className="flex min-h-12 w-full items-center gap-2.5 border-t border-line-subtle px-3.5 text-left text-ui text-accent-fg active:bg-hover"
          >
            <Plus size={17} className="shrink-0" />
            <span className="min-w-0 flex-1">添加电脑</span>
          </button>
        </div>
      )}
    </div>
  )
}
