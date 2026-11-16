import { describe, expect, it } from 'vitest'
import {
  tuiActive,
  tuiBlockKey,
  tuiConfirm,
  tuiDisabledReason,
  tuiModeOf,
  tuiNeedsNode,
  tuiToggleVisible,
} from './tuiMode'
import type { SessionRecord, SessionSnapshot } from '@pixelsky/protocol'

function snap(partial: Partial<SessionRecord> & Pick<SessionRecord, 'engine'>): SessionSnapshot {
  const record = {
    id: 's1',
    projectId: 'p',
    cwd: '/tmp',
    engineSessionId: 'eng-1',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    lastOutcome: null,
    model: null,
    effort: null,
    permissionMode: 'ask' as const,
    ultracode: false,
    fast: false,
    thinkingSummaries: false,
    ...partial,
  }
  return {
    record,
    items: [],
    state: 'idle',
    queue: [],
    pending: [],
    tasks: [],
    subagents: [],
    runs: null,
    queuePaused: false,
  } as unknown as SessionSnapshot
}

describe('tuiMode helpers', () => {
  it('treats tui marker as active even with empty terminalId', () => {
    const record = snap({ engine: 'claude', tui: { terminalId: '', since: 1 } }).record
    expect(tuiActive(record)).toBe(true)
    expect(tuiModeOf(record)).toBe('terminal')
  })

  it('does not gray when already in tui mode', () => {
    expect(tuiDisabledReason(snap({ engine: 'claude', tui: { terminalId: 't1', since: 1 } }))).toBeNull()
  })

  it('does not gray pending rewind/fork (prepareTui flushes)', () => {
    expect(tuiDisabledReason(snap({ engine: 'claude', pendingRewind: 'u1' }))).toBeNull()
    expect(tuiDisabledReason(snap({ engine: 'claude', pendingFork: { from: 'a', at: 'b' } }))).toBeNull()
  })

  it('shows toggle for claude/codex/antigravity/pixel', () => {
    expect(tuiToggleVisible(snap({ engine: 'claude' }).record)).toBe(true)
    expect(tuiToggleVisible(snap({ engine: 'codex' }).record)).toBe(true)
    expect(tuiToggleVisible(snap({ engine: 'antigravity' }).record)).toBe(true)
    expect(tuiToggleVisible(snap({ engine: 'pixel' }).record)).toBe(true)
    expect(tuiToggleVisible(null)).toBe(false)
  })

  it('Antigravity：新对话也能切（切之前在后台建会话），不像 Codex 那样要先发一条', () => {
    expect(tuiDisabledReason(snap({ engine: 'antigravity', engineSessionId: null }))).toBeNull()
    expect(tuiDisabledReason(snap({ engine: 'antigravity', engineSessionId: 'conv-1' }))).toBeNull()
  })

  it('Pixel：新对话也能切；找不到 Node 是提示（noNode），不灰掉', () => {
    expect(tuiDisabledReason(snap({ engine: 'pixel', engineSessionId: null }))).toBeNull()
    expect(tuiBlockKey('noNode')).toBeNull()
    expect(tuiNeedsNode('noNode')).toBe(true)
    expect(tuiNeedsNode('busy')).toBe(false)
  })

  it('主进程的原因代码换成文字；不认识的当能切', () => {
    expect(tuiBlockKey('liveTerminal')).toBe('session.tui.disabledLiveTerminal')
    expect(tuiBlockKey('liveOther')).toBe('session.tui.disabledLiveOther')
    expect(tuiBlockKey('busy')).toBe('session.tui.disabledBusy')
    expect(tuiBlockKey('later-code')).toBeNull()
    expect(tuiBlockKey(null)).toBeNull()
  })

  it('Codex：有线程才能切；没聊过的新对话、待落实的回退 / 分叉灰掉（Codex 切之前落实不了）', () => {
    expect(tuiDisabledReason(snap({ engine: 'codex', engineSessionId: 'th-1' }))).toBeNull()
    expect(tuiDisabledReason(snap({ engine: 'codex', engineSessionId: null }))).toBe('session.tui.disabledFresh')
    expect(tuiDisabledReason(snap({ engine: 'codex', pendingRewind: 'u1' }))).toBe('session.tui.disabledFresh')
    expect(
      tuiDisabledReason(snap({ engine: 'codex', engineSessionId: null, pendingFork: { from: 'a', at: 'b' } })),
    ).toBe('session.tui.disabledFresh')
    expect(tuiBlockKey('fresh')).toBe('session.tui.disabledFresh')
  })

  it('后台子智能体还在跑时灰掉（切过去会把它们停掉）', () => {
    const s = snap({ engine: 'claude' })
    const running = { ...s, subagents: [{ id: 'a', name: '甲', status: 'running', background: true }] }
    expect(tuiDisabledReason(running as unknown as typeof s)).toBe('session.tui.disabledBusy')
  })
})

describe('tuiConfirm', () => {
  it('回归：顶栏那份 hook 碰到 tui.running 设的确认，对话区那份也收得到（原来各存一份，顶栏开关点了没反应）', () => {
    let heard = 0
    const stop = tuiConfirm.subscribe(() => heard++)
    tuiConfirm.set('s1', true)
    expect(tuiConfirm.has('s1')).toBe(true)
    expect(tuiConfirm.has('s2')).toBe(false)
    tuiConfirm.set('s1', true)
    expect(heard).toBe(1)
    tuiConfirm.set('s1', false)
    expect(tuiConfirm.has('s1')).toBe(false)
    expect(heard).toBe(2)
    stop()
  })
})
