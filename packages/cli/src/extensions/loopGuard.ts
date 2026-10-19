// 防止模型原地打转：没人盯着的时候（频道派活、子智能体、开着完全放行走开）一直重复同一件事会白白烧钱。
// - 同一个工具、同样的参数连着调用，结果也一模一样：第 3 次起在结果后面提醒模型换个办法；第 5 次不再执行，这一轮停下；
// - 连着 6 步（一步 = 模型一次回复里的那批工具调用）全部失败：这一轮停下。
// 停下的办法是拦下工具调用并带 terminate（Pi 在这批调用结束后不再请求模型），同时在对话里提示用户。
// 用户发了新消息或中途插话就重新计数。codemode 脚本里的嵌套调用不算（脚本本来就可能循环调用）。
// 只用可擦除的 TS 语法。
import { createHash } from 'node:crypto'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

/** 同样的调用、同样的结果连着第几次开始提醒 */
export const REPEAT_WARN = 3
/** 同样的调用、同样的结果已经连着这么多次，下一次就拦下并停止 */
export const REPEAT_STOP = 5
/** 连着几步全部失败就停止 */
export const FAILED_STEPS_STOP = 6

const TAG = '[loop guard]'

type Json = Record<string, unknown>
type Content = { type: string; text?: string; data?: string }

/** 参数按键排序后序列化：键的顺序不同也算同一个调用 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value as Json)
        .sort()
        .filter(key => (value as Json)[key] !== undefined)
        .map(key => JSON.stringify(key) + ':' + stableJson((value as Json)[key]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value) ?? 'null'
}

const hash = (text: string): string => createHash('sha1').update(text).digest('hex')

export const callKey = (toolName: string, input: unknown): string => hash(toolName + '\0' + stableJson(input))

/** 工具结果的指纹：文字原样，图片只看大小；失败和成功分开 */
export function resultKey(content: readonly Content[] | undefined, isError: boolean): string {
  const parts = (content ?? []).map(c =>
    c.type === 'text' ? 't:' + (c.text ?? '') : `${c.type}:${c.data?.length ?? 0}`,
  )
  return hash((isError ? 'error\0' : 'ok\0') + parts.join('\0'))
}

export type GuardStop = { kind: 'repeat'; tool: string; count: number } | { kind: 'failed'; steps: number }

/** 计数和判断，不碰 Pi（方便测试） */
export class LoopGuard {
  private last: { call: string; result: string; count: number } | null = null
  private failedSteps = 0
  private stop: GuardStop | null = null

  reset(): void {
    this.last = null
    this.failedSteps = 0
    this.stop = null
  }

  /** 已经决定停下的原因；没有为 null */
  get stopped(): GuardStop | null {
    return this.stop
  }

  /** 工具调用前：要拦下就返回停下的原因 */
  beforeCall(toolName: string, input: unknown): GuardStop | null {
    if (this.stop) return this.stop
    const last = this.last
    if (last && last.count >= REPEAT_STOP - 1 && last.call === callKey(toolName, input))
      this.stop = { kind: 'repeat', tool: toolName, count: last.count }
    return this.stop
  }

  /** 工具出结果后：返回连着第几次一模一样（1 是和上一次不同） */
  afterResult(toolName: string, input: unknown, content: readonly Content[] | undefined, isError: boolean): number {
    const call = callKey(toolName, input),
      result = resultKey(content, isError)
    if (this.last && this.last.call === call && this.last.result === result) this.last.count++
    else this.last = { call, result, count: 1 }
    return this.last.count
  }

  /** 一步结束：这一步的工具结果全部失败就累计，有一个成功就清零。没有工具调用的一步不算 */
  afterStep(results: readonly { isError?: boolean }[]): void {
    if (!results.length || this.stop) return
    this.failedSteps = results.every(r => r.isError) ? this.failedSteps + 1 : 0
    if (this.failedSteps >= FAILED_STEPS_STOP) this.stop = { kind: 'failed', steps: this.failedSteps }
  }
}

/** 第 count 次一模一样时附在结果后面给模型看的提醒 */
export function repeatWarning(toolName: string, count: number): string {
  return (
    `${TAG} This is identical "${toolName}" call #${count} in a row, and the result has not changed. ` +
    'Repeating it will not help: try a different approach, or stop and explain to the user what is blocking you. ' +
    `Identical call #${REPEAT_STOP} will be blocked and this run stopped.`
  )
}

/** 拦下时回给模型的原因 */
export function blockReason(stop: GuardStop): string {
  return stop.kind === 'repeat'
    ? `${TAG} Blocked: this identical "${stop.tool}" call already ran ${stop.count} times in a row with the same result. ` +
        'The run is being stopped so the user can take a look.'
    : `${TAG} Blocked: every tool call failed in the last ${stop.steps} steps. ` +
        'The run is being stopped so the user can take a look.'
}

/** 停下时给用户的提示（桌面端按英文原文翻译，shared/i18n/pixelMessages.ts） */
export function stopNotice(stop: GuardStop): string {
  return stop.kind === 'repeat'
    ? `Stopped this run: the agent repeated the same "${stop.tool}" call ${stop.count} times in a row with the same result. Send a message to continue.`
    : `Stopped this run: every tool call failed for ${stop.steps} steps in a row. Send a message to continue.`
}

/** 要放在审批扩展前面：拦下的重复调用不用再问用户 */
export function loopGuardExtension(pi: ExtensionAPI): void {
  const guard = new LoopGuard()
  let notified = false
  const reset = (): void => {
    guard.reset()
    notified = false
  }
  pi.on('agent_start', async () => reset())
  pi.on('message_start', async event => {
    if ((event.message as { role?: string }).role === 'user') reset()
  })
  pi.on('tool_call', async (event, ctx: ExtensionContext) => {
    if (event.parentToolCallId) return undefined
    const stop = guard.beforeCall(event.toolName, event.input)
    if (!stop) return undefined
    if (!notified) {
      notified = true
      ctx.ui.notify(stopNotice(stop), 'warning')
    }
    return { block: true, reason: blockReason(stop), terminate: true }
  })
  pi.on('tool_result', async event => {
    if (event.parentToolCallId) return undefined
    const count = guard.afterResult(event.toolName, event.input, event.content as Content[], event.isError)
    if (count < REPEAT_WARN) return undefined
    return {
      content: [...event.content, { type: 'text' as const, text: repeatWarning(event.toolName, count) }],
      structuredContent: event.structuredContent,
    }
  })
  pi.on('turn_end', async event => {
    guard.afterStep(event.toolResults as { isError?: boolean }[])
    return undefined
  })
}
