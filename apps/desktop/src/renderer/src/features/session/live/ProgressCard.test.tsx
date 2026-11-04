// 进度卡片按轮次的显示（docs/ui/progress-card.md §11）：已完成收成一行、上一轮没做完的、折叠时的当前步骤
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
const render = (plan: Plan): string => {
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
      <ProgressCard progress={progress} />
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

  it('折叠时多一行当前步骤；列表不显示', () => {
    collapsedPref()
    const html = render(plan)
    expect(html).toContain('第三步')
    expect(html).not.toContain('第四步')
  })

  it('折叠且全做完：写全部完成', () => {
    collapsedPref()
    const html = render({ id: 'p', done: 1, steps: [step('第一步', 'completed')] })
    expect(html).toContain(tr('session.progress.allDone', { total: 1 }))
    expect(html).not.toContain('第一步')
  })
})
