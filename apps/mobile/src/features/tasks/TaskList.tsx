// 首页 = 会话列表（C3，docs/mobile-remote.md §21.3）：「等你处理」置顶，其余置顶的在前、再按时间排。
// 每行是引擎头像（角上状态点）、标题、时间、项目名和最后一句回复（ui/SessionRow）。
// 搜索（标题在手机上筛，对话内容问电脑）、按项目筛、显示更多（§17 第 6 项）；左上角的菜单按钮由 App 传进来。
import { useState, type ReactNode } from 'react'
import { CloudOff, Inbox, Laptop, Plus, SearchX, ShieldOff, WifiOff } from 'lucide-react'
import type { SessionSummary } from '@pixelsky/protocol'
import type { Pairing } from '@/connection'
import { useContentSearch, useDesktop } from '@/data/hooks'
import { RECENT_STEP, ago, filterTasks, sessionList, sessionStatus, taskProjects, taskTitle } from '@/data/tasks'
import { linkStateText } from '@/i18n/zh'
import { Banner, Button, Dot, Empty, IconButton, Screen, Section, Spinner } from '@/ui'
import { Chips, ContentResults, SearchField } from '@/ui/search'
import { SessionRow } from '@/ui/SessionRow'

export function TaskList({
  pairing,
  menu,
  onOpen,
  onNew,
}: {
  pairing: Pairing
  menu: ReactNode
  onOpen(sessionId: string): void
  onNew(): void
}) {
  const { state, sessions, projects, loaded, cached } = useDesktop(pairing.deviceId)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [recentLimit, setRecentLimit] = useState(RECENT_STEP)
  const projectName = (s: SessionSummary) => projects.find(p => p.id === s.record.projectId)?.name ?? ''
  const withTasks = taskProjects(sessions, projects)
  // 筛的项目没有任务了（被删、归档）就回到全部
  const projectId = withTasks.some(p => p.id === project) ? project : null
  const filtered = filterTasks(sessions, query, projectId, projectName)
  const list = sessionList(filtered, recentLimit)
  // 只有一个项目、或已经按项目筛了：行里不再写项目名
  const showProject = withTasks.length > 1 && !projectId
  const searching = !!query.trim()
  const content = useContentSearch(pairing.deviceId, query, projectId)
  const ready = state === 'ready'
  const canAct = ready && pairing.status === 'paired'

  return (
    <Screen
      large
      title="会话"
      leading={menu}
      subtitle={
        <span className="inline-flex items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1 text-meta text-fg-secondary">
          <Laptop size={14} />
          <span className="max-w-48 truncate">{pairing.desktopName}</span>
          <Dot
            tone={ready ? 'online' : state === 'removed' || state === 'incompatible' ? 'danger' : 'muted'}
            pulse={state === 'connecting' || state === 'handshaking'}
          />
          <span className="text-fg-muted">{state ? linkStateText[state] : ''}</span>
        </span>
      }
      actions={
        <IconButton label="新建会话" icon={Plus} disabled={!canAct} onClick={onNew} className="disabled:opacity-40" />
      }
    >
      {state === 'removed' ? (
        <Empty icon={ShieldOff} title="已被电脑移除" body="到「我的」里删掉这台电脑，再在电脑上重新扫码配对。" />
      ) : state === 'incompatible' && !loaded ? (
        <Empty icon={ShieldOff} title="版本不一致" body="电脑版和手机版的连接协议不一样，把两边都更新到最新版再试。" />
      ) : state === 'unrecognized' && !loaded ? (
        <Empty
          icon={ShieldOff}
          title="电脑上找不到配对"
          body="电脑可能已移除这部手机，或重装过。会自动再试；也可以到「我的」里删掉这台电脑后重新扫码。"
        />
      ) : state === 'desktop_offline' && !loaded ? (
        <Empty
          icon={CloudOff}
          title="电脑不在线"
          body="打开电脑上的像素星空，并在 设置 › 手机 里保持「允许手机远程连接」打开。"
        />
      ) : state === 'offline' && !loaded ? (
        <Empty icon={WifiOff} title="连不上网络" body="检查一下手机网络，恢复后会自动重连。" />
      ) : !loaded ? (
        <div className="flex items-center justify-center gap-2 py-16 text-meta text-fg-muted">
          <Spinner /> 正在连接电脑…
        </div>
      ) : (
        <div className="flex flex-col gap-5 pb-6">
          {!ready && (
            <Banner tone="warn" icon={<CloudOff size={18} />}>
              {state ? linkStateText[state] : ''}：下面是{cached ? '上次打开时' : '断开前'}的内容，恢复后会自动更新。
            </Banner>
          )}
          {sessions.length === 0 ? (
            <Empty
              icon={Inbox}
              title="还没有会话"
              body="在手机上给电脑派个活儿，结果和改动都能在这里看。"
              action={
                <Button variant="primary" disabled={!canAct} onClick={onNew} className="mt-2">
                  <Plus size={18} /> 新建会话
                </Button>
              }
            />
          ) : (
            <>
              <div className="flex flex-col gap-2.5">
                <SearchField value={query} onChange={setQuery} placeholder="搜索会话标题、项目、对话内容" />
                {withTasks.length > 1 && (
                  <Chips
                    value={projectId ?? ''}
                    onChange={setProject}
                    items={[{ value: '', label: '全部项目' }, ...withTasks.map(p => ({ value: p.id, label: p.name }))]}
                  />
                )}
              </div>
              <Group
                title="等你处理"
                tone="danger"
                list={list.waiting}
                project={showProject ? projectName : undefined}
                onOpen={onOpen}
              />
              <Group
                title={searching ? '标题匹配' : list.waiting.length ? '其他会话' : undefined}
                list={list.rest}
                project={showProject ? projectName : undefined}
                onOpen={onOpen}
                more={
                  list.more > 0 && (
                    <button
                      type="button"
                      onClick={() => setRecentLimit(n => n + RECENT_STEP)}
                      className="flex min-h-12 w-full items-center justify-center border-t border-line-subtle text-meta text-accent-fg active:bg-hover"
                    >
                      显示更多（还有 {list.more} 个）
                    </button>
                  )
                }
              />
              {searching && !content.unsupported && (
                <ContentResults
                  results={content.results}
                  loading={content.loading}
                  truncated={content.truncated}
                  when={ago}
                  onOpen={onOpen}
                />
              )}
              {searching && !filtered.length && !content.loading && !content.results.length && (
                <Empty
                  icon={SearchX}
                  title="没有找到"
                  body={content.unsupported ? '电脑上的像素星空版本较旧，只能搜标题和项目名。' : '换个关键词试试。'}
                />
              )}
            </>
          )}
        </div>
      )}
    </Screen>
  )
}

function Group({
  title,
  tone,
  list,
  project,
  onOpen,
  more,
}: {
  title?: string
  tone?: 'danger'
  list: SessionSummary[]
  project?(s: SessionSummary): string
  onOpen(id: string): void
  more?: ReactNode
}) {
  if (!list.length) return null
  return (
    <Section
      title={
        title && (
          <>
            {tone && <Dot tone={tone} />}
            {title}
            <span className="text-fg-faint">{list.length}</span>
          </>
        )
      }
    >
      {list.map((s, i) => (
        <SessionRow
          key={s.record.id}
          engine={s.record.engine}
          title={taskTitle(s)}
          time={ago(s.record.updatedAt)}
          project={project?.(s)}
          preview={s.record.lastReply}
          status={sessionStatus(s)}
          pinned={!!s.record.pinnedAt && s.state !== 'waiting'}
          divider={i > 0}
          onClick={() => onOpen(s.record.id)}
        />
      ))}
      {more}
    </Section>
  )
}
