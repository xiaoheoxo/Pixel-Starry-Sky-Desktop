// 打开对话 / 窗口回到前台时自动补上终端里新聊的轮次（docs/ui/native-sync.md §3，以前是 claude-resume.md §4.8 的「只加提示等人点」）。
// 导入的、像素星空自己开的都查，宿主判断能不能补；终端里正开着时每 5 秒再补一次，返回写入来源给界面显示提示
import { useEffect, useState } from 'react'
import type { NativeActionResult } from '@pixelsky/protocol'
import { nativeSessionAction } from '@/features/engine/store'

/** 同一个对话两次检查之间至少隔这么久（窗口反复切换不会反复读记录） */
const MIN_GAP_MS = 20_000
/** 终端里正开着时跟着补的间隔 */
const LIVE_MS = 5_000
const last = new Map<string, number>()

type LiveSource = NonNullable<NativeActionResult['liveSource']>

export function useNativeCheck(sessionId: string | null, enabled: boolean): LiveSource | null {
  const [live, setLive] = useState<{ sessionId: string; source: LiveSource } | null>(null)
  useEffect(() => {
    if (!sessionId || !enabled) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let expiry: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    let checking = false
    const run = (): void => {
      timer = null
      checking = true
      // Keep a fresh banner between polls, but never show an indefinitely stale one.
      expiry = setTimeout(() => setLive(null), LIVE_MS)
      last.set(sessionId, Date.now())
      void nativeSessionAction(sessionId, 'sync').then(
        r => {
          if (stopped) return
          checking = false
          if (expiry) clearTimeout(expiry)
          setLive(r.live ? { sessionId, source: r.liveSource ?? 'unknown' } : null)
          if (r.live) timer = setTimeout(run, LIVE_MS)
        },
        () => {
          if (stopped) return
          checking = false
          if (expiry) clearTimeout(expiry)
          setLive(null)
        },
      )
    }
    const check = (): void => {
      if (timer || checking || Date.now() - (last.get(sessionId) ?? 0) < MIN_GAP_MS) return
      run()
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (expiry) clearTimeout(expiry)
      window.removeEventListener('focus', check)
      setLive(null)
    }
  }, [sessionId, enabled])
  return enabled && live?.sessionId === sessionId ? live.source : null
}
