// 进度卡片按轮次的显示（docs/ui/progress-card.md §11）：已完成收成一行、上一轮没做完的；收起时顶部那一条（§4）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { TodoStep } from '@pixelsky/protocol'
import { I18nProvider } from '@/i18n/I18nProvider'
import { tr } from '../../../i18n/core'
import { ProgressCard, type Progress } from './ProgressCard'
import type { Plan } from './progressData'

const step = (text: string, status: TodoStep['status']): TodoStep => ({ text, status })
const render = (
  plan: Plan,
  extra: { docked?: boolean; onDock?: () => void; onConfigure?: () => void; overrideCount?: number } = {},
): string => {
  const progress: Progress = {
    plan,
    agents: [],
    background: false,
    working: true,
    visible: true,
    dismiss: () => {},
    reveal: () => {},
  }
  return renderToStaticMarkup(
    <I18nProvider>
      <ProgressCard progress={progress} {...extra} />
    </I18nProvider>,
  )
}
const collapsedPref = () => vi.stubGlobal('localStorage', { getItem: () => '1', setItem: () => {} })

afterEach(() => vi.unstubAllGlobals())

describe('ProgressCard', () => {
  const plan: Plan = {
    id: 'p',
    done: 2,
    steps: [
      step('第一步', 'completed'),
      step('第二步', 'completed'),
      step('第三步', 'in_progress'),
      step('第四步', 'pending'),
    ],
  }

  it('做完两步起收成一行，当前和后面的步骤都在', () => {
    const html = render(plan)
    expect(html).toContain(tr('session.progress.doneFolded', { n: 2 }))
    expect(html).not.toContain('第一步')
    expect(html).toContain('第三步')
    expect(html).toContain('第四步')
    expect(html).toContain('data-progress-float')
    expect(html).not.toContain('data-progress-strip')
  })

  it('全做完时列全，不收', () => {
    const html = render({ id: 'p', done: 2, steps: [step('第一步', 'completed'), step('第二步', 'completed')] })
    expect(html).toContain('第一步')
    expect(html).not.toContain(tr('session.progress.doneFolded', { n: 2 }))
  })

  it('上一轮没做完的排在最后、带标记，不算进度', () => {
    const html = render({ id: 'p', done: 0, steps: [step('新的', 'in_progress')], carried: [step('旧的', 'pending')] })
    expect(html).toContain(tr('session.progress.steps', { done: 0, total: 1 }))
    expect(html.indexOf('新的')).toBeLessThan(html.indexOf('旧的'))
    expect(html).toContain(tr('session.progress.carried'))
  })

  it('折叠时收成顶部一条，写当前步骤；卡片和列表不显示', () => {
    collapsedPref()
    const html = render(plan)
    expect(html).toContain('data-progress-strip')
    expect(html).not.toContain('data-progress-float')
    expect(html).not.toContain('<section')
    expect(html).toContain('第三步')
    expect(html).not.toContain('第四步')
    // 有当前步骤：特别窄时概要让给它
    expect(html).toContain('data-progress-sum')
  })

  it('折叠且全做完：写全部完成，这一句在多窄都不藏', () => {
    collapsedPref()
    const html = render({ id: 'p', done: 1, steps: [step('第一步', 'completed')] })
    expect(html).toContain(tr('session.progress.allDone', { total: 1 }))
    expect(html).not.toContain('第一步')
    expect(html).not.toContain('data-progress-sum')
  })

  it('去概况的按钮：浮着和收成一条时都有，没传 onDock（代码模式）就没有', () => {
    const onDock = () => {}
    expect(render(plan)).not.toContain(tr('overview.dock'))
    expect(render(plan, { onDock })).toContain(tr('overview.dock'))
    collapsedPref()
    expect(render(plan, { onDock })).toContain(tr('overview.dock'))
  })

  it('后续子任务设置入口只在提供编辑能力时显示，浮层和收起条都有', () => {
    const onConfigure = () => {}
    expect(render(plan)).not.toContain(tr('subagentRoute.session.title'))
    expect(render(plan, { onConfigure, overrideCount: 2 })).toContain(tr('subagentRoute.session.overridden', { n: 2 }))
    collapsedPref()
    expect(render(plan, { onConfigure })).toContain(tr('subagentRoute.session.title'))
  })

  it('停靠：不浮着、没有条，没有 ✕ 和停靠按钮；存过的折叠偏好不管用', () => {
    collapsedPref()
    const html = render(plan, { docked: true, onDock: () => {} })
    expect(html).not.toContain('data-progress-float')
    expect(html).not.toContain('data-progress-strip')
    expect(html).not.toContain('absolute')
    expect(html).not.toContain(tr('session.progress.dismiss'))
    expect(html).not.toContain(tr('overview.dock'))
    expect(html).toContain('第四步')
  })
})
