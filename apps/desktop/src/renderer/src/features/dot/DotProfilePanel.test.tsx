import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { DotProfilePanel, statusTone } from './DotProfilePanel'
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
describe('Dot profile panel', () => {
  it('shows the computer, recent tasks with status, files and links into ChatGPT', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DotKeyContext.Provider value="key">
          <DotProfilePanel
            entry={entry}
            overview={{
              profile: entry,
              environment: { status: 'connected', capabilities: [{ type: 'remote_desktop', status: 'ready' }] },
              activity: [],
              tasks: [{ id: 't', title: '整理更新说明', status: 'needsInput' }],
              errors: ['Dot paused or unavailable; open ChatGPT'],
            }}
            outputs={[{ type: 'file', name: 'result.mp4' }]}
          />
        </DotKeyContext.Provider>
      </I18nProvider>,
    )
    expect(html).toContain('云电脑')
    expect(html).toContain('已就绪')
    expect(html).toContain('整理更新说明')
    expect(html).toContain('等待输入')
    expect(html).toContain('result.mp4')
    expect(html).toContain('在 ChatGPT 里')
    expect(html).toContain('呼叫 我的 Dot')
    expect(html).toContain('https://chatgpt.com/dots/dot')
    // 报错是中文
    expect(html).toContain('Dot 已暂停或暂不可用')
    expect(html).not.toContain('pro@example.com')
  })
  it('does not claim that a computer is ready when the status could not be read', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DotProfilePanel entry={entry} outputs={[]} />
      </I18nProvider>,
    )
    expect(html).toContain('未获取')
    expect(html).not.toContain('已就绪')
  })
  it('colors task status by what the user needs to do', () => {
    expect(statusTone('inProgress')).toBe('accent')
    expect(statusTone('needsInput')).toBe('warn')
    expect(statusTone('failed')).toBe('danger')
    expect(statusTone('completed')).toBe('muted')
  })
})
