import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { DelistConfirm } from './DelistConfirm'

// ConfirmDialog 用 createPortal，服务端渲染不支持：换成直接输出文字的替身
vi.mock('@/ui/ConfirmDialog', () => ({
  ConfirmDialog: (p: { title: string; description: string; confirmLabel: string; cancelLabel: string }) => (
    <div>
      <h3>{p.title}</h3>
      <p>{p.description}</p>
      <button>{p.cancelLabel}</button>
      <button>{p.confirmLabel}</button>
    </div>
  ),
}))

describe('DelistConfirm', () => {
  it('文案', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DelistConfirm name="Swift 支持" busy={false} onConfirm={() => {}} onCancel={() => {}} />
      </I18nProvider>,
    )
    expect(html).toContain('下架 Swift 支持？')
    expect(html).toContain('下架后不在商店里显示、不能新装；已经装了的人照常能用')
    expect(html).toContain('取消')
  })
})
