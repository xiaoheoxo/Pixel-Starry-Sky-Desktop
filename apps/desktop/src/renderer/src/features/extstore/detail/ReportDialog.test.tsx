import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import { I18nProvider } from '@/i18n/I18nProvider'
import { ReportFormView, type ReportFormViewProps } from './ReportDialog'

const noop = (): void => undefined
const render = (over: Partial<ReportFormViewProps> = {}): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <ReportFormView
        draft={{ reason: 'broken', detail: '', version: '1.0.0' }}
        versions={['1.2.0', '1.0.0']}
        signedIn
        busy={false}
        done={false}
        error={null}
        onChange={noop}
        onSubmit={noop}
        onLogin={noop}
        onClose={noop}
        {...over}
      />
    </I18nProvider>,
  )

const buttonOf = (html: string, label: string): string =>
  new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? ''

describe('ReportFormView', () => {
  it('原因六选一', () => {
    const html = render()
    expect(html.match(/type="radio"/g)).toHaveLength(6)
    for (const label of ['恶意', '不能用', '侵权', '不当内容', '名不副实', '其他']) expect(html).toContain(label)
  })

  it('说明框 maxLength=2000', () => {
    expect(render()).toContain('maxLength="2000"')
  })

  it('选「其他」时说明必填：没写提交按钮灰，写了可点', () => {
    const empty = render({ draft: { reason: 'other', detail: '', version: '1.0.0' } })
    expect(empty).toContain('required=""')
    expect(empty).toContain('选「其他」时必须写明说明')
    expect(buttonOf(empty, '提交举报')).toContain('disabled=""')
    const filled = render({ draft: { reason: 'other', detail: '偷代码', version: '1.0.0' } })
    expect(buttonOf(filled, '提交举报')).not.toContain('disabled=""')
  })

  it('其他原因不要求说明', () => {
    const html = render({ draft: { reason: 'broken', detail: '', version: '1.0.0' } })
    expect(html).not.toContain('required=""')
    expect(buttonOf(html, '提交举报')).not.toContain('disabled=""')
  })

  it('2001 字时提交按钮变灰', () => {
    const html = render({ draft: { reason: 'broken', detail: 'a'.repeat(2001), version: '1.0.0' } })
    expect(buttonOf(html, '提交举报')).toContain('disabled=""')
    expect(html).toContain('2001/2000')
  })

  it('没选原因时提交按钮灰', () => {
    const html = render({ draft: { reason: null, detail: '', version: '1.0.0' } })
    expect(buttonOf(html, '提交举报')).toContain('disabled=""')
  })

  it('版本默认选中传进来的版本', () => {
    expect(render()).toMatch(/<option value="1\.0\.0" selected=""/)
  })

  it('没登录：按钮是「登录后举报」，没有提交按钮', () => {
    const html = render({ signedIn: false })
    expect(html).toContain('登录后举报')
    expect(html).not.toContain('提交举报')
  })

  it('提交失败：显示错误文案（rate_limited）', () => {
    const html = render({ error: '今天的举报次数用完了：一个账号一天最多 10 次' })
    expect(html).toContain('data-report-error')
    expect(html).toContain('今天的举报次数用完了')
  })

  it('提交成功后显示已提交', () => {
    expect(render({ done: true })).toContain('已提交举报')
  })
})
