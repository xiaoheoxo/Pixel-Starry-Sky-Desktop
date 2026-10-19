// 运行中的一步 / 两步之间等了多久（docs/ui/conversation-concise.md §7）：按这次打开应用里第一次看到它的时间算，
// 和「思考中 · 12s」一样只在内存里；重新加载窗口后从 0 开始数（引擎还没给工具调用记开始时间）。
import { useEffect, useState } from 'react'

const firstSeen = new Map<string, number>()
/** 记这么多条就丢掉最早的（运行中的步骤用完就不再看） */
const LIMIT = 500

/** key 第一次出现的时间；active 时每秒刷新一次，返回已经过了多久（毫秒）。key 为 null 时是 0 */
export function useSince(key: string | null, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || !key) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, key])
  if (!key) return 0
  let start = firstSeen.get(key)
  if (start === undefined) {
    start = Date.now()
    firstSeen.set(key, start)
    if (firstSeen.size > LIMIT) firstSeen.delete(firstSeen.keys().next().value!)
  }
  return Math.max(0, now - start)
}

/** active 时每秒刷新一次的当前时间（毫秒） */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}
