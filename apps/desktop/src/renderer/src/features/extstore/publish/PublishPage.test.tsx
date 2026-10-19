import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { PublishPage } from './PublishPage'

describe('PublishPage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('没有桥时按未登录渲染登录入口，不抛错', () => {
    vi.stubGlobal('window', {})
    const html = renderToStaticMarkup(
      <I18nProvider>
        <PublishPage />
      </I18nProvider>,
    )
    expect(html).toContain('data-publish="signed-out"')
  })
})
