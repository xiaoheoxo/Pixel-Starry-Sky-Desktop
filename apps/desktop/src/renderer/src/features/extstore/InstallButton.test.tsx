import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { InstallButton } from './InstallButton'
import type { CardAction } from './storeModel'

const html = (action: CardAction) =>
  renderToStaticMarkup(
    <I18nProvider>
      <InstallButton id="a.b" version="1.0.0" action={action} onInstall={vi.fn()} onCancel={vi.fn()} />
    </I18nProvider>,
  )

describe('InstallButton', () => {
  it('安装 / 已安装 / 更新', () => {
    expect(html({ kind: 'install' })).toContain('>安装<')
    expect(html({ kind: 'installed' })).toContain('已安装')
    expect(html({ kind: 'update', version: '2.0.0' })).toContain('>更新<')
  })
  it('下载中：百分比和取消；不知道总大小时只写「下载中」', () => {
    const h = html({ kind: 'installing', phase: 'downloading', percent: 45 })
    expect(h).toContain('下载中 45%')
    expect(h).toContain('取消')
    const none = html({ kind: 'installing', phase: 'downloading', percent: null })
    expect(none).toContain('下载中')
    expect(none).not.toContain('%')
  })
  it('校验中、安装中：没有取消按钮，也没有可点的安装按钮', () => {
    const v = html({ kind: 'installing', phase: 'verifying', percent: null })
    expect(v).toContain('校验中')
    expect(v).not.toContain('<button')
    const i = html({ kind: 'installing', phase: 'installing', percent: null })
    expect(i).toContain('安装中')
    expect(i).not.toContain('<button')
  })
  it('无法更新', () => {
    expect(html({ kind: 'updateBlocked', need: '0.5.0' })).toContain('无法更新')
  })
})
