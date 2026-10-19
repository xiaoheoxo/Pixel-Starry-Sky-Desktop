// 界面用的数据钩子：电脑列表、某台电脑的任务和项目、某个会话。只经 connection/ 拿数据。
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type {
  EngineCatalog,
  EngineEvent,
  EngineId,
  EngineModel,
  HostEvent,
  ImageAttachment,
  Item,
  ProjectRecord,
  SearchResult,
  SessionSummary,
} from '@pixelsky/protocol'
import { connections, type DesktopLink, type LinkState, type Pairing } from '@/connection'
import { desktopLists, NO_LISTS } from './desktop'
import { imageDataUrl, imageKey, rememberImage } from './images'
import { applyEvent, applyTail, emptyView, prependOlder, replaceItem, type SessionView, type Tail } from './session'

/** 配对过的电脑和当前选中的那台；连接状态变化时刷新 */
export function useConnections(): { list: Pairing[]; active: Pairing | null } {
  useSyncExternalStore(
    l => connections.subscribe(l),
    () => connections.snapshot(),
  )
  return { list: connections.list(), active: connections.active() }
}

export function useLinkState(deviceId: string | undefined): LinkState | undefined {
  useSyncExternalStore(
    l => connections.subscribe(l),
    () => connections.snapshot(),
  )
  return deviceId ? connections.state(deviceId) : undefined
}

/** 收这台电脑推来的事件 */
function useEvents(deviceId: string | undefined, handler: (event: HostEvent) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!deviceId) return
    const listener = (id: string, event: unknown) => {
      if (id === deviceId) ref.current(event as HostEvent)
    }
    connections.eventListeners.add(listener)
    return () => {
      connections.eventListeners.delete(listener)
    }
  }, [deviceId])
}

export interface DesktopData {
  link: DesktopLink | undefined
  state: LinkState | undefined
  sessions: SessionSummary[]
  projects: ProjectRecord[]
  loaded: boolean
  /** 显示的是上次存在本机的列表，这次还没从电脑取到新的；此时 loaded 也是 true */
  cached: boolean
}

/** 一台电脑的任务列表和项目（全应用一份，见 desktop.ts） */
export function useDesktop(deviceId: string | undefined): DesktopData {
  const state = useLinkState(deviceId)
  const link = deviceId ? connections.link(deviceId) : undefined
  const lists = useSyncExternalStore(
    l => desktopLists.subscribe(l),
    () => (deviceId ? desktopLists.get(deviceId) : NO_LISTS),
  )
  return { link, state, ...lists }
}

export interface SessionData {
  view: SessionView
  error: string | null
  loadOlder(): Promise<void>
  detail(itemId: string): Promise<void>
  /** 取一条消息里的第 index 张图（电脑太大的先缩小），返回能放进 <img> 的地址 */
  image(itemId: string, index: number): Promise<string>
}

/** 一个会话：连上（或重连）时取尾部快照，之后按 seq 应用事件；seq 接不上就重新取 */
export function useSession(deviceId: string, sessionId: string): SessionData {
  const state = useLinkState(deviceId)
  const link = connections.link(deviceId)
  const [view, setView] = useState<SessionView>(emptyView)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (state !== 'ready' || !link) return
    let alive = true
    setView(v => ({ ...emptyView(), buffer: v.snapshot ? [] : v.buffer }))
    link.call<Tail>('engine:openSessionTail', sessionId).then(
      tail => alive && setView(v => applyTail(v, tail)),
      (e: Error) => alive && setError(e.message),
    )
    return () => {
      alive = false
      link.call('unwatch', sessionId).catch(() => undefined)
    }
  }, [state, link, sessionId, reload])

  useEvents(deviceId, event => {
    if (event.kind !== 'session' || event.sessionId !== sessionId) return
    setView(v => applyEvent(v, event.seq, event.event as EngineEvent))
  })

  useEffect(() => {
    if (view.stale) setReload(n => n + 1)
  }, [view.stale])

  const loadOlder = useCallback(async () => {
    if (!link || !view.before) return
    const older = await link.call<Tail>('engine:openSessionTail', sessionId, { before: view.before })
    setView(v => prependOlder(v, older))
  }, [link, sessionId, view.before])

  const detail = useCallback(
    async (itemId: string) => {
      if (!link) return
      const r = await link.call<{ item: Item; truncated: boolean } | null>('engine:itemDetail', sessionId, itemId)
      if (r) setView(v => replaceItem(v, r.item, r.truncated))
    },
    [link, sessionId],
  )

  const image = useCallback(
    async (itemId: string, index: number) => {
      if (!link) throw new Error('还没连上电脑')
      const got = await link.call<ImageAttachment>('image', sessionId, itemId, index)
      const url = imageDataUrl(got)
      rememberImage(imageKey(sessionId, itemId, index), url)
      return url
    },
    [link, sessionId],
  )

  return { view, error, loadOlder, detail, image }
}

/** 新建任务的默认引擎：电脑上设的那个（网关的 defaults）；电脑版太旧时为 null */
export function useDefaultEngine(deviceId: string | undefined): EngineId | null {
  const state = useLinkState(deviceId)
  const link = deviceId ? connections.link(deviceId) : undefined
  const [engine, setEngine] = useState<EngineId | null>(null)
  useEffect(() => {
    if (state !== 'ready' || !link) return
    let alive = true
    link.call<{ engine: EngineId | null }>('defaults').then(
      r => alive && setEngine(r.engine),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [state, link])
  return engine
}

export interface ContentSearch {
  results: SearchResult[]
  truncated: boolean
  loading: boolean
  /** 电脑版太旧，不能搜对话内容 */
  unsupported: boolean
}

const NO_RESULTS: ContentSearch = { results: [], truncated: false, loading: false, unsupported: false }

/** 搜对话内容（只搜电脑本机的会话）：停止输入 350 毫秒后再问电脑，新的搜索会取消上一次 */
export function useContentSearch(deviceId: string | undefined, text: string, projectId: string | null): ContentSearch {
  const state = useLinkState(deviceId)
  const link = deviceId ? connections.link(deviceId) : undefined
  const [result, setResult] = useState<ContentSearch>(NO_RESULTS)
  const query = text.trim()
  useEffect(() => {
    if (state !== 'ready' || !link || !query) {
      setResult(NO_RESULTS)
      return
    }
    let alive = true
    setResult(r => ({ ...r, loading: true }))
    const timer = setTimeout(() => {
      link.call<{ results: SearchResult[]; truncated: boolean }>('search', query, projectId).then(
        r => alive && setResult({ results: r.results, truncated: r.truncated, loading: false, unsupported: false }),
        (e: Error) => alive && setResult({ ...NO_RESULTS, unsupported: e.message.includes('MOBILE_UNSUPPORTED') }),
      )
    }, 350)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [state, link, query, projectId])
  return result
}

export interface Catalog {
  models: EngineModel[] | null
  /** 电脑版太旧（手机还不能取模型目录），只能在电脑上改 */
  unsupported: boolean
}

/** 引擎报上来的模型目录（改模式面板用）；同一台电脑、同一个引擎只取一次 */
export function useCatalog(deviceId: string | undefined, engine: EngineId, enabled = true): Catalog {
  const state = useLinkState(deviceId)
  const link = deviceId ? connections.link(deviceId) : undefined
  const [catalog, setCatalog] = useState<Catalog>({ models: null, unsupported: false })
  useEffect(() => {
    if (!enabled || state !== 'ready' || !link) return
    let alive = true
    setCatalog({ models: null, unsupported: false })
    link.call<EngineCatalog>('engine:catalog', engine).then(
      r => alive && setCatalog({ models: r?.models ?? [], unsupported: false }),
      // 只有旧版电脑（不认这个通道）算「不支持」；别的错（引擎没装、超时）当作没有目录
      (e: Error) => alive && setCatalog({ models: [], unsupported: e.message === 'MOBILE_UNSUPPORTED' }),
    )
    return () => {
      alive = false
    }
  }, [enabled, state, link, engine])
  return catalog
}
