// 团队频道里给自己的 AI 成员换头像：界面上的成员 id 是团队成员 id，保存要用 config 里的本机成员 id（审查 2026-11-12）
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/data', () => ({
  isDemo: false,
  channels: [],
  channelMembers: [],
  channelMessages: {},
  channelTeams: [],
}))

const config = {
  id: 'a-local',
  name: '前端助手',
  engine: 'claude',
  projectId: 'p1',
  machineId: 'local',
  createdAt: 1,
  sharedSessionId: 's1',
}
const snapshot = {
  self: { id: 'me', kind: 'human', name: '我', you: true },
  channels: [],
  // 团队频道里自己的成员：id 是团队成员 id，config 是本机那份
  members: [{ id: 'ta-1', kind: 'agent', name: '前端助手', engine: 'claude', status: 'idle', mine: true, config }],
  sessionChannels: {},
}
const saveMember = vi.fn((_channelId: string | null, _input: Record<string, unknown>) => Promise.resolve('a-local'))
vi.stubGlobal('window', {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  pixelsky: {
    channels: new Proxy({ state: () => Promise.resolve(snapshot), saveMember } as Record<string, unknown>, {
      get: (target, key: string) =>
        target[key] ?? (key.startsWith('on') ? () => () => {} : () => new Promise(() => {})),
    }),
  },
})

const { channelActions, getChannels } = await import('./store')

describe('换头像', () => {
  it('团队频道里自己的成员：按本机成员 id 保存，不带只读字段', async () => {
    await vi.waitFor(() => expect(getChannels().members).toHaveLength(1))
    const avatar = { style: 'letter', color: 'blue' } as const
    await channelActions.setAvatar('ta-1', avatar)
    expect(saveMember).toHaveBeenCalledTimes(1)
    const [channelId, input] = saveMember.mock.calls[0]
    expect(channelId).toBeNull()
    expect(input).toEqual({ id: 'a-local', name: '前端助手', engine: 'claude', projectId: 'p1', avatar })
  })
})
