// 标签内容和所在窗格分开挂载（docs/ui/multi-pane.md §7）：
// 每个标签的内容用 createPortal 渲染进它自己的容器（TabHosts，在 Workspace 里按标签 id 排，位置不随窗格变），
// 窗格里只放一个插槽（TabSlot），把这个容器搬进来。标签拖到别的窗格、拆分出新窗格时只是搬容器，
// 会话不重建（不重新排版整段对话、不重跑 Markdown 和代码高亮），草稿、展开状态也都还在。
import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '@/i18n/I18nProvider'
import { cn } from '@/ui'
import { ErrorBoundary } from '@/ui/ErrorBoundary'
import { reportRendererError } from '@/features/logs/rendererErrors'
import { forgetInput, noteSessionSwitch } from '@/features/logs/switchTiming'
import { SessionView } from '@/features/session/SessionView'
import { isLive, useSessionTitle } from '@/features/engine'
import { noteTabSessions } from '@/features/engine/store'
import { FileEditor } from '@/features/editor/FileEditor'
import { fadeIn } from './motion'
import { noteMounted, useKeepMounted } from './keepAlive'
import { paneActions } from './store'
import { isFileTab, isNewTab, type Leaf } from './tree'

const SEP = '\n'

/** 卸载过内容的标签：再挂载时就算是当前标签也淡入一次 */
const unloaded = new Set<string>()

interface Host {
  el: HTMLDivElement
  /** 容器里各滚动区最后的滚动位置：容器从 DOM 里拿下再放回去时滚动位置会归零，放回去后照这个恢复 */
  scrolls: Map<Element, { top: number; left: number }>
}

const hosts = new Map<string, Host>()

function hostOf(tab: string): Host {
  let host = hosts.get(tab)
  if (!host) {
    const el = document.createElement('div')
    // 容器本身不占布局：内容（absolute inset-0）照旧相对窗格内容区定位
    el.style.display = 'contents'
    el.dataset.tabHost = tab
    const scrolls = new Map<Element, { top: number; left: number }>()
    el.addEventListener(
      'scroll',
      e => {
        const target = e.target
        if (target instanceof Element) scrolls.set(target, { top: target.scrollTop, left: target.scrollLeft })
      },
      { capture: true, passive: true },
    )
    host = { el, scrolls }
    hosts.set(tab, host)
  }
  return host
}

/** 把标签的容器放进插槽；从别处搬来的，恢复里面各滚动区的位置 */
function attach(slot: HTMLElement, tab: string): void {
  const host = hostOf(tab)
  if (host.el.parentNode === slot) return
  const moved = host.el.parentNode !== null
  slot.appendChild(host.el)
  if (!moved) return
  for (const [el, pos] of host.scrolls) {
    if (!host.el.contains(el)) {
      host.scrolls.delete(el)
      continue
    }
    if (el.scrollTop !== pos.top) el.scrollTop = pos.top
    if (el.scrollLeft !== pos.left) el.scrollLeft = pos.left
  }
}

/** 窗格内容区里一个标签的位置：只是个插槽，内容由 TabHosts 渲染 */
export function TabSlot({ tab }: { tab: string }) {
  const ref = useRef<HTMLDivElement>(null)
  // 插槽的 layout effect 先于 TabHosts 里内容的 layout effect（TabHosts 排在窗格后面）：
  // 内容第一次挂载时容器已经在页面里，量尺寸、找 closest('main') 都正常
  useLayoutEffect(() => {
    if (ref.current) attach(ref.current, tab)
  }, [tab])
  return <div ref={ref} className="contents" />
}

export interface TabHostsProps {
  leaves: Leaf[]
  sidebarOpen: boolean
  panelOpen: boolean
  onToggleSidebar: () => void
  onTogglePanel: () => void
}

/** 所有窗格里所有标签的内容。必须排在窗格后面（见 TabSlot） */
export function TabHosts({ leaves, ...rest }: TabHostsProps) {
  const keep = useKeepMounted(leaves)
  // 布局里所有对话标签的会话（不论挂没挂载）报给引擎 store：没挂载、没快照的会话跑完照样标「有新回复」
  const sessions = leaves
    .flatMap(leaf => leaf.tabs)
    .filter(tab => !isNewTab(tab) && !isFileTab(tab))
    .join(SEP)
  useEffect(() => noteTabSessions(sessions ? sessions.split(SEP) : []), [sessions])
  return (
    <>
      {leaves.flatMap(leaf =>
        leaf.tabs.map(tab => (
          <TabHost
            key={tab}
            tab={tab}
            leafId={leaf.id}
            active={tab === leaf.active}
            mounted={keep.has(tab)}
            {...rest}
          />
        )),
      )}
    </>
  )
}

type TabProps = { tab: string; leafId: string; active: boolean } & Omit<TabHostsProps, 'leaves'>

function TabHost({ mounted, ...props }: TabProps & { mounted: boolean }) {
  const { tab } = props
  const host = hostOf(tab)
  useEffect(() => {
    hosts.set(tab, host)
    return () => {
      // 标签关掉了：丢掉容器（同一个标签以后再打开时重新建）
      if (hosts.get(tab) === host) hosts.delete(tab)
    }
  }, [tab, host])
  // 内容卸载（切走太久的对话标签）：容器留着，里面空了；滚动位置表里的元素都已不在，一起清掉
  useEffect(() => {
    if (!mounted) return
    const forget = noteMounted()
    return () => {
      forget()
      host.scrolls.clear()
      // 上面的容器清理先跑：标签是关掉的（容器已丢）就不记，免得 unloaded 只增不减、重开时漏掉淡入
      if (hosts.get(tab) === host) unloaded.add(tab)
    }
  }, [mounted, host, tab])
  return createPortal(mounted ? <TabBody {...props} /> : null, host.el)
}

/** 一个标签的内容：不是当前标签时隐藏但保持挂载；切过来时淡入 */
const TabBody = memo(function TabBody({
  tab,
  leafId,
  active,
  sidebarOpen,
  panelOpen,
  onToggleSidebar,
  onTogglePanel,
}: TabProps) {
  useI18n()
  const ref = useRef<HTMLDivElement>(null)
  // 卸载过又挂载回来的当前标签也淡入（其余情况挂载时是当前标签不淡入）
  const wasActive = useRef(active && !unloaded.has(tab))
  const sessionId = isNewTab(tab) || isFileTab(tab) ? null : tab
  const title = useSessionTitle(sessionId)
  const mounting = useRef(true)

  useLayoutEffect(() => {
    // 切到这个对话（含这次才挂载的）：量到画出来要多久，慢了记日志
    if (active && sessionId && (mounting.current || !wasActive.current)) noteSessionSwitch(sessionId, mounting.current)
    if (active && !wasActive.current && ref.current) fadeIn(ref.current)
    wasActive.current = active
    mounting.current = false
    unloaded.delete(tab)
  }, [active, tab])

  return (
    <div
      ref={ref}
      // 不是当前标签：content-visibility: hidden 跳过它的排版和绘制（窗格伸缩时不再跟着重排），状态和滚动位置都保留
      className={cn('absolute inset-0 flex', !active && 'invisible [content-visibility:hidden]')}
      aria-hidden={!active || undefined}
      inert={!active}
      // portal 里的 React 事件不经过 PaneView，点内容时在这里把所在窗格设为当前窗格
      onPointerDownCapture={() => paneActions.focus(leafId)}
    >
      <ErrorBoundary
        resetKeys={[tab, sessionId]}
        label="tab"
        onError={(error, componentStack, boundary) =>
          reportRendererError('react.boundary', error, { ...(componentStack ? { componentStack } : {}), boundary })
        }
      >
        {isFileTab(tab) ? (
          <FileEditor id={tab} active={active} />
        ) : (
          <SessionView
            active={active}
            embedded
            sessionId={sessionId}
            draftKey={isLive ? tab : `demo:${tab}`}
            title={title}
            sidebarOpen={sidebarOpen}
            panelOpen={panelOpen}
            onToggleSidebar={onToggleSidebar}
            onTogglePanel={onTogglePanel}
            onOpenSession={id => {
              forgetInput()
              paneActions.replace(tab, id)
            }}
          />
        )}
      </ErrorBoundary>
    </div>
  )
})
