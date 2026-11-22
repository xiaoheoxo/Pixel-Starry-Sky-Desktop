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
  it('shows real conversation tasks when the optional activity list is missing', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DotProfilePanel
          entry={entry}
          overview={{ profile: entry, activity: null, tasks: null, environment: null, errors: [] }}
          outputs={[]}
          workflows={Array.from({ length: 6 }, (_, i) => ({
            id: `w${i}`,
            name: `真实任务 ${i}`,
            description: '',
            status: 'completed',
            startedAt: i,
            durationMs: 1,
            tokens: 0,
            toolCalls: 0,
            phases: [],
            agents: [],
            toolUseId: null,
          }))}
        />
      </I18nProvider>,
    )
    expect(html).toContain('真实任务 5')
    expect(html).toContain('真实任务 0')
    expect(html).toContain('<details')
    expect(html).not.toContain('近期活动暂不可用')
  })

  it('separates recent scheduled activity from conversation tasks and shows errors instead of empty results', () => {
    const overview = { profile: entry, activity: [], tasks: [], environment: null, errors: [] }
    const render = (feed: Partial<import('@pixelsky/engine').DotOverview>) =>
      renderToStaticMarkup(
        <I18nProvider>
          <DotProfilePanel entry={entry} overview={{ ...overview, ...feed }} outputs={[]} />
        </I18nProvider>,
      )
    expect(render({ scheduledActivity: [{ id: 'a', title: 'CI monitor', status: 'paused' }] })).toContain('CI monitor')
    expect(render({ scheduledActivity: null, scheduledActivityError: 'Dot HTTP 403' })).toContain(
      '暂时无法获取定时任务',
    )
    expect(render({ scheduledActivity: [] })).toContain('没有定时任务')
    expect(
      renderToStaticMarkup(
        <I18nProvider>
          <DotProfilePanel entry={entry} outputs={[]} overviewLoading />
        </I18nProvider>,
      ),
    ).toContain('正在读取详情')
  })

  it('uses a live work title and keeps unanswered distinct from completed and scheduled work', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <DotProfilePanel
          entry={entry}
          outputs={[]}
          replyDisplay="unanswered"
          overview={{
            profile: entry,
            environment: null,
            tasks: [],
            errors: [],
            activity: [{ id: 'live', title: 'Verifying product version', status: 'in_progress' }],
            scheduledActivity: [{ id: 'scheduled', title: 'Daily build', status: 'active' }],
          }}
        />
      </I18nProvider>,
    )
    expect(html).toContain('Verifying product version')
    expect(html).toContain('暂未回复')
    expect(html).toContain('Daily build')
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
