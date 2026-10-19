import { describe, expect, it } from 'vitest'
import type { ProjectRecord, SessionSummary } from '@pixelsky/protocol'
import { currentProject } from './workspace'

const project = (id: string, name = id): ProjectRecord => ({ id, name, path: 'C:/' + id, addedAt: 1 })
const session = (
  id: string,
  projectId: string,
  updatedAt: number,
  state: SessionSummary['state'] = 'idle',
  archivedAt: number | null = null,
): SessionSummary =>
  ({ record: { id, projectId, title: id, updatedAt, archivedAt }, state }) as unknown as SessionSummary

const projects = [project('web', '网站'), project('app', '安卓'), project('empty', '空项目')]
const sessions = [
  session('old', 'web', 1),
  session('new', 'web', 5),
  session('asks', 'web', 2, 'waiting'),
  session('runs', 'app', 3, 'running'),
  session('gone', 'app', 9, 'idle', 8),
]

describe('currentProject', () => {
  it('prefers the open session, then the remembered project, then the latest activity', () => {
    expect(currentProject(projects, sessions, 'runs', 'web')?.id).toBe('app')
    expect(currentProject(projects, sessions, null, 'empty')?.id).toBe('empty')
    expect(currentProject(projects, sessions, null, 'deleted')?.id).toBe('web')
    expect(currentProject(projects, [], null, null)?.id).toBe('web')
    expect(currentProject([], [], null, null)).toBeNull()
  })
})
