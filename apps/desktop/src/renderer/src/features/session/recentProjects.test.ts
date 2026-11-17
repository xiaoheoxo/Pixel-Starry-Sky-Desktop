import { describe, expect, it } from 'vitest'
import { recentProjects } from './recentProjects'

const s = (projectId: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  record: { projectId, updatedAt, ...extra },
})
const projects = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
  { id: 'd', name: 'D' },
  { id: 'e', name: 'E' },
  { id: 'ssh1:f', name: 'F' },
  { id: 'chat', name: '对话' },
]
const local = (id: string) => !id.includes(':')

describe('最近的项目', () => {
  it('按每个项目最近一次对话排，最多 4 个', () => {
    const r = recentProjects(projects, [s('a', 1), s('b', 5), s('a', 9), s('c', 3), s('d', 2), s('e', 4)], local)
    expect(r.map(p => p.id)).toEqual(['a', 'b', 'e', 'c'])
    expect(r[0]).toEqual({ id: 'a', name: 'A', at: 9 })
  })
  it('不算归档的、定时任务建的对话，「对话」、已移除的、别的机器上的项目', () => {
    const r = recentProjects(
      projects,
      [
        s('a', 10, { archivedAt: 11 }),
        s('b', 10, { scheduleTaskId: 't' }),
        s('chat', 20),
        s('gone', 30),
        s('ssh1:f', 40),
        s('c', 1),
      ],
      local,
    )
    expect(r.map(p => p.id)).toEqual(['c'])
  })
})
