// 存在 localStorage 里的小设置，另一个窗口（比如独立的设置窗口）或云同步改了之后让这边重新读。
// 浏览器只在「别的窗口」写入时发 storage 事件；云同步写回时自己补一个（settings/sync/registry.ts）。
// 只读不写：收到事件后别再写回 localStorage，免得两个窗口来回通知。

/** 订阅某个键的变化（key 为 null 是清空了整个存储，也算）；返回取消订阅 */
export function onStoredChange(key: string, callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const listener = (event: StorageEvent): void => {
    if (event.storageArea !== localStorage || (event.key !== key && event.key !== null)) return
    callback()
  }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}

/** 读 JSON 值；没有、读不出来、存储不可用都用 initial */
export function readStoredJson<T>(key: string, initial: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? initial
  } catch {
    return initial
  }
}

/** 读布尔开关（存的是 'true'）；没有存过用 fallback */
export function readStoredFlag(key: string, fallback = false): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw === 'true'
  } catch {
    return fallback
  }
}
