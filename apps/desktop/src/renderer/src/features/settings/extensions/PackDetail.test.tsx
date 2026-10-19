import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {}
})
import { I18nProvider } from '@/i18n/I18nProvider'
import { namedPack as fakePack } from '@/features/extstore/installed/testing'
import { PackDetail } from './PackDetail'

const render = (pack: ReturnType<typeof fakePack>): string =>
  renderToStaticMarkup(
    <I18nProvider>
      <PackDetail pack={pack} all={[pack]} onClose={() => {}} />
    </I18nProvider>,
  )

const enableButton = (html: string): string => /<button[^>]*>(?:(?!<\/button>).)*启用<\/button>/.exec(html)?.[0] ?? ''

describe('PackDetail 启用按钮', () => {
  const blocked = { reason: '上传文件内容', at: '2026-10-14T08:00:00Z' }
  it('被平台停用且关着：「启用」disabled，写原因', () => {
    const html = render(fakePack({ enabled: false, live: false, blocked }))
    expect(enableButton(html)).toContain('disabled=""')
    expect(html).toContain('已被平台停用，不能启用：上传文件内容')
  })
  it('被平台停用但开着：「停用」照常能点', () => {
    const html = render(fakePack({ enabled: true, live: false, blocked }))
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>(?:(?!<\/button>).)*停用<\/button>/)
  })
  it('被替代：按钮可点，写原因', () => {
    const html = render(fakePack({ enabled: false, live: false, shadowedBy: 'folder' }))
    expect(enableButton(html)).not.toContain('disabled=""')
    expect(html).toContain('已被开发中的同名扩展替代')
  })
  it('普通扩展关着：「启用」可点', () => {
    expect(enableButton(render(fakePack({ enabled: false, live: false })))).not.toContain('disabled=""')
  })
})
