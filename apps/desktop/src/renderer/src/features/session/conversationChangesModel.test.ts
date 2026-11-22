import { describe, expect, it } from 'vitest'
import type { FileChange, Item } from '@pixelsky/protocol'
import { conversationChanges } from './conversationChangesModel'

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

describe('conversationChanges', () => {
  it('aggregates completed edits across turns by file and preserves the recorded patches in order', () => {
    const data = conversationChanges(
      [
        edit('one', 'completed', patch('/proj/src/file.ts', 3, 1, '+first')),
        { kind: 'user', id: 'prompt', text: 'continue', createdAt: 1 },
        edit('two', 'completed', patch('./src/file.ts', 1, 2, '+second'), patch('README.md')),
      ],
      '/proj',
    )
    expect(data).toEqual({
      added: 4,
      removed: 3,
      files: [
        { dir: 'src/', name: 'file.ts', added: 4, removed: 3, diffs: ['+first', '+second'] },
        { dir: '', name: 'README.md', added: 0, removed: 0 },
      ],
    })
  })

  it('does not report pending or unsuccessful edits', () => {
    expect(
      conversationChanges(
        [
          edit('a', 'running', patch('a')),
          edit('b', 'failed', patch('b')),
          edit('c', 'declined', patch('c')),
          edit('d', 'interrupted', patch('d')),
        ],
        null,
      ),
    ).toBeNull()
  })

  it('uses the conversation path syntax when combining Windows edits', () => {
    const data = conversationChanges(
      [edit('a', 'completed', patch('c:\\Project\\src\\File.ts', 2), patch('.\\SRC\\file.ts', 3))],
      'C:\\project',
    )
    expect(data?.files).toEqual([{ dir: 'src/', name: 'File.ts', added: 5, removed: 0 }])
  })
})
