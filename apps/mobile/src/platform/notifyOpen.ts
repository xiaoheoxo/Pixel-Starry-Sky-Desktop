// 点锁屏提醒直达会话、图标角标（docs/mobile-remote.md §23）。推送里带 device（手机在云端的设备 ID，就是 Pairing.deviceId）
// 和 session（只涉及一个会话时）；public/sw.js 打开新页面时把它们放进地址 #open=会话&device=设备，页面已经开着时发消息过来。
import { useEffect, useRef } from 'react'

export interface NotifyTarget {
  device: string
  /** 没有时回概览 */
  session: string | null
}

const ID = /^[A-Za-z0-9_.:~-]{1,128}$/

/** 解析 #open=…&device=…；不是这个样子的返回 null */
export function readNotifyTarget(hash: string): NotifyTarget | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''))
  const device = q.get('device')
  if (!q.has('open') || !device || !ID.test(device)) return null
  const session = q.get('open')
  return { device, session: session && ID.test(session) ? session : null }
}

/** 页面打开时看一次地址（看完从地址栏去掉），之后听 service worker 发来的消息 */
export function useNotifyOpen(open: (target: NotifyTarget) => void): void {
  const ref = useRef(open)
  ref.current = open
  useEffect(() => {
    const first = readNotifyTarget(location.hash)
    if (first) {
      history.replaceState(history.state, '', location.pathname + location.search)
      ref.current(first)
    }
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : null
    if (!sw) return
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: unknown; device?: unknown; session?: unknown } | null
      if (d?.type !== 'pixelsky-open' || typeof d.device !== 'string' || !ID.test(d.device)) return
      ref.current({ device: d.device, session: typeof d.session === 'string' && ID.test(d.session) ? d.session : null })
    }
    sw.addEventListener('message', onMessage)
    return () => sw.removeEventListener('message', onMessage)
  }, [])
}

type BadgeNavigator = Navigator & { setAppBadge?(n?: number): Promise<void>; clearAppBadge?(): Promise<void> }

/** 主屏幕图标上的数字（添加到主屏幕后才有；不支持的浏览器什么都不做） */
export function setBadge(count: number): void {
  const nav = navigator as BadgeNavigator
  try {
    void (count > 0 ? nav.setAppBadge?.(Math.min(count, 99)) : nav.clearAppBadge?.())?.catch(() => undefined)
  } catch {
    // 没有权限、不在安全上下文：不显示角标
  }
}
