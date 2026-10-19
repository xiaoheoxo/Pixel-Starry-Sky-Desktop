import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 开设置独立窗口时，主窗口里先记下的请求带过去、在设置窗口里放回来（windowHints.ts）。
// 这几处请求都存在各自模块的内存里，所以每个用例重新加载模块，模拟「主窗口」和「设置窗口」两份内存。

const events: string[] = []
beforeEach(() => {
  vi.resetModules()
  events.length = 0
  vi.stubGlobal('window', {
    dispatchEvent: (e: { type: string }) => events.push(e.type),
    addEventListener: () => undefined,
  })
  vi.stubGlobal(
    'Event',
    class {
      constructor(public type: string) {}
    },
  )
})
afterEach(() => vi.unstubAllGlobals())

async function load() {
  return {
    hints: await import('./windowHints'),
    scroll: await import('./models/scroll'),
    engines: await import('./engines/nav'),
    ext: await import('@/features/extstore/nav'),
    logs: await import('@/features/logs/focus'),
    feedback: await import('@/features/feedback/focus'),
  }
}

describe('collectSettingsHints', () => {
  it('什么都没记：没有 hints', async () => {
    const { hints } = await load()
    expect(hints.collectSettingsHints()).toBeUndefined()
  })

  it('取走记下的请求，取走后这个窗口里不再有', async () => {
    const m = await load()
    m.scroll.requestModelsScroll()
    m.ext.openExtTab('discover')
    m.ext.openExtSearch()
    m.engines.openEngineDetail('claude')
    m.logs.requestLogFocus('s1', 100_000)
    m.feedback.requestFeedback({ threadId: 't1' })
    expect(m.hints.collectSettingsHints()).toEqual({
      modelsScroll: true,
      extTab: 'discover',
      extSearch: true,
      engineDetail: 'claude',
      logFocus: { sessionId: 's1', since: 40_000 },
      feedback: { threadId: 't1' },
    })
    // 都清了：下次从这个窗口打开不会又带一遍
    expect(m.scroll.takeModelsScroll()).toBe(false)
    expect(m.ext.getExtTab()).toBe('installed')
    expect(m.engines.getEngineDetail()).toBeNull()
    expect(m.logs.takeLogFocus()).toBeNull()
    expect(m.feedback.takeFeedbackFocus()).toBeNull()
    expect(m.hints.collectSettingsHints()).toBeUndefined()
  })
})

describe('applySettingsHints', () => {
  it('在设置窗口里把请求放回各自的模块，并像本窗口发起的一样通知已经打开的页面', async () => {
    const m = await load()
    m.hints.applySettingsHints({
      modelsScroll: true,
      extTab: 'publish',
      engineDetail: 'codex',
      logFocus: { sessionId: 's2', since: 5 },
      feedback: { threadId: 't2' },
    })
    expect(m.scroll.takeModelsScroll()).toBe(true)
    expect(m.ext.getExtTab()).toBe('publish')
    expect(m.engines.getEngineDetail()).toBe('codex')
    expect(m.logs.takeLogFocus()).toEqual({ sessionId: 's2', since: 5 })
    expect(events).toEqual(expect.arrayContaining(['pixelsky:log-focus', 'pixelsky:feedback-focus']))
    expect(m.feedback.takeFeedbackFocus()).toEqual({ threadId: 't2' })
  })
  it('extSearch：打开发现页并让搜索框拿焦点', async () => {
    const m = await load()
    m.hints.applySettingsHints({ extSearch: true })
    expect(m.ext.getExtTab()).toBe('discover')
    expect(m.ext.consumeExtSearchFocus()).toBe(true)
  })
  it('没有 hints：什么都不做', async () => {
    const m = await load()
    m.hints.applySettingsHints(undefined)
    expect(events).toEqual([])
  })
})
