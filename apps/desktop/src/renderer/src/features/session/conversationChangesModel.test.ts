import { describe, expect, it } from 'vitest'
import type { FileChange, Item } from '@pixelsky/protocol'
import { activeConversationChanges } from './conversationChangesModel'

const edit = (
  id: string,
  status: Extract<Item, { kind: 'file_change' }>['status'],
  ...changes: FileChange[]
): Item => ({ kind: 'file_change', id, status, changes })
const patch = (path: string, added = 0, removed = 0, diff = ''): FileChange => ({
  path,
  kind: 'update',
  diff,
  added,
  removed,
})
const user = (id: string): Extract<Item, { kind: 'user' }> => ({ kind: 'user', id, text: 'continue', createdAt: 1 })

describe('activeConversationChanges', () => {
  it('shows completed edits in this turn, including edits after guidance, without reusing prior turns', () => {
    const items = [
      user('old'),
      edit('one', 'completed', patch('/proj/old.ts', 20, 10)),
      user('current'),
      edit('two', 'completed', patch('/proj/src/file.ts', 3, 1, '+first')),
      { ...user('guide'), mode: 'guidance' } as Item,
      edit('three', 'completed', patch('./src/file.ts', 1, 2, '+second'), patch('README.md')),
    ]
    const data = activeConversationChanges(items, '/proj', true)
    expect(data).toMatchObject({
      turnKey: 'current',
      added: 4,
      removed: 3,
      files: [
        { path: 'src/file.ts', added: 4, removed: 3, diffs: ['+first', '+second'] },
        { path: 'README.md', added: 0, removed: 0 },
      ],
    })
    expect(activeConversationChanges(items, '/proj', false)).toBeNull()
    expect(activeConversationChanges([...items, user('next')], '/proj', true)).toBeNull()
  })

  it('does not report pending, unsuccessful, or empty edits', () => {
    expect(
      activeConversationChanges(
        [
          edit('a', 'running', patch('a')),
          edit('b', 'failed', patch('b')),
          edit('c', 'declined', patch('c')),
          edit('d', 'interrupted', patch('d')),
          edit('e', 'completed'),
        ],
        null,
        true,
      ),
    ).toBeNull()
  })

  it('combines Windows paths using the session path syntax', () => {
    const data = activeConversationChanges(
      [edit('a', 'completed', patch('c:\\Project\\src\\File.ts', 2), patch('.\\SRC\\file.ts', 3))],
      'C:\\project',
      true,
    )
    expect(data?.files).toMatchObject([{ path: 'src/File.ts', added: 5, removed: 0 }])
  })
})

it('combines edits for the total and preserves ownership when two agents edit the same file', () => {
  const call = (id: string): Item => ({
    kind: 'tool',
    id,
    tool: 'task',
    name: 'spawn_agent',
    title: id,
    output: '',
    status: 'completed',
  })
  const agent = (id: string, added: number) => ({
    id,
    label: id,
    type: 'Codex',
    model: 'model',
    state: 'running',
    startedAt: 0,
    durationMs: 0,
    tokens: 0,
    toolCalls: 0,
    phase: null,
    prompt: '',
    result: '',
    toolUseId: id,
    fileChanges: [{ path: '/proj/a.ts', kind: 'update' as const, added, removed: 0 }],
  })
  const data = activeConversationChanges(
    [
      user('old'),
      call('old-agent'),
      user('current'),
      call('layout'),
      call('verify'),
      edit('main', 'completed', patch('a.ts', 1)),
    ],
    '/proj',
    true,
    [agent('old-agent', 100), agent('layout', 5), agent('verify', 6)],
  )
  expect(data).toMatchObject({
    added: 12,
    files: [{ path: 'a.ts', added: 12 }],
    groups: [
      { label: null, files: [{ added: 1 }] },
      { label: 'layout', files: [{ added: 5 }] },
      { label: 'verify', files: [{ added: 6 }] },
    ],
  })
})
