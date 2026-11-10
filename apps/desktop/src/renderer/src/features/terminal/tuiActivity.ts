// 终端模式的会话在不在干活（docs/ui/tui-toggle.md §5.5）：宿主看不到终端里的引擎，只能看输出节奏。
// 引擎干活时界面一直在刷新（转圈、流式输出），等输入时基本静止；用户按键的回显不算
export interface Activity {
  /** 这一段连续输出从什么时候开始 */
  start: number
  /** 最近一次输出 */
  last: number
}
/** 两次输出间隔超过这么久就算断了 */
export const GAP_MS = 1_000
/** 连续输出这么久才算在干活（过滤一次性的重画） */
export const SUSTAIN_MS = 1_500
/** 按键后这么久内的输出当作回显 */
export const ECHO_MS = 300

/** 收到一段输出后的新状态；inputAt 是最近一次按键的时间 */
export function onOutput(prev: Activity | undefined, now: number, inputAt = 0): Activity | undefined {
  if (now - inputAt < ECHO_MS) return prev
  return prev && now - prev.last <= GAP_MS ? { start: prev.start, last: now } : { start: now, last: now }
}

export const isActive = (a: Activity | undefined, now: number): boolean =>
  !!a && now - a.last <= GAP_MS && a.last - a.start >= SUSTAIN_MS

// ---------------------------------------------------------------------------
// 运行时：按终端记输出节奏，汇总成「在干活的会话」集合；没有新输出时由定时器在过期点重算
// ---------------------------------------------------------------------------
const activity = new Map<string, Activity & { sessionId: string }>()
const inputAt = new Map<string, number>()
let busyIds: ReadonlySet<string> = new Set()
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

/** 用户往会话终端里按了键（之后一小会儿的输出当回显） */
export function noteTuiInput(terminalId: string, now = Date.now()): void {
  inputAt.set(terminalId, now)
}

/** 会话终端来了一段输出 */
export function noteTuiOutput(terminalId: string, sessionId: string, now = Date.now()): void {
  const prev = activity.get(terminalId)
  const next = onOutput(prev, now, inputAt.get(terminalId))
  if (next && next !== prev) activity.set(terminalId, { ...next, sessionId })
  refresh(now)
}

function refresh(now: number): void {
  const ids = new Set<string>()
  let wake = Infinity
  for (const [id, a] of activity) {
    if (now - a.last > GAP_MS) activity.delete(id)
    else if (isActive(a, now)) {
      ids.add(a.sessionId)
      wake = Math.min(wake, a.last + GAP_MS + 1)
    }
  }
  if (ids.size !== busyIds.size || [...ids].some(id => !busyIds.has(id))) {
    busyIds = ids
    listeners.forEach(fn => fn())
  }
  if (!timer && wake !== Infinity)
    timer = setTimeout(
      () => {
        timer = null
        refresh(Date.now())
      },
      Math.max(0, wake - now),
    )
}

/** 终端模式里正在干活的会话 id */
export const tuiBusy = (): ReadonlySet<string> => busyIds

export function subscribeTuiBusy(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
