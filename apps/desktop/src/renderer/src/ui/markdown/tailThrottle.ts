import type { StreamBlocks } from './streamBlocks'

/** 流式的尾巴超过这么多字就不再每帧重新解析（长尾巴每次解析、排版、代码高亮都很重） */
export const TAIL_SLOW_CHARS = 4000
/** 尾巴很长时最多隔这么久刷新一次 */
export const TAIL_SLOW_MS = 200

export interface TailThrottle {
  /** 渲染时调用：传入最新的切块结果，返回此刻该显示的（可能是稍早的）一份；总是某一时刻完整的 completed + tail，不会重复或缺字 */
  view(latest: StreamBlocks): StreamBlocks
  /** 渲染提交后调用：该延后刷新而还没排定时间的，排一个 TAIL_SLOW_MS 的定时器 */
  arm(): void
  /** 卸载 / 重新挂载时清掉定时器 */
  dispose(): void
}

/**
 * 流式尾巴的节流。显示出来的尾巴不超过 TAIL_SLOW_CHARS 时每次都跟上最新（每帧一次，和原来一样）；
 * 超过后最多每 TAIL_SLOW_MS 刷新一次。下面几种情况立刻同步刷新，免得显示出旧内容：
 * 已写完的块数变了（有块写完、尾巴从头开始）、尾巴不是在显示的尾巴后面接着写（变短、换了内容）。
 * 流式结束时整条换成完整渲染，不经过这里，也不会丢字。
 * onDue：定时器到点，要求调用方重新渲染一次（下一次 view 直接取最新）
 */
export function createTailThrottle(onDue: () => void): TailThrottle {
  let shown: StreamBlocks | null = null
  let pending = false
  let due = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    view(latest) {
      const flush =
        !shown ||
        due ||
        shown.tail.length <= TAIL_SLOW_CHARS ||
        latest.completed.length !== shown.completed.length ||
        !latest.tail.startsWith(shown.tail)
      if (flush) {
        shown = latest
        pending = false
        due = false
        clear()
      } else if (latest !== shown) {
        pending = true
      }
      return shown!
    },
    arm() {
      if (pending && !timer)
        timer = setTimeout(() => {
          timer = null
          due = true
          onDue()
        }, TAIL_SLOW_MS)
    },
    dispose: clear,
  }
}
