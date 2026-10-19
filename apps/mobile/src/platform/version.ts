// 发了新版的提示（docs/mobile-remote.md §21）：sw.js 不缓存页面，下次「打开」就是新的，
// 但已经开着的页面 JS 不会自己换，用户会一直用旧页面。所以页面回到前台和每 10 分钟取一次 version.json
// （构建时生成，内容 {"build":"构建号"}，部署时和 index.html 一起换），和编进页面的 __BUILD_ID__ 不一样就提示刷新。
// dev 和 App（Capacitor）里不检查：App 的页面就在安装包里，换版本要装新包。
import { useEffect, useState } from 'react'
import { inApp } from './index'

/** 多久取一次（页面一直在前台时） */
export const CHECK_INTERVAL = 10 * 60 * 1000

/** 页面里编进去的构建号（测试里没有 define 时是空串） */
export const currentBuild: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : ''

/** 取到的 version.json 里的构建号；格式不对返回 null（没上传 version.json 时服务器会回 index.html，也走这里） */
export function parseBuild(data: unknown): string | null {
  const build = (data as { build?: unknown } | null)?.build
  return typeof build === 'string' && build.trim() ? build.trim() : null
}

/** 线上的构建号和页面的不一样才算有新版；取不到 / 页面没有构建号时一律不算 */
export function isNewBuild(current: string, remote: string | null): boolean {
  return !!current && !!remote && current !== remote
}

/** 取一次线上的构建号；没网、404、不是 JSON 都返回 null（不打扰用户） */
export async function fetchBuild(
  base: string = import.meta.env.BASE_URL,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<string | null> {
  try {
    const res = await fetcher(`${base}version.json`, { cache: 'no-store' })
    return res.ok ? parseBuild(await res.json()) : null
  } catch {
    return null
  }
}

interface WatchDeps {
  current: string
  fetchRemote: () => Promise<string | null>
  /** 页面是不是在前台 */
  visible: () => boolean
  /** 监听页面可见性变化；返回取消函数 */
  onVisibility: (handler: () => void) => () => void
  setTimer: (handler: () => void, ms: number) => unknown
  clearTimer: (id: unknown) => void
}

/** 检查新版：回到前台时检查一次，之后每 10 分钟一次（在后台时不取）；发现新版调用 onNew 并停下。返回停止函数 */
export function watchNewBuild(onNew: () => void, deps: WatchDeps): () => void {
  let stopped = false
  let timer: unknown = null
  const check = async () => {
    if (stopped) return
    const remote = await deps.fetchRemote()
    if (stopped) return
    if (isNewBuild(deps.current, remote)) {
      stop()
      onNew()
    }
  }
  const tick = () => {
    if (deps.visible()) void check()
  }
  const stopVisibility = deps.onVisibility(() => {
    if (deps.visible()) void check()
  })
  timer = deps.setTimer(function again() {
    tick()
    if (!stopped) timer = deps.setTimer(again, CHECK_INTERVAL)
  }, CHECK_INTERVAL)
  function stop() {
    stopped = true
    stopVisibility()
    deps.clearTimer(timer)
  }
  return stop
}

/** 线上有新版了吗（横幅用，app/UpdateBanner.tsx）；dev 和 App 里恒为 false */
export function useNewVersion(): boolean {
  const [found, setFound] = useState(false)
  useEffect(() => {
    if (inApp || import.meta.env.DEV || !currentBuild) return
    return watchNewBuild(() => setFound(true), {
      current: currentBuild,
      fetchRemote: () => fetchBuild(),
      visible: () => document.visibilityState === 'visible',
      onVisibility: handler => {
        document.addEventListener('visibilitychange', handler)
        return () => document.removeEventListener('visibilitychange', handler)
      },
      setTimer: (handler, ms) => setTimeout(handler, ms),
      clearTimer: id => clearTimeout(id as ReturnType<typeof setTimeout>),
    })
  }, [])
  return found
}

const RELOAD_KEY = 'pixelsky.mobile.chunkReload'
/** 隔多久内不再因为加载失败自动刷新（防止真的断网时一直刷） */
export const RELOAD_GUARD_MS = 60_000

/**
 * 按需加载页面（React.lazy）用：发新版后旧页面里记着的脚本文件名已经不在服务器上了，加载会失败；
 * 这时自动刷新一次拿到新版。只有线上确实是新构建时才刷（断网、弱网也会加载失败，刷了只会丢掉草稿、看到离线页）；
 * 一分钟内只刷一次。不刷的就把错误抛出去，由 ui/PageBoundary 显示「重试」。
 */
export function loadPage<T>(
  load: () => Promise<T>,
  reload: () => void = () => location.reload(),
  newer: () => Promise<boolean> = async () => isNewBuild(currentBuild, await fetchBuild()),
): Promise<T> {
  return load().catch(async (e: unknown) => {
    if (await newer().catch(() => false))
      try {
        const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
        if (Date.now() - last > RELOAD_GUARD_MS) {
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
          reload()
          return new Promise<T>(() => {}) // 页面马上换掉，这里一直等着
        }
      } catch {
        // sessionStorage 不可用：不自动刷新
      }
    throw e
  })
}
