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
