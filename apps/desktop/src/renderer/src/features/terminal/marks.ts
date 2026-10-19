// 终端的提示符记录（shell 集成，main/terminal/shellMarks.ts 发来的 prompt 事件）：
// 任务面板用它知道「命令写进去之后，提示符回来了没、上一条命令的退出码是多少」。纯逻辑，不碰 window。
import type { TerminalEvent } from '../../../../shared/types/terminal'

export type PromptEvent = Extract<TerminalEvent, { type: 'prompt' }>

export interface PromptMarks {
  /** 记录属于哪一轮 shell（重启后 generation 变，记录从头算） */
  generation: number
  /** 收到的提示符个数；大于 0 说明这个 shell 的集成生效了 */
  prompts: number
  /** 命令结束的次数（提示符回来，而且 shell 确认之前真跑过命令） */
  ends: number
  /** 不报告命令结束的 shell（cmd）发来的提示符个数：echo on 的 .bat、for 循环每行回显都会出一个，所以不能当命令结束，只用来收「正在停止」 */
  weak: number
  /** 最近几次命令结束的退出码（不知道为 null），最后一个是第 ends 次 */
  codes: (number | null)[]
}

/** 只留最近这么多次退出码，够任务面板找「写入命令之后的第一次结束」了 */
const KEEP_CODES = 64

/** 收到一个 prompt 事件后的记录；旧一轮 shell 的迟到事件返回原对象 */
export function applyPrompt(marks: PromptMarks | undefined, event: PromptEvent): PromptMarks | undefined {
  if (marks && event.generation < marks.generation) return marks
  const base: PromptMarks =
    marks && marks.generation === event.generation
      ? marks
      : { generation: event.generation, prompts: 0, ends: 0, weak: 0, codes: [] }
  // ran === true 才是命令结束；false 是没跑过命令的提示符（第一个提示符、清屏重画）；null 是不报告的 shell（cmd），只记个数
  const ended = event.ran === true
  return {
    generation: base.generation,
    prompts: base.prompts + 1,
    ends: base.ends + (ended ? 1 : 0),
    weak: base.weak + (event.ran === null ? 1 : 0),
    codes: ended ? [...base.codes, event.exitCode].slice(-KEEP_CODES) : base.codes,
  }
}

/** 这个 shell 报告提示符吗（当前这一轮收到过至少一个提示符标记） */
export const hasIntegration = (marks: PromptMarks | undefined, generation: number): boolean =>
  !!marks && marks.generation === generation && marks.prompts > 0

/**
 * 记下 `base`（命令写入时的 ends）之后第一次结束；还没有返回 null。
 * 退出码被挤出记录时（base 之后结束了很多次）用最早还留着的。
 */
export function endSince(
  marks: PromptMarks | undefined,
  generation: number,
  base: number,
): { code: number | null } | null {
  if (!marks || marks.generation !== generation || marks.ends <= base) return null
  const index = Math.max(0, base - (marks.ends - marks.codes.length))
  return { code: marks.codes[index] ?? null }
}

/** 不报告命令结束的 shell：base（点停止时的 weak）之后又出了提示符吗 */
export const weakSince = (marks: PromptMarks | undefined, generation: number, base: number): boolean =>
  !!marks && marks.generation === generation && marks.weak > base
