import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '@/i18n/I18nProvider'
import { DotProfilePanel } from './DotProfilePanel'
import { dotPresence, presenceTone, statusTone } from './status'
import { dotFileKind } from './DotFile'
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
    // 头像旁写在不在线，没读到上次活动时间时不写「未获取」
    expect(html).toContain('在线')
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
  it('shows whether the Dot is there: online, paused, anything else offline', () => {
    expect(presenceTone('active')).toBe('on')
    expect(presenceTone('ready')).toBe('on')
    expect(presenceTone('paused')).toBe('paused')
    expect(presenceTone('unknown')).toBe('off')
    expect(presenceTone(undefined)).toBe('off')
    expect(dotPresence('active')).toBe('在线')
    expect(dotPresence('paused')).toBe('已暂停')
    expect(dotPresence('disconnected')).toBe('未连接')
    // 认不出的状态不把原文露给用户
    expect(dotPresence('unknown')).toBe('不在线')
  })
  it('labels a file card by its extension', () => {
    expect(dotFileKind('cdn-compare.xlsx')).toBe('XLSX')
    expect(dotFileKind('README')).toBe('附件')
  })
})
