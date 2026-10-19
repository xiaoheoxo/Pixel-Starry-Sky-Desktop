// 组装（docs/mobile-remote.md §18.3）：左边抽屉 + 主区。窄屏抽屉从左边拉出来（左上角按钮或从左边缘右滑），
// 宽屏（≥ 900px）常驻左边；再宽（≥ 1280px）时在会话旁边打开的工具放在右边一栏。
// 主区的页面：概览、会话、新建会话、工具、加项目、我的；配对、添加电脑和扫码是整页。打开 #pair=… 的链接时先进配对页。
// 用浏览器历史做返回：手机上的返回手势 / 返回键能回到上一页（抽屉开着时先关抽屉）。
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Plus, Smartphone } from 'lucide-react'
import type { ProjectRecord } from '@pixelsky/protocol'
import { connections, parseOffer, readOffer, type Offer } from '@/connection'
import { useConnections, useDesktop } from '@/data/hooks'
import { groupTasks } from '@/data/tasks'
import type { ToolId } from '@/data/tools'
import { currentProject, rememberProject, rememberedProject } from '@/data/workspace'
import { Composer } from '@/features/composer/Composer'
import { Drawer } from '@/features/drawer/Drawer'
import { MeScreen } from '@/features/me/MeScreen'
import { SessionScreen } from '@/features/session/SessionScreen'
import { NewTask } from '@/features/tasks/NewTask'
import { TaskList } from '@/features/tasks/TaskList'
import type { ToolProps } from '@/features/tools/common'
import { onBackButton } from '@/platform'
import { setBadge, useNotifyOpen } from '@/platform/notifyOpen'
import { loadPage } from '@/platform/version'
import { Button, Empty, MenuButton, Screen, Spinner, WIDE, WIDER, useMedia } from '@/ui'
import { PageBoundary } from '@/ui/PageBoundary'
import { UpdateBanner } from './UpdateBanner'
import { useReminders } from './reminders'

// 不是每次打开都用到的页面按需加载（扫码用相机和二维码库，工具页有 Git / 文件 / 产物 / 任务），主包小一些
const AddComputer = lazy(() =>
  loadPage(() => import('@/features/pairing/AddComputer')).then(m => ({ default: m.AddComputer })),
)
const PairScreen = lazy(() =>
  loadPage(() => import('@/features/pairing/PairScreen')).then(m => ({ default: m.PairScreen })),
)
const ScanScreen = lazy(() =>
  loadPage(() => import('@/features/pairing/ScanScreen')).then(m => ({ default: m.ScanScreen })),
)
const AddProject = lazy(() =>
  loadPage(() => import('@/features/projects/AddProject')).then(m => ({ default: m.AddProject })),
)
const AddToHome = lazy(() => loadPage(() => import('@/features/me/AddToHome')).then(m => ({ default: m.AddToHome })))
const ArtifactsScreen = lazy(() =>
  loadPage(() => import('@/features/tools/ArtifactsScreen')).then(m => ({ default: m.ArtifactsScreen })),
)
const FilesScreen = lazy(() =>
  loadPage(() => import('@/features/tools/FilesScreen')).then(m => ({ default: m.FilesScreen })),
)
const GitScreen = lazy(() => loadPage(() => import('@/features/tools/GitScreen')).then(m => ({ default: m.GitScreen })))
const TodoScreen = lazy(() =>
  loadPage(() => import('@/features/tools/TodoScreen')).then(m => ({ default: m.TodoScreen })),
)

/** 按需加载的页面还没下完时：占满主区的转圈 */
const pageLoading = (
  <div className="flex h-app min-w-0 flex-1 items-center justify-center bg-app text-fg-muted">
    <Spinner size={22} />
  </div>
)

type Route =
  | { page: 'home' }
  | { page: 'session'; id: string }
  | { page: 'new'; projectId?: string | null; text?: string }
  | { page: 'tool'; tool: ToolId; projectId: string; sub?: string | null }
  | { page: 'addProject' }
  | { page: 'me' }
  | { page: 'pair' }
  | { page: 'scan' }
  | { page: 'add' }
  | { page: 'install' }

/** 右边一栏的工具（宽屏、开着会话时）：自己记下一级，不进浏览历史 */
interface Panel {
  tool: ToolId
  projectId: string
  subs: string[]
}

const TOOL_SCREENS: Record<ToolId, (props: ToolProps) => ReactNode> = {
  git: GitScreen,
  files: FilesScreen,
  artifacts: ArtifactsScreen,
  tasks: TodoScreen,
}

function initialPair(): { offer: Offer | null; error: string | null } | null {
  try {
    const offer = readOffer(location.href)
    return offer ? { offer, error: null } : null
  } catch {
    return { offer: null, error: '二维码内容不对，请在电脑上重新生成。' }
  }
}

/** 演示模式（只在 vite dev 里）：?open=会话 id / ?page=me|new|addProject / ?tool=git&project=p1 直接打开那一页，截图用 */
function demoStart(): Route | null {
  if (!import.meta.env.DEV) return null
  const q = new URLSearchParams(location.search)
  if (!q.has('demo')) return null
  const open = q.get('open'),
    page = q.get('page'),
    tool = q.get('tool') as ToolId | null
  if (open) return { page: 'session', id: open }
  if (tool) return { page: 'tool', tool, projectId: q.get('project') ?? 'p1' }
  if (page === 'me' || page === 'new' || page === 'addProject' || page === 'install') return { page }
  return null
}

/** 文件夹的上一级（加项目时从最近那个项目的上一级开始） */
const parentDir = (path: string): string | null => {
  const clean = path.replace(/[\\/]+$/, '')
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  return i > 0 ? clean.slice(0, i) || null : null
}

export function App() {
  const [initial] = useState(initialPair)
  const [pair, setPair] = useState(initial)
  const [route, setRoute] = useState<Route>(() => (pair ? { page: 'pair' } : (demoStart() ?? { page: 'home' })))
  const [drawer, setDrawer] = useState(false)
  const [panel, setPanel] = useState<Panel | null>(null)
  const wide = useMedia(WIDE)
  const wider = useMedia(WIDER)
  const { active } = useConnections()
  const deviceId = active?.deviceId
  const { link, state, sessions, projects, cached } = useDesktop(deviceId)
  const waiting = groupTasks(sessions).waiting.length
  const canAct = state === 'ready' && link?.hello?.access === 'act'

  useEffect(() => {
    // 配对链接只用一次：从地址栏去掉 #pair=…（不留在历史和截图里）
    if (initial) history.replaceState({ page: 'home' }, '', location.pathname)
    const onPop = (e: PopStateEvent) => {
      setRoute((e.state as Route | null) ?? { page: 'home' })
      setDrawer(false)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [initial])

  const go = useCallback((next: Route) => {
    history.pushState(next, '')
    setRoute(next)
    setDrawer(false)
  }, [])
  const replace = useCallback((next: Route) => {
    history.replaceState(next, '')
    setRoute(next)
    setDrawer(false)
  }, [])
  const back = () => (history.state && history.state.page !== 'home' ? history.back() : replace({ page: 'home' }))
  // 从抽屉打开的一级页面（概览、我的）互相切换时不进历史
  const top = (page: 'home' | 'me') => (route.page === 'home' || route.page === 'me' ? replace({ page }) : go({ page }))

  // 换了电脑：回到概览，右边的工具关掉
  const lastDevice = useRef(deviceId)
  useEffect(() => {
    if (lastDevice.current === deviceId) return
    lastDevice.current = deviceId
    setPanel(null)
    if (route.page !== 'pair' && route.page !== 'scan' && route.page !== 'add') replace({ page: 'home' })
  }, [deviceId, route.page, replace])

  // 当前项目：会话页是会话的项目，工具页是工具的项目，否则上次选的
  const [chosen, setChosen] = useState<string | null>(() => (deviceId ? rememberedProject(deviceId) : null))
  useEffect(() => setChosen(deviceId ? rememberedProject(deviceId) : null), [deviceId])
  const choose = (projectId: string) => {
    if (deviceId) rememberProject(deviceId, projectId)
    setChosen(projectId)
  }
  const openSession = route.page === 'session' ? route.id : null
  const project =
    (route.page === 'tool' ? projects.find(p => p.id === route.projectId) : null) ??
    currentProject(projects, sessions, openSession, chosen)

  // 点通知：切到那台电脑、打开那个会话（没有会话就回概览）。先记下电脑，免得上面「换了电脑回概览」把会话页又换掉
  const openFrom = (device: string, sessionId: string | null) => {
    if (!connections.list().some(p => p.deviceId === device)) return
    if (device !== deviceId) {
      lastDevice.current = device
      setPanel(null)
      connections.select(device)
    }
    if (sessionId) go({ page: 'session', id: sessionId })
    else replace({ page: 'home' })
  }
  useReminders(openFrom)
  useNotifyOpen(t => openFrom(t.device, t.session))
  // 主屏幕图标上的数字：这台电脑上等你处理的个数（页面在后台时由推送更新，sw.js）
  // 没连上、或还是本机缓存的旧列表时不动它（不然刚打开先被清零、或写上过期的数）
  const fresh = state === 'ready' && !cached
  useEffect(() => {
    if (fresh) setBadge(waiting)
  }, [fresh, waiting])
  // 安卓返回键：抽屉开着先关；二级页面返回；一级页面退到后台
  const routeRef = useRef(route)
  routeRef.current = route
  const drawerRef = useRef(drawer)
  drawerRef.current = drawer
  useEffect(
    () =>
      onBackButton(
        () => drawerRef.current || !['home', 'me'].includes(routeRef.current.page),
        () => (drawerRef.current ? setDrawer(false) : history.back()),
      ),
    [],
  )
  // 窄屏从左边缘往右滑拉出抽屉
  useEffect(() => {
    if (wide) return
    let start: { x: number; y: number } | null = null
    const down = (e: TouchEvent) => {
      const t = e.touches[0]
      start = t && t.clientX < 24 ? { x: t.clientX, y: t.clientY } : null
    }
    const move = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!start || !t) return
      if (t.clientX - start.x > 50 && Math.abs(t.clientY - start.y) < 40) {
        start = null
        setDrawer(true)
      }
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    return () => {
      window.removeEventListener('touchstart', down)
      window.removeEventListener('touchmove', move)
    }
  }, [wide])

  const scanned = (text: string) => {
    try {
      setPair({ offer: parseOffer(text), error: null })
    } catch {
      setPair({ offer: null, error: '这不是像素星空的配对二维码。' })
    }
    replace({ page: 'pair' })
  }
  const add = () => go({ page: 'add' })
  const install = () => go({ page: 'install' })
  const offered = (offer: Offer) => {
    setPair({ offer, error: null })
    replace({ page: 'pair' })
  }

  if (route.page === 'pair')
    return (
      <PageBoundary resetKey={JSON.stringify(route)}>
        <Suspense fallback={pageLoading}>
          <PairScreen
            offer={pair?.offer ?? null}
            error={pair?.error ?? null}
            onDone={() => replace({ page: 'home' })}
          />
        </Suspense>
      </PageBoundary>
    )
  if (route.page === 'scan')
    return (
      <PageBoundary resetKey={JSON.stringify(route)}>
        <Suspense fallback={pageLoading}>
          <ScanScreen onBack={back} onResult={scanned} onPaste={() => replace({ page: 'add' })} />
        </Suspense>
      </PageBoundary>
    )
  if (route.page === 'add')
    return (
      <PageBoundary resetKey={JSON.stringify(route)}>
        <Suspense fallback={pageLoading}>
          <AddComputer onBack={back} onScan={() => replace({ page: 'scan' })} onOffer={offered} />
        </Suspense>
      </PageBoundary>
    )
  if (route.page === 'install')
    return (
      <PageBoundary resetKey={JSON.stringify(route)}>
        <Suspense fallback={pageLoading}>
          <AddToHome onBack={back} />
        </Suspense>
      </PageBoundary>
    )

  const menu = <MenuButton badge={waiting} onClick={() => setDrawer(true)} />

  if (!active)
    return route.page === 'me' ? (
      <MeScreen menu={null} onAdd={add} onInstall={install} />
    ) : (
      <Screen large title="像素星空">
        <Empty
          icon={Smartphone}
          title="还没有连接电脑"
          body="在电脑上打开像素星空 › 设置 › 手机 › 添加手机，扫屏幕上的二维码，或复制配对链接粘贴过来。"
          action={
            <Button variant="primary" onClick={add} className="mt-2">
              <Plus size={18} /> 添加电脑
            </Button>
          }
        />
      </Screen>
    )

  const tool = (t: ToolId, projectId: string) => {
    choose(projectId)
    // 宽屏开着会话：放在右边一栏，会话不动
    if (wider && route.page === 'session') {
      setPanel({ tool: t, projectId, subs: [] })
      setDrawer(false)
    } else go({ page: 'tool', tool: t, projectId })
  }
  const newSession = (projectId: string | null, text?: string) => {
    if (projectId) choose(projectId)
    go({ page: 'new', projectId: projectId ?? project?.id ?? null, ...(text ? { text } : {}) })
  }
  const toolProps = (
    p: ProjectRecord,
    sub: string | null,
    nav: Pick<ToolProps, 'onSub' | 'onBack' | 'onClose' | 'leading'>,
  ): ToolProps => ({
    deviceId: active.deviceId,
    project: p,
    sub,
    canAct,
    onOpenSession: id => go({ page: 'session', id }),
    onNewSession: (projectId, text) => newSession(projectId, text),
    ...nav,
  })

  let main: ReactNode
  if (route.page === 'me') main = <MeScreen menu={menu} onAdd={add} onInstall={install} />
  else if (route.page === 'new')
    main = (
      <NewTask
        key={JSON.stringify(route)}
        pairing={active}
        initialProject={route.projectId}
        initialText={route.text}
        onBack={back}
        onCreated={id => replace({ page: 'session', id })}
      />
    )
  else if (route.page === 'session')
    main = (
      <Session
        key={route.id}
        deviceId={active.deviceId}
        sessionId={route.id}
        leading={menu}
        onNew={projectId => newSession(projectId)}
        onTool={tool}
        onArchived={() => replace({ page: 'home' })}
      />
    )
  else if (route.page === 'addProject')
    main = (
      <AddProject
        deviceId={active.deviceId}
        start={parentDir([...projects].sort((a, b) => b.addedAt - a.addedAt)[0]?.path ?? '')}
        existing={projects}
        onBack={back}
        onAdded={p => {
          choose(p.id)
          back()
        }}
      />
    )
  else if (route.page === 'tool') {
    const p = projects.find(x => x.id === route.projectId)
    const Tool = TOOL_SCREENS[route.tool]
    main = p ? (
      <Tool
        key={route.tool + p.id}
        {...toolProps(p, route.sub ?? null, {
          leading: menu,
          onSub: sub => go({ ...route, sub }),
          onBack: back,
        })}
      />
    ) : (
      <Screen title="项目" leading={menu}>
        <Empty icon={Smartphone} title="找不到这个项目" body="电脑上可能已经移除了它。" />
      </Screen>
    )
  } else
    main = (
      <TaskList
        pairing={active}
        menu={menu}
        onOpen={id => go({ page: 'session', id })}
        onNew={() => newSession(null)}
      />
    )

  const panelProject = panel && route.page === 'session' && wider ? projects.find(p => p.id === panel.projectId) : null
  const PanelTool = panel ? TOOL_SCREENS[panel.tool] : null

  const nav = (
    <Drawer
      deviceId={active.deviceId}
      page={route.page === 'home' || route.page === 'me' || route.page === 'session' ? route.page : 'other'}
      openSession={openSession}
      project={project}
      onSession={id => (openSession === id ? setDrawer(false) : go({ page: 'session', id }))}
      onNew={projectId => newSession(projectId)}
      onTool={tool}
      onProject={id => choose(id)}
      onAddProject={() => go({ page: 'addProject' })}
      onHome={() => top('home')}
      onMe={() => top('me')}
      onAddComputer={add}
    />
  )

  return (
    <div className="flex h-app overflow-hidden bg-app text-fg">
      <UpdateBanner />
      {wide && <aside className="flex w-75 shrink-0 flex-col border-r border-line-layout">{nav}</aside>}
      <div className="flex min-w-0 flex-1">
        <PageBoundary resetKey={JSON.stringify(route)}>
          <Suspense fallback={pageLoading}>{main}</Suspense>
        </PageBoundary>
      </div>
      {panelProject && PanelTool && panel && (
        <aside className="flex w-105 shrink-0 border-l border-line-layout">
          <PageBoundary resetKey={panel.tool + panel.projectId}>
            <Suspense fallback={pageLoading}>
              <PanelTool
                key={panel.tool + panel.projectId}
                {...toolProps(panelProject, panel.subs.at(-1) ?? null, {
                  onSub: sub => setPanel({ ...panel, subs: [...panel.subs, sub] }),
                  onBack: () => setPanel({ ...panel, subs: panel.subs.slice(0, -1) }),
                  onClose: () => setPanel(null),
                })}
              />
            </Suspense>
          </PageBoundary>
        </aside>
      )}
      {!wide && drawer && (
        <div className="fixed inset-0 z-30 flex">
          <div className="drawer-in flex h-full w-[min(86vw,340px)] flex-col shadow-popover">{nav}</div>
          <button
            type="button"
            aria-label="关闭菜单"
            onClick={() => setDrawer(false)}
            className="fade-in flex-1 bg-scrim"
          />
        </div>
      )}
    </div>
  )
}

/** 会话页 + 输入框（两个功能在这里拼起来） */
function Session({
  deviceId,
  sessionId,
  leading,
  onNew,
  onTool,
  onArchived,
}: {
  deviceId: string
  sessionId: string
  leading: ReactNode
  onNew(projectId: string): void
  onTool(tool: ToolId, projectId: string): void
  onArchived(): void
}) {
  const pairing = connections.list().find(p => p.deviceId === deviceId)!
  const { link, state, sessions } = useDesktop(deviceId)
  const canAct = state === 'ready' && link?.hello?.access === 'act'
  const s = sessions.find(x => x.record.id === sessionId)
  // 草稿放在这里：队列里撤回的消息放回输入框（已经写了东西就接在后面）
  const [draft, setDraft] = useState('')
  return (
    <SessionScreen
      pairing={pairing}
      sessionId={sessionId}
      leading={leading}
      onRecall={text => setDraft(d => (d.trim() ? d.trimEnd() + '\n' + text : text))}
      onNew={onNew}
      onTool={onTool}
      onArchived={onArchived}
      composer={(running, suggest) => (
        <Composer
          link={link}
          sessionId={sessionId}
          engine={s?.record.engine ?? 'claude'}
          canAct={canAct}
          running={running}
          suggest={suggest}
          draft={draft}
          onDraft={setDraft}
        />
      )}
    />
  )
}
