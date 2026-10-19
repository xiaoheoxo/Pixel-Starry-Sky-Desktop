import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { RegisterPanel, nameProblem } from './RegisterPanel'

describe('RegisterPanel', () => {
  it('名字规则用 isPublisherName', () => {
    expect(nameProblem('lin')).toBeNull()
    expect(nameProblem('ab')).not.toBeNull()
    expect(nameProblem('Lin')).not.toBeNull()
    expect(nameProblem('lin-')).not.toBeNull()
  })
  it('渲染说明和输入框；云端错误写在输入框下', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <RegisterPanel onRegister={async () => {}} initialError="这个发布者名已经被别人注册了，换一个" />
      </I18nProvider>,
    )
    expect(html).toContain('发布者名（id 前缀，注册后不能改）')
    expect(html).toContain('<input')
    expect(html).toContain('这个发布者名已经被别人注册了，换一个')
  })
})
