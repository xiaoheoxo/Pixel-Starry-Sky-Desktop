import { describe, expect, it } from 'vitest'
import { applyPrompt, endSince, hasIntegration, weakSince, type PromptEvent, type PromptMarks } from './marks'

const prompt = (ran: boolean | null, exitCode: number | null = null, generation = 1): PromptEvent => ({
  type: 'prompt',
  terminalId: 't1',
  generation,
  ran,
  exitCode,
})
function apply(events: PromptEvent[]): PromptMarks | undefined {
  let marks: PromptMarks | undefined
  for (const event of events) marks = applyPrompt(marks, event)
  return marks
}

describe('提示符记录', () => {
  it('第一个提示符（ran=false）只算提示符，不算命令结束', () => {
    const marks = apply([prompt(false)])!
    expect(marks).toMatchObject({ prompts: 1, ends: 0, codes: [] })
    expect(hasIntegration(marks, 1)).toBe(true)
  })

  it('命令结束记下退出码；不报告的 shell（ran=null）的提示符不算命令结束，只记个数', () => {
    expect(apply([prompt(false), prompt(true, 3), prompt(true, 0)])).toMatchObject({ ends: 2, weak: 0, codes: [3, 0] })
    expect(apply([prompt(null), prompt(null)])).toMatchObject({ prompts: 2, ends: 0, weak: 2, codes: [] })
  })

  it('cmd 的提示符（echo on 的 .bat 每行回显都有一个）不会被当成命令结束，只在「正在停止」时用', () => {
    const marks = apply([prompt(null), prompt(null)])!
    expect(endSince(marks, 1, 0)).toBeNull()
    expect(weakSince(marks, 1, 2)).toBe(false)
    expect(weakSince(applyPrompt(marks, prompt(null)), 1, 2)).toBe(true)
    expect(weakSince(applyPrompt(marks, prompt(null)), 2, 2)).toBe(false)
  })

  it('没收到过标记：没有集成；换了一轮 shell（重启）也没有', () => {
    expect(hasIntegration(undefined, 1)).toBe(false)
    expect(hasIntegration(apply([prompt(false)]), 2)).toBe(false)
  })

  it('shell 重启（generation 变大）记录从头算；旧一轮迟到的事件不改记录', () => {
    const old = apply([prompt(false), prompt(true, 1)])!
    const restarted = applyPrompt(old, prompt(false, null, 2))!
    expect(restarted).toMatchObject({ generation: 2, prompts: 1, ends: 0 })
    expect(applyPrompt(restarted, prompt(true, 9, 1))).toBe(restarted)
  })

  it('只留最近的退出码，但 ends 一直累加', () => {
    const marks = apply(Array.from({ length: 100 }, (_, i) => prompt(true, i)))!
    expect(marks.ends).toBe(100)
    expect(marks.codes).toHaveLength(64)
    expect(marks.codes.at(-1)).toBe(99)
  })
})

describe('写入命令之后的第一次结束', () => {
  it('写入前的提示符和结束不算：base 之后才算', () => {
    // 写入命令时已经有 1 次结束（上一条命令）
    const marks = apply([prompt(false), prompt(true, 1)])!
    expect(endSince(marks, 1, 1)).toBeNull()
    // 之后 Ctrl+C 中止了整行：提示符回来
    const after = applyPrompt(marks, prompt(true, -1073741510))!
    expect(endSince(after, 1, 1)).toEqual({ code: -1073741510 })
  })

  it('取的是 base 之后的第一次结束，后面用户又在终端里跑别的命令不改结果', () => {
    let marks = apply([prompt(false)])!
    marks = applyPrompt(marks, prompt(true, 130))!
    marks = applyPrompt(marks, prompt(true, 0))!
    marks = applyPrompt(marks, prompt(true, 5))!
    expect(endSince(marks, 1, 0)).toEqual({ code: 130 })
    expect(endSince(marks, 1, 1)).toEqual({ code: 0 })
  })

  it('命令写入时第一个提示符还没出来（ran=false 晚到）：不算结束', () => {
    const before = apply([])
    expect(endSince(before, 1, 0)).toBeNull()
    const late = applyPrompt(before, prompt(false))!
    expect(endSince(late, 1, 0)).toBeNull()
  })

  it('终端重启过（generation 不同）不算', () => {
    const marks = apply([prompt(false), prompt(true, 0)])!
    expect(endSince(marks, 2, 0)).toBeNull()
  })

  it('base 之后的退出码已经被挤出记录时，用最早还留着的', () => {
    const marks = apply(Array.from({ length: 100 }, (_, i) => prompt(true, i)))!
    expect(endSince(marks, 1, 0)).toEqual({ code: 36 })
  })
})
