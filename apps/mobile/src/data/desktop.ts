// 每台电脑的会话列表和项目：全应用一份（抽屉、概览、会话页共用，docs/mobile-remote.md §18.3），
// 连上 / 重连时取一次，之后跟着电脑推来的事件更新。
// 每台电脑最近一次的列表存在本机（listCache.ts）：打开页面时先显示它（cached = true），连上取到新的就替换。
import type { HostEvent, ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import { connections, type LinkState } from '@/connection'
import { ListCache, browserStorage } from './listCache'

export interface DesktopLists {
  sessions: SessionSummary[]
  projects: ProjectRecord[]
  /** 有可显示的列表了（取到的，或本机缓存的） */
  loaded: boolean
  /** 现在显示的是上次存在本机的列表，这次还没从电脑取到新的（取到后变 false）；此时 loaded 也是 true */
  cached: boolean
}

export const NO_LISTS: DesktopLists = { sessions: [], projects: [], loaded: false, cached: false }

class Lists {
  private readonly data = new Map<string, DesktopLists>()
  private readonly states = new Map<string, LinkState | undefined>()
  private readonly listeners = new Set<() => void>()
  private readonly cache = new ListCache(browserStorage())
  /** 已经试过读缓存的电脑（没有缓存的也只试一次） */
  private readonly tried = new Set<string>()
  private deviceIds: string | null = null
  private started = false

  get(deviceId: string): DesktopLists {
    const have = this.data.get(deviceId)
    if (have) return have
    // 第一次问到这台电脑：先拿本机缓存的列表垫上（只给配对过的电脑，同一个对象，useSyncExternalStore 要求引用稳定）
    if (!this.tried.has(deviceId) && connections.list().some(p => p.deviceId === deviceId)) {
      this.tried.add(deviceId)
      const cached = this.cache.load(deviceId)
      if (cached) {
        const lists: DesktopLists = { ...cached, loaded: true, cached: true }
        this.data.set(deviceId, lists)
        return lists
      }
    }
    return NO_LISTS
  }

  subscribe(listener: () => void): () => void {
    this.start()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 重新取（「工作区」的刷新按钮） */
  async refresh(deviceId: string): Promise<void> {
    const link = connections.link(deviceId)
    if (!link || connections.state(deviceId) !== 'ready') return
    const [sessions, projects] = await Promise.all([
      link.call<SessionSummary[]>('engine:sessions'),
      link.call<ProjectRecord[]>('engine:projects'),
    ])
    this.set(deviceId, { sessions, projects, loaded: true, cached: false })
  }

  private set(deviceId: string, patch: Partial<DesktopLists>): void {
    // 请求回来时这台电脑已经被忘掉了：丢掉，别又把缓存写回去
    if (!connections.list().some(p => p.deviceId === deviceId)) return
    const next = { ...this.get(deviceId), ...patch }
    this.data.set(deviceId, next)
    if (next.loaded) this.cache.save(deviceId, next)
    for (const l of this.listeners) l()
  }

  private start(): void {
    if (this.started) return
    this.started = true
    connections.subscribe(() => this.check())
    // 切到后台前把等着写的缓存写掉（手机上页面随时会被系统收走）
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && this.cache.flush())
    connections.eventListeners.add((deviceId, data) => {
      const event = data as HostEvent
      if (event?.kind === 'sessions') this.set(deviceId, { sessions: event.sessions })
      else if (event?.kind === 'projects') this.set(deviceId, { projects: event.projects })
    })
    this.check()
  }

  /** 变成「已连接」时取一次（断开期间漏掉的推送靠这一次补上） */
  private check(): void {
    // 忘掉电脑：它的缓存和内存里的列表一起删（connection/ 的 forget 不管缓存，这里看连接列表变化）
    const ids = connections.list().map(p => p.deviceId)
    const key = ids.join(',')
    if (key !== this.deviceIds) {
      this.deviceIds = key
      const keep = new Set(ids)
      this.cache.pruneExcept(keep)
      for (const id of [...this.data.keys()]) if (!keep.has(id)) this.data.delete(id)
      for (const id of [...this.states.keys()]) if (!keep.has(id)) this.states.delete(id)
      for (const id of [...this.tried]) if (!keep.has(id)) this.tried.delete(id)
    }
    for (const p of connections.list()) {
      const state = connections.state(p.deviceId)
      const before = this.states.get(p.deviceId)
      this.states.set(p.deviceId, state)
      if (state === 'ready' && before !== 'ready') void this.refresh(p.deviceId).catch(() => undefined)
    }
  }
}

export const desktopLists = new Lists()
