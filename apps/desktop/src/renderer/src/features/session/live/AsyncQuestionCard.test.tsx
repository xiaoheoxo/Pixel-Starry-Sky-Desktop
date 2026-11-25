import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import { I18nProvider } from '@/i18n/I18nProvider'
import {
  AsyncQuestionCard,
  clearDismissedAsyncQuestionCache,
  readDismissedAsyncQuestions,
  saveDismissedAsyncQuestion,
} from './AsyncQuestionCard'
import type { ActiveAsyncQuestion } from './asyncQuestionModel'

const render = (active: ActiveAsyncQuestion): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <AsyncQuestionCard
        active={active}
        onSubmit={async () => undefined}
        onDismiss={() => undefined}
        onEscape={() => undefined}
      />
    </I18nProvider>,
  )

describe('AsyncQuestionCard', () => {
  it('渲染异步提问徽章、1–9 快捷键、推荐标记、「都按推荐」、「其他」与「跳过」按钮', () => {
    const html = render({
      itemId: 'cx-q1',
      questions: [
        {
          header: '',
          question: '使用哪种数据库？',
          options: [
            { label: 'Postgres (Recommended)', description: '' },
            { label: 'SQLite', description: '' },
          ],
          multiSelect: false,
          allowOther: true,
        },
      ],
    })
    expect(html).toContain('data-async-question-card="cx-q1"')
    expect(html).toContain('Codex 提问')
    expect(html).toContain('异步 · 不阻塞当前执行')
    expect(html).toContain('data-recommended')
    expect(html).toContain('data-all-recommended')
    expect(html).toContain('data-question-other')
    expect(html).toContain('跳过')

    const freeTextHtml = render({
      itemId: 'cx-q2',
      questions: [{ header: '', question: '补充说明？', options: [], multiSelect: false, allowOther: true }],
    })
    expect(freeTextHtml).toContain('aria-label="补充说明？"')
    expect(freeTextHtml).not.toContain('data-all-recommended')
  })

  it('已跳过的提问 id 按会话持久化到 sessionStorage，并限制最近 64 条', () => {
    const store = new Map<string, string>()
    const prev = (globalThis as { sessionStorage?: unknown }).sessionStorage
    ;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    }
    try {
      clearDismissedAsyncQuestionCache()
      expect(readDismissedAsyncQuestions('s1').size).toBe(0)
      for (let i = 0; i < 70; i++) saveDismissedAsyncQuestion('s1', `cx-${i}`)
      const saved = readDismissedAsyncQuestions('s1')
      expect(saved.size).toBe(64)
      expect(saved.has('cx-69')).toBe(true)
      expect(saved.has('cx-0')).toBe(false)
      expect(readDismissedAsyncQuestions('s2').size).toBe(0)
    } finally {
      ;(globalThis as { sessionStorage?: unknown }).sessionStorage = prev
    }
  })
})
