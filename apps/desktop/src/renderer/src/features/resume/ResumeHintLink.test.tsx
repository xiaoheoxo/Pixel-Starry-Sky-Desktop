// 项目空状态的「终端里原来的会话」提示：有会话时接着聊；没找到 / 查失败 / 正在查时给「重新查找」（probe）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
// 引擎的 store 在导入时读 window.pixelsky：先放一个带事件方法的空 window
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
// 默认执行者用的 useEngineState 没有服务端快照，静态渲染时换成固定值
vi.mock('@/features/engine', () => ({ useEngineState: () => undefined }))
import type { NativeSessionSummary } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { ensureResumeCounts, resetResumeHints } from './hint'
import { ResumeHintLink } from './ResumeHintLink'

const sessions = (n: number): NativeSessionSummary[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, ownerId: null }) as unknown as NativeSessionSummary)

const render = (probe: boolean): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <ResumeHintLink projectId="p" probe={probe} />
    </I18nProvider>,
  )

afterEach(() => resetResumeHints())

describe('ResumeHintLink', () => {
  it('还没查过：什么都不画', () => {
    resetResumeHints(async () => [])
    expect(render(true)).toBe('')
  })
  it('有会话：接着聊（probe 与否一样）', async () => {
    resetResumeHints(async (_p, engine) => (engine === 'claude' ? sessions(2) : []))
    await ensureResumeCounts('p')
    for (const probe of [false, true]) {
      const html = render(probe)
      expect(html).toContain('这个项目有 2 个 Claude Code 会话可以接着聊')
      expect(html).toContain('data-resume-hint-action="open"')
    }
  })
  it('没找到：probe 时给「重新查找」，不 probe 时不画', async () => {
    resetResumeHints(async () => [])
    await ensureResumeCounts('p')
    expect(render(false)).toBe('')
    const html = render(true)
    expect(html).toContain('data-resume-hint="none"')
    expect(html).toContain('没找到终端里原来的 Claude Code / Codex 会话')
    expect(html).toContain('data-resume-hint-action="recheck"')
  })
  it('查失败：说哪个引擎出错、悬停看原因、可以重试；正在查时显示「正在查找」', async () => {
    resetResumeHints(async (_p, engine) => {
      if (engine === 'codex') throw new Error('读取超时')
      return []
    })
    await ensureResumeCounts('p')
    const html = render(true)
    expect(html).toContain('data-resume-hint="failed"')
    expect(html).toContain('查找 Codex 会话时出错')
    expect(html).toContain('title="Codex：读取超时"')
    expect(html).toContain('data-resume-hint-action="recheck"')
    // 两个引擎各一个查询，都挂着
    const waiting: Array<() => void> = []
    resetResumeHints(() => new Promise(r => waiting.push(() => r([]))))
    const pending = ensureResumeCounts('p')
    expect(render(true)).toContain('正在查找终端里原来的会话…')
    waiting.forEach(release => release())
    await pending
  })
})
