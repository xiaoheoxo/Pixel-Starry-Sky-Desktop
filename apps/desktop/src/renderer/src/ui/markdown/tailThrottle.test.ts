import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStreamSplitter, type StreamBlocks } from './streamBlocks'
import { TAIL_SLOW_CHARS, TAIL_SLOW_MS, createTailThrottle } from './tailThrottle'

/** 模拟 StreamingBody：每次 push 相当于父组件给了新文字，渲染一次（view），提交后 arm；定时器到点再渲染一次 */
function harness() {
  const split = createStreamSplitter()
  let text = ''
  let shown: StreamBlocks = { completed: [], tail: '' }
  const parsed: string[] = [] // 每次「尾巴被重新解析」时的尾巴
  const throttle = createTailThrottle(() => render())
  const render = (): void => {
    const next = throttle.view(split(text))
    if (next !== shown) parsed.push(next.tail)
    shown = next
    throttle.arm()
  }
  return {
    push(add: string) {
      text += add
      render()
    },
    get shown() {
      return shown
    },
    get text() {
      return text
    },
    parsed,
    throttle,
  }
}

describe('createTailThrottle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('短尾巴每次都跟上最新，不起定时器', () => {
    const h = harness()
    for (let i = 0; i < 20; i++) h.push('字'.repeat(50))
    expect(h.shown.tail).toBe(h.text)
    expect(h.parsed).toHaveLength(20)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('尾巴超过 4000 字：每 200 毫秒最多刷新一次，期间显示的还是上一份', () => {
    const h = harness()
    h.push('a'.repeat(TAIL_SLOW_CHARS + 1)) // 第一次直接显示
    const base = h.parsed.length
    const first = h.shown.tail
    for (let i = 0; i < 10; i++) {
      h.push('b'.repeat(20))
      vi.advanceTimersByTime(16)
    }
    // 160ms 过去了，还没到点：显示不变
    expect(h.shown.tail).toBe(first)
    expect(h.parsed).toHaveLength(base)
    vi.advanceTimersByTime(TAIL_SLOW_MS)
    expect(h.shown.tail).toBe(h.text)
    expect(h.parsed).toHaveLength(base + 1)
  })

  it('慢速期间到点才补一次：持续输入 2 秒，刷新次数约 2000/200，而不是 125 帧', () => {
    const h = harness()
    h.push('a'.repeat(TAIL_SLOW_CHARS + 1))
    const base = h.parsed.length
    for (let t = 0; t < 2000; t += 16) {
      h.push('b'.repeat(10))
      vi.advanceTimersByTime(16)
    }
    const n = h.parsed.length - base
    expect(n).toBeGreaterThanOrEqual(8)
    expect(n).toBeLessThanOrEqual(11)
    // 最后补一次到点，显示追平最新
    vi.advanceTimersByTime(TAIL_SLOW_MS)
    expect(h.shown.tail).toBe(h.text)
  })

  it('有块写完：立刻同步刷新，已写完的块和尾巴都是最新的，没有重复也没有缺字', () => {
    const h = harness()
    h.push('a'.repeat(TAIL_SLOW_CHARS + 100))
    h.push('b'.repeat(30)) // 被延后
    expect(h.shown.tail).not.toBe(h.text)
    h.push('\n\n新的一段')
    expect(h.shown.completed).toHaveLength(1)
    expect(h.shown.tail).toBe('新的一段')
    expect(h.shown.completed.join('') + h.shown.tail).toBe(h.text)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('围栏代码块里的空行不算写完；围栏闭合后块写完才同步刷新', () => {
    const h = harness()
    h.push('```ts\n' + 'x\n\n'.repeat(1500))
    expect(h.shown.completed).toHaveLength(0)
    h.push('y\n') // 尾巴远超 4000，被延后
    expect(h.shown.tail).not.toBe(h.text)
    h.push('```\n\n后面')
    expect(h.shown.completed).toHaveLength(1)
    expect(h.shown.completed.join('') + h.shown.tail).toBe(h.text)
  })

  it('文字变短或换了内容：立刻刷新', () => {
    const h = harness()
    h.push('a'.repeat(TAIL_SLOW_CHARS + 100))
    h.push('b')
    expect(h.shown.tail).not.toBe(h.text)
    // 换成一段全新的文字（不是接着写）
    const split = createStreamSplitter()
    const t = createTailThrottle(() => {})
    const long = split('a'.repeat(TAIL_SLOW_CHARS + 100))
    t.view(long)
    const replaced = split('完全不同')
    expect(t.view(replaced)).toBe(replaced)
  })

  it('卸载（dispose）后定时器不再触发刷新', () => {
    const h = harness()
    h.push('a'.repeat(TAIL_SLOW_CHARS + 100))
    h.push('b')
    h.throttle.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(h.shown.tail).not.toBe(h.text)
  })

  it('定时器只排一个：延后期间多次渲染不叠加', () => {
    const h = harness()
    h.push('a'.repeat(TAIL_SLOW_CHARS + 100))
    for (let i = 0; i < 5; i++) h.push('b')
    expect(vi.getTimerCount()).toBe(1)
  })
})
