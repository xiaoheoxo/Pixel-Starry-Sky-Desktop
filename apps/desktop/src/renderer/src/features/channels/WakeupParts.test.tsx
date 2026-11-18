// 卡上挂着的唤醒（docs/multica-learn.md §11.6）：一行一条、本机频道能取消、失效的写原因
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/i18n/I18nProvider'

// 频道 store 一加载就要 window（预加载桥）：这里只看渲染；useChannels 只用来取「我是谁」（团队卡上谁能取消、同意）
const mocked = vi.hoisted(() => ({ self: undefined as string | undefined }))
vi.mock('./store', () => ({ channelActions: {}, useChannels: () => mocked.self, selfIdIn: () => null }))
import type { Channel, ChannelMember } from '@/data/types'
import type { ChannelWakeup } from '../../../../shared/types/channels'
import { WakeupRules } from './WakeupParts'

const NOW = Date.now()
const members = new Map<string, ChannelMember>([['a1', { id: 'a1', kind: 'agent', name: '小A' } as ChannelMember]])
const rule = (patch: Partial<ChannelWakeup> = {}): ChannelWakeup => ({
  id: 'w1',
  on: 't1',
  memberId: 'a1',
  card: null,
  by: 'you',
  when: { kind: 'every', freq: 'daily', hour: 9, minute: 0 },
  text: '检查 CI',
  until: NOW + 3 * 86_400_000,
  next: NOW + 3_600_000,
  fired: 0,
  state: 'active',
  createdAt: NOW - 60_000,
  ...patch,
})
const channel = (patch: Partial<Channel>): Channel =>
  ({ id: 'c1', name: '频道', scope: 'local', memberIds: ['a1'], createdAt: 0, ...patch }) as Channel
const render = (c: Channel) =>
  renderToStaticMarkup(
    <I18nProvider>
      <WakeupRules channel={c} on="t1" membersById={members} />
    </I18nProvider>,
  )

describe('WakeupRules', () => {
  it('本机频道：写叫谁、做什么、下次和截止，带取消按钮', () => {
    const html = render(channel({ wakeups: [rule()] }))
    expect(html).toContain('每天 09:00 叫 小A')
    expect(html).toContain('检查 CI')
    expect(html).toContain('下次 ')
    expect(html).toContain('截止 ')
    expect(html).toContain('aria-label="取消这条唤醒"')
  })

  it('团队频道里认不出我是谁（不是挂的人、也不是主人）、归档的频道：只读，不给取消', () => {
    expect(render(channel({ scope: 'team', wakeups: [rule()] }))).not.toContain('取消这条唤醒')
    expect(render(channel({ archivedAt: NOW, wakeups: [rule()] }))).not.toContain('取消这条唤醒')
  })

  it('团队卡：等同意的写「等 X 同意」；主人有「同意」、× 是不同意；挂的人只能取消；别人只读', () => {
    const people = new Map<string, ChannelMember>([
      ...members,
      ['u:1', { id: 'u:1', kind: 'human', name: '林夏' } as ChannelMember],
      ['u:2', { id: 'u:2', kind: 'human', name: '周宁' } as ChannelMember],
    ])
    const c = channel({
      scope: 'team',
      memberIds: ['a1', 'u:1', 'u:2'],
      wakeups: [rule({ state: 'pending', owner: 'u:2', by: 'u:1' })],
    })
    const as = (self: string) => {
      mocked.self = self
      return renderToStaticMarkup(
        <I18nProvider>
          <WakeupRules channel={c} on="t1" membersById={people} />
        </I18nProvider>,
      )
    }
    try {
      const owner = as('u:2')
      expect(owner).toContain('等 周宁 同意')
      expect(owner).toContain('林夏 挂的')
      expect(owner).toMatch(/>同意</)
      expect(owner).toContain('aria-label="不同意这条唤醒"')
      const creator = as('u:1')
      expect(creator).toContain('aria-label="取消这条唤醒"')
      expect(creator).not.toMatch(/>同意</)
      expect(creator).not.toContain('林夏 挂的')
      const other = as('u:3')
      expect(other).toContain('等 周宁 同意')
      expect(other).not.toContain('aria-label=')
    } finally {
      mocked.self = undefined
    }
  })

  it('没有活着的：最近失效取消的写原因，自己点掉的、没有规则的不写', () => {
    const gone = rule({ state: 'cancelled', endNote: '盯的卡停了', lastAt: NOW - 60_000 })
    expect(render(channel({ wakeups: [gone] }))).toContain('唤醒已取消：盯的卡停了')
    expect(render(channel({ wakeups: [{ ...gone, endNote: null }] }))).toBe('')
    expect(render(channel({ wakeups: [] }))).toBe('')
  })
})
