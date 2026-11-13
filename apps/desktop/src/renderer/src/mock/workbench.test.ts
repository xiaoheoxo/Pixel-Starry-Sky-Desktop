// 工作台原来的演示会话（docs/ui/demo-conversation.md §8）：每个会话都有快照，和演示里别处对得上
import { describe, expect, it } from 'vitest'
import { demoArtifacts } from './artifacts'
import { demo } from './demo'
import { demoInbox } from './inbox'
import { demoSearchItems } from './search'
import { workbenchSnapshots } from './workbench'

describe('工作台演示会话', () => {
  it('侧栏、已归档、置顶、最近任务里的会话都有快照，引擎都是 Claude', () => {
    const ids = [
      ...demo.projects.flatMap(p => [...p.sessions, ...(p.archived ?? [])].map(s => s.id)),
      ...demo.pinned.filter(p => p.kind === 'session').map(p => p.id),
      ...demo.recent.map(r => r.id),
    ].filter(id => !id.startsWith('demo-claude-') && !id.startsWith('demo-coding-') && !id.startsWith('demo-codex-'))
    expect(ids.length).toBeGreaterThan(5)
    for (const id of ids) {
      expect(workbenchSnapshots[id], id).toBeDefined()
      expect(workbenchSnapshots[id].record.engine, id).toBe('claude')
    }
  })

  it('全局搜索演示结果的条目在「hhh」里', () => {
    const own = new Set(workbenchSnapshots[demo.defaultSessionId!].items.map(i => i.id))
    for (const item of demoSearchItems) expect(own.has(item.id), item.id).toBe(true)
  })

  it('任务 › 待处理三条和会话状态一致', () => {
    for (const entry of demoInbox) {
      const snap = workbenchSnapshots[entry.sessionId]
      if (entry.lane === 'waiting') {
        expect(snap.state).toBe('waiting')
        expect(snap.pending.map(p => [p.requestId, p.command])).toEqual([
          [entry.request!.requestId, entry.request!.command],
        ])
      } else if (entry.lane === 'failed') {
        expect(snap.record.lastOutcome).toBe('failed')
        expect(snap.items.some(i => i.kind === 'notice' && i.text === entry.error)).toBe(true)
      } else {
        expect(snap.queuePaused).toBe(true)
        expect(snap.queue.filter(q => q.status === 'queued')).toHaveLength(entry.queue!.queued)
      }
    }
  })

  it('产物面板的轮次、文件、交付条目都在对话里，行数一致', () => {
    for (const turn of demoArtifacts.turns) {
      const snap = workbenchSnapshots[turn.sessionId]
      const user = snap.items.find(i => i.id === turn.userItemId)
      expect(user?.kind === 'user' && user.text, turn.userItemId ?? undefined).toBe(turn.prompt)
      expect(snap.record.engine).toBe(turn.engine)
      for (const f of turn.files) {
        const item = snap.items.find(i => i.id === f.itemId)
        const change = item?.kind === 'file_change' ? item.changes.find(c => c.path === f.path) : undefined
        expect([change?.kind, change?.added, change?.removed], f.path).toEqual([f.kind, f.added, f.removed])
      }
    }
    for (const d of demoArtifacts.delivered)
      expect(
        workbenchSnapshots[d.sessionId].items.some(i => i.id === d.itemId),
        d.itemId,
      ).toBe(true)
  })
})
