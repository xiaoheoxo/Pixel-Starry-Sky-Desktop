import { describe, expect, it } from 'vitest'
import type { ChannelMessage } from '../types/channels'
import { awaitsDecision, channelNeeds } from './needs'
import { alertRulesOf, cleanAlertRules, cleanDigestHour, dangerousCommand } from './alerts'

const task = (id: string, patch: Record<string, unknown>): ChannelMessage =>
  ({
    kind: 'task',
    id,
    channelId: 'c',
    at: 10,
    authorId: 'you',
    assigneeId: 'a',
    title: id,
    status: 'running',
    sessionId: `s-${id}`,
    ...patch,
  }) as ChannelMessage
const msg = (id: string, at: number, patch: Record<string, unknown>): ChannelMessage =>
  ({ kind: 'message', id, channelId: 'c', at, authorId: 'you', text: id, format: 'plain', ...patch }) as ChannelMessage

describe('「需要你」（docs/ui/channels-collab-v2.md §2）', () => {
  const request = { requestId: 'r1', itemId: null, kind: 'command', title: '运行命令', command: 'ls', alwaysScopes: [] }
  const list: ChannelMessage[] = [
    task('wait', { status: 'waiting', request }),
    task('held', { status: 'queued', relay: { chain: 'x', hop: 3, held: 'hops' } }),
    task('fail', { status: 'failed', error: '额度不足', endedAt: 20, round: 2 }),
    task('decide', { status: 'done', decision: '删旧组件吗？', endedAt: 30 }),
    task('answered', { status: 'done', decision: '要不要发版？', endedAt: 30 }),
    msg('reply', 40, { replyToId: 'answered' }),
    task('checks', {
      status: 'done',
      endedAt: 50,
      checks: {
        id: 'k1',
        at: 50,
        status: 'done',
        items: [
          { kind: 'command', label: 'test', command: 'pnpm test', status: 'fail', exitCode: 1, ms: 1, output: '' },
        ],
      },
    }),
    task('run', { status: 'running' }),
    task('queue', { status: 'queued' }),
    msg('p', 60, { authorId: 'a', proposal: { assigneeId: 'b', request: '写文档', state: 'open' } }),
    msg('p2', 61, { authorId: 'a', proposal: { assigneeId: 'b', request: '写文档', state: 'sent' } }),
    msg('al', 70, { authorId: 'system', text: '等太久了', alert: { rule: 'waiting', state: 'open', taskId: 'wait' } }),
  ]

  it('等你确认、接力停下、失败、要你决定（回过的不算）、检查没过、提议、提醒；新的在前', () => {
    const { needs } = channelNeeds([{ id: 'c' }], new Map([['c', list]]), 'you')
    expect(needs.map(n => n.key)).toEqual([
      'alert:al',
      'proposal:p',
      'checks:checks',
      'decision:decide',
      'failed:fail',
      'approval:wait',
      'held:held',
    ])
    expect(needs.find(n => n.kind === 'approval')).toMatchObject({ sig: 'r1', sessionId: 's-wait', request })
    expect(needs.find(n => n.kind === 'alert')).toMatchObject({ rule: 'waiting', sessionId: 's-wait' })
    expect(needs.find(n => n.kind === 'failed')).toMatchObject({ sig: '2', detail: '额度不足' })
    expect(needs.find(n => n.kind === 'checks')).toMatchObject({ sig: 'k1', detail: 'test', findings: 0 })
    expect(needs.find(n => n.kind === 'proposal')).toMatchObject({ memberId: 'b', text: '写文档' })
  })

  it('跟进中是还在排队 / 运行的活（停下的接力和等你确认的不算）；归档的频道不算', () => {
    const { following } = channelNeeds([{ id: 'c' }], new Map([['c', list]]), 'you')
    expect(following.map(f => f.taskId).sort()).toEqual(['queue', 'run'])
    expect(channelNeeds([{ id: 'c', archivedAt: 1 }], new Map([['c', list]]), 'you').needs).toEqual([])
  })

  it('标为已处理（§2.1）：sig 没变的进 done，变了重新出现；会话还在的「要你确认」标不掉', () => {
    const marks = { 'failed:fail': '2', 'checks:checks': 'old', 'approval:wait': 'r1' }
    const { needs, done } = channelNeeds([{ id: 'c', needsDone: marks }], new Map([['c', list]]), 'you')
    expect(done.map(n => n.key)).toEqual(['failed:fail'])
    expect(needs.map(n => n.key)).toContain('checks:checks')
    expect(needs.map(n => n.key)).toContain('approval:wait')
  })

  it('事项唤醒回 [silent] 的几轮不让处理过的「要你决定」重新冒出来：按提出它的那一轮算（§11.6）', () => {
    const wake = { ruleId: 'r', kind: 'every' }
    const runs = [
      { n: 2, status: 'done', startedAt: 1, endedAt: 30, wakeup: wake },
      { n: 3, status: 'failed', startedAt: 40, endedAt: 50, wakeup: wake },
      { n: 5, status: 'done', startedAt: 60, endedAt: 90, wakeup: { ...wake, silent: 2 } },
    ]
    const card = (id: string) => task(id, { status: 'done', decision: '要不要回滚？', round: 5, endedAt: 90, runs })
    const cards = [card('replied'), msg('r', 35, { replyToId: 'replied' }), card('marked'), card('open')]
    const { needs, done } = channelNeeds(
      [{ id: 'c', needsDone: { 'decision:marked': '2' } }],
      new Map([['c', cards]]),
      'you',
    )
    expect(done.map(n => n.key)).toEqual(['decision:marked'])
    expect(needs.map(n => [n.key, n.sig, n.at])).toEqual([['decision:open', '2', 30]])
  })

  it('找不到目标的带上原因；这时「要你确认」也能标为已处理', () => {
    const gone = (n: { kind: string }) => (n.kind === 'approval' ? 'session' : n.kind === 'failed' ? 'member' : null)
    const { needs, done } = channelNeeds(
      [{ id: 'c', needsDone: { 'approval:wait': 'r1' } }],
      new Map([['c', list]]),
      'you',
      gone,
    )
    expect(done.map(n => [n.key, n.gone])).toEqual([['approval:wait', 'session']])
    expect(needs.find(n => n.key === 'failed:fail')?.gone).toBe('member')
    expect(needs.find(n => n.key === 'held:held')?.gone).toBeUndefined()
  })
})

describe('主动提醒的规则（§6）', () => {
  it('会丢改动的 git 命令', () => {
    for (const c of [
      'git checkout -- src/a.ts',
      'git checkout main',
      'git -C x reset --hard HEAD',
      'git clean -fd',
      'git stash',
      'git restore .',
    ])
      expect(dangerousCommand(c)).toBe(true)
    for (const c of ['git status', 'git stash list', 'git reset HEAD a.ts', 'git clean -n', 'git switch main', 'ls'])
      expect(dangerousCommand(c)).toBe(false)
  })
  it('没设过按默认；乱写的丢掉；简报钟点 0–23', () => {
    expect(alertRulesOf({})).toEqual({ conflict: true, waiting: true, stalled: true, unclaimed: false, digest: false })
    expect(cleanAlertRules({ digest: true, nope: true, waiting: 'yes' })).toEqual({ digest: true })
    expect(cleanDigestHour(23)).toBe(23)
    expect(cleanDigestHour(24)).toBe(9)
  })
})

describe('卡片在等你决定（docs/ui/channels-collab-v2.md §3.1）', () => {
  it('做完、带要你决定、之后你没在串里说过话才算；主进程和「需要你」用的同一份', () => {
    const card = task('d', { status: 'done', decision: '默认勾上吗？', endedAt: 30 }) as Extract<
      ChannelMessage,
      { kind: 'task' }
    >
    expect(awaitsDecision([card], card, 'you')).toBe(true)
    // 串里说过话（不 @ 也算）、引用过卡片：回过了
    expect(awaitsDecision([card, msg('t', 40, { threadId: 'd' })], card, 'you')).toBe(false)
    expect(awaitsDecision([card, msg('q', 40, { replyToId: 'd' })], card, 'you')).toBe(false)
    // 提出之前说的不算；别人说的不算
    expect(awaitsDecision([card, msg('old', 20, { threadId: 'd' })], card, 'you')).toBe(true)
    expect(awaitsDecision([card, msg('o', 40, { threadId: 'd', authorId: 'a' })], card, 'you')).toBe(true)
    // 没在等：还在做、没有要你决定的事
    const running = { ...card, status: 'running' as const }
    expect(awaitsDecision([running], running, 'you')).toBe(false)
    const plain = { ...card, decision: null }
    expect(awaitsDecision([plain], plain, 'you')).toBe(false)
  })
})
