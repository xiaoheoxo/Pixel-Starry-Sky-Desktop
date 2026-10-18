// 启动耗时打点（性能审核 A9）：主进程脚本开始 → app ready → 各个 init → createWindow → ready-to-show / did-finish-load，
// 攒着最后合成一条日志，不在启动途中一步一条刷屏。用来看启动慢在哪一步（比如 initEngine、loadShellEnv）。

/** 汇总日志的字段；除 bootMs 外都是从主进程脚本开始算起的毫秒数 */
export type StartupFields = {
  /** 进程启动到 index.ts 顶层开始跑，约数（含 Electron 自己的启动，以及主进程脚本和全部 import 的加载求值） */
  bootMs: number
  /** 各步自己花的时间，按先后顺序：whenReady 是脚本开始到 app ready，其余是各个 init（含 await）和 createWindow */
  steps: Record<string, number>
  readyToShowMs: number
  didFinishLoadMs: number
}

export interface StartupTimeline {
  /** 上一步到现在这一步结束，记为名叫 name 的一步 */
  step(name: string): void
  /** 到达窗口的某个里程碑；两个都到了就写那条汇总日志（只写一次，之后再开的窗口不再记） */
  reach(milestone: 'readyToShow' | 'didFinishLoad'): void
}

export function startupTimeline(
  write: (fields: StartupFields) => void,
  now: () => number = () => performance.now(),
): StartupTimeline {
  const origin = now()
  const bootMs = Math.round(origin)
  const steps: Record<string, number> = {}
  const reached: Partial<Record<'readyToShow' | 'didFinishLoad', number>> = {}
  let last = origin
  let written = false
  return {
    step(name) {
      if (written) return
      const t = now()
      steps[name] = Math.round(t - last)
      last = t
    },
    reach(milestone) {
      if (written || reached[milestone] !== undefined) return
      reached[milestone] = Math.round(now() - origin)
      if (reached.readyToShow === undefined || reached.didFinishLoad === undefined) return
      written = true
      write({ bootMs, steps, readyToShowMs: reached.readyToShow, didFinishLoadMs: reached.didFinishLoad })
    },
  }
}
