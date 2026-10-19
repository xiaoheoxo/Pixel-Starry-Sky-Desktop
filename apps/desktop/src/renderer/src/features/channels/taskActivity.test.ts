import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  ;(globalThis as { window?: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
})
import type { ChannelActivity } from '../../../../shared/types/channels'
import { activityTooltip } from '@/features/session/live/agentActivity'
import { taskActivity } from './taskActivity'

// 进行中的任务卡「正在做什么」（docs/ui/channels-local-ai.md §3.1 #2）

const steps: ChannelActivity['steps'] = [
  { id: 'c1', at: 1000, running: false, kind: 'command', command: 'pnpm test', description: '运行单元测试' },
  { id: 't1', at: 2000, running: false, kind: 'tool', tool: 'read', name: 'Read', title: 'src/a.ts' },
  {
    id: 'f1',
    at: 3000,
    running: true,
    kind: 'file_change',
    changes: [{ kind: 'update', path: 'src/settings/Form.tsx' }],
  },
]

describe('taskActivity', () => {
  it('只有进行中才有；没有活动时没有', () => {
    expect(taskActivity({ status: 'waiting', activity: { steps, say: null } })).toBeNull()
    expect(taskActivity({ status: 'done', activity: { steps, say: null } })).toBeNull()
    expect(taskActivity({ status: 'running', activity: null })).toBeNull()
    expect(taskActivity({ status: 'running', activity: { steps: [], say: null } })).toBeNull()
  })
  it('写最近一步（和对话里工具行的说法一样），记下第一次看到的时间', () => {
    const a = taskActivity({ status: 'running', activity: { steps, say: null } })!
    expect(a.line).toMatchObject({ kind: 'step', stepId: 'f1' })
    expect(a.line.text).toContain('Form.tsx')
    expect(a.seen('f1')).toBe(3000)
  })
  it('AI 最近说的一句比最近一步新：写那一句；旧的话不盖过新的一步', () => {
    const newer = taskActivity({
      status: 'running',
      activity: { steps, say: { text: '测试过了，接着改表单。', at: 3500 } },
    })!
    expect(newer.line).toMatchObject({ kind: 'summary', text: '测试过了，接着改表单。' })
    const older = taskActivity({ status: 'running', activity: { steps, say: { text: '先看看', at: 1500 } } })!
    expect(older.line.kind).toBe('step')
    expect(
      taskActivity({ status: 'running', activity: { steps: [], say: { text: '先看看', at: 1 } } })!.line.text,
    ).toBe('先看看')
  })
  it('悬停：完整的一句，下面列最近 3 步（最新的在上，带几秒前）', () => {
    const a = taskActivity({ status: 'running', activity: { steps, say: null } })!
    const tip = activityTooltip(a.line, a.steps, a.seen, 13_000).split('\n')
    expect(tip.length).toBe(5)
    expect(tip[2]).toContain('Form.tsx')
    expect(tip[4]).toContain('pnpm test') // 悬停写完整命令（不是说明）
    expect(tip[4]).toContain('12')
  })
})
