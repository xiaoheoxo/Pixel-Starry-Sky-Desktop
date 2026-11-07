import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import { I18nProvider } from '@/i18n/I18nProvider'
import { TaskStrip } from './SessionStrips'

const tasks = [{ id: 't', kind: 'local_bash', description: 'npm run dev', message: 'ready on http://localhost:5173/' }]
const render = (props: Partial<Parameters<typeof TaskStrip>[0]>): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <TaskStrip sessionId="s" tasks={tasks} {...props} />
    </I18nProvider>,
  )

describe('TaskStrip', () => {
  it('对话里的任务条：卡片框还在，没有打开按钮', () => {
    const html = render({})
    expect(html).toContain('rounded-xl')
    expect(html).not.toContain('lucide-globe')
  })
  it('概况里：不要卡片框，进度里写着本机地址才带打开按钮', () => {
    const html = render({ bare: true, onOpenPort: () => {} })
    expect(html).not.toContain('rounded-xl')
    expect(html).toContain('lucide-globe')
    expect(html).toContain(':5173')
    expect(render({ bare: true, onOpenPort: () => {}, tasks: [{ ...tasks[0], message: null }] })).not.toContain(
      'lucide-globe',
    )
  })
})
