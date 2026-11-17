import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { DotProfilePanel } from './DotProfilePanel'
import { DotKeyContext } from './context'
const entry = {
  key: 'key',
  account: 'default',
  accountName: 'pro@example.com',
  id: 'dot',
  threadId: 'root',
  name: '我的 Dot',
  status: 'active',
}
describe('original Dot profile panel', () => {
  it('shows real computer, recent activity and file information', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DotKeyContext.Provider value="key">
          <DotProfilePanel
            entry={entry}
            overview={{
              profile: entry,
              environment: { status: 'connected', capabilities: [{ type: 'remote_desktop', status: 'ready' }] },
              activity: [],
              tasks: [],
              errors: [],
            }}
            outputs={[{ type: 'file', name: 'result.mp4' }]}
          />
        </DotKeyContext.Provider>
      </I18nProvider>,
    )
    expect(html).toContain('你的 Dot 的电脑')
    expect(html).toContain('已就绪')
    expect(html).toContain('最近无活动')
    expect(html).toContain('result.mp4')
    expect(html).toContain('https://chatgpt.com/dots/dot')
  })
  it('does not claim that a computer is ready when the status could not be read', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DotProfilePanel entry={entry} outputs={[]} />
      </I18nProvider>,
    )
    expect(html).toContain('未获取设备信息')
    expect(html).not.toContain('已就绪')
  })
})
