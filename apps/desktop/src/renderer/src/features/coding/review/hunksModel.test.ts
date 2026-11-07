import { describe, expect, it } from 'vitest'
import { ChangeSet, Text } from '@codemirror/state'
import { baselineFor, hunkKey, parseDiffBody, reverseApply, reviewHunks, turnBaseline } from './hunksModel'

// 复制自 mock/coding.ts 的 before / after 和 unifiedDiff（测试里不能 import mock，评审 b-17）
const HEADER_BEFORE = [
  "import { useSession } from '@/features/engine'",
  "import { Pin } from 'lucide-react'",
  '',
  'export function SessionHeader({ id }: { id: string }) {',
  '  const session = useSession(id)',
  "  const title = session?.record.title ?? ''",
  "  const machine = '本机'",
  '',
  '  return (',
  '    <header className="flex h-10 items-center gap-2 px-3">',
  '      <h1 className="truncate text-sm">{title}</h1>',
  '      <span className="text-xs text-fg-muted">{machine}</span>',
  '      <Pin size={14} />',
  '    </header>',
  '  )',
  '}',
  '',
  'function useCwd(id: string): string {',
  '  const session = useSession(id)',
  "  return session?.record.cwd ?? ''",
  '}',
  '',
  'export function SessionSubtitle({ id }: { id: string }) {',
  '  const cwd = useCwd(id)',
  '',
  '  return <p className="truncate text-xs text-fg-muted">{cwd}</p>',
  '}',
  '',
].join('\n')

const HEADER_AFTER = [
  "import { useSession } from '@/features/engine'",
  "import { MachineSwitch } from '@/machines/MachineSwitch'",
  "import { Pin } from 'lucide-react'",
  '',
  'export function SessionHeader({ id }: { id: string }) {',
  '  const session = useSession(id)',
  "  const title = session?.record.title ?? ''",
  '',
  '  return (',
  '    <header className="flex h-10 items-center gap-2 px-3">',
  '      <h1 className="truncate text-sm">{title}</h1>',
  '      <MachineSwitch />',
  '      <Pin size={14} />',
  '    </header>',
  '  )',
  '}',
  '',
  'function useCwd(id: string): string {',
  '  const session = useSession(id)',
  "  return session?.record.cwd ?? ''",
  '}',
  '',
  'export function SessionSubtitle({ id }: { id: string }) {',
  '  const cwd = useCwd(id)',
  '  const branch = useSession(id)?.record.projectId',
  '',
  '  return (',
  '    <p className="truncate text-xs text-fg-muted">',
  '      {cwd}',
  "      {branch ? ` · ${branch}` : ''}",
  '    </p>',
  '  )',
  '}',
  '',
].join('\n')

const toLines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))
type Op = { t: ' ' | '+' | '-'; text: string }
function editScript(a: string[], b: string[]): Op[] {
  const n = a.length,
    m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
  const ops: Op[] = []
  let i = 0,
    j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', text: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) ops.push({ t: '-', text: a[i++] })
    else ops.push({ t: '+', text: b[j++] })
  }
  while (i < n) ops.push({ t: '-', text: a[i++] })
  while (j < m) ops.push({ t: '+', text: b[j++] })
  return ops
}
function unifiedDiff(before: string, after: string, context = 3): string[] {
  const ops = editScript(toLines(before), toLines(after))
  const changed = ops.map((op, i) => (op.t === ' ' ? -1 : i)).filter(i => i >= 0)
  if (!changed.length) return []
  const groups: Array<[number, number]> = []
  for (const i of changed) {
    const last = groups[groups.length - 1]
    if (last && i - last[1] <= context * 2 + 1) last[1] = i
    else groups.push([i, i])
  }
  const lines: string[] = []
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context),
      to = Math.min(ops.length - 1, last + context)
    const slice = ops.slice(from, to + 1)
    const before0 = ops.slice(0, from).filter(o => o.t !== '+').length,
      after0 = ops.slice(0, from).filter(o => o.t !== '-').length
    const oldCount = slice.filter(o => o.t !== '+').length,
      newCount = slice.filter(o => o.t !== '-').length
    const start = (base: number, count: number): number => (count === 0 ? base : base + 1)
    lines.push(`@@ -${start(before0, oldCount)},${oldCount} +${start(after0, newCount)},${newCount} @@`)
    for (const op of slice) lines.push(op.t + op.text)
  }
  return lines
}

const lines = (...l: string[]): string => l.join('\n')

describe('parseDiffBody', () => {
  it('解析带 @@ 的多块', () => {
    const hunks = parseDiffBody('@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10,1 +10,2 @@\n x\n+y')!
    expect(hunks).toHaveLength(2)
    expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 })
    expect(hunks[0].lines).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'c' },
    ])
    expect(hunks[1]).toMatchObject({ oldStart: 10, newStart: 10 })
  })
  it('跳过 Codex 的文件头', () => {
    const hunks = parseDiffBody('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b')!
    expect(hunks).toHaveLength(1)
    expect(hunks[0].lines).toEqual([
      { op: '-', text: 'a' },
      { op: '+', text: 'b' },
    ])
  })
  it('只有 --- / +++ 头也能跳过，文件头之后的 --- 行是删除的内容', () => {
    const hunks = parseDiffBody('--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n--- note\n keep')!
    expect(hunks[0].lines).toEqual([
      { op: '-', text: '-- note' },
      { op: ' ', text: 'keep' },
    ])
  })
  it('没有 @@ 的正文是位置未知的块', () => {
    const hunks = parseDiffBody('-old\n+new')!
    expect(hunks).toEqual([
      {
        oldStart: null,
        newStart: null,
        lines: [
          { op: '-', text: 'old' },
          { op: '+', text: 'new' },
        ],
      },
    ])
  })
  it('MultiEdit 拼起来的多段按间隔的上下文切块', () => {
    const body = lines('-a1', '+a2', ...'c1 c2 c3 c4 c5 c6 c7 c8'.split(' ').map(c => ` ${c}`), '-b1', '+b2')
    const hunks = parseDiffBody(body)!
    expect(hunks).toHaveLength(2)
    expect(hunks[0].lines.at(-1)).toEqual({ op: ' ', text: 'c3' })
    expect(hunks[1].lines[0]).toEqual({ op: ' ', text: 'c6' })
  })
  it('解析不了返回 null', () => {
    expect(parseDiffBody('')).toBeNull()
    expect(parseDiffBody('garbage')).toBeNull()
    expect(parseDiffBody(' only context')).toBeNull()
  })
})

describe('reverseApply', () => {
  it('单块', () => {
    const hunks = parseDiffBody('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')!
    expect(reverseApply('a\nB\nc', hunks)).toBe('a\nb\nc')
  })
  it('文件开头和结尾的块', () => {
    expect(reverseApply('X\na\nb', parseDiffBody('@@ -1,2 +1,3 @@\n+X\n a\n b')!)).toBe('a\nb')
    expect(reverseApply('a\nb\nY', parseDiffBody('@@ -1,2 +1,3 @@\n a\n b\n+Y')!)).toBe('a\nb')
  })
  it('多处匹配时取离 newStart 最近的', () => {
    const text = 'x\nB\ny\nx\nB\ny'
    const hunks = parseDiffBody('@@ -4,3 +4,3 @@\n x\n-b\n+B\n y')!
    expect(reverseApply(text, hunks)).toBe('x\nB\ny\nx\nb\ny')
  })
  it('newStart 为 null 时匹配不唯一就失败', () => {
    expect(reverseApply('x\nB\ny\nx\nB\ny', parseDiffBody(' x\n-b\n+B\n y')!)).toBeNull()
    expect(reverseApply('x\nB\ny', parseDiffBody(' x\n-b\n+B\n y')!)).toBe('x\nb\ny')
  })
  it('上下文对不上返回 null', () => {
    expect(reverseApply('a\nB\nz', parseDiffBody('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')!)).toBeNull()
  })
  it('一个 diff 里多块从下往上应用', () => {
    const hunks = parseDiffBody('@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -9,2 +9,3 @@\n y\n+Z\n z')!
    expect(reverseApply('a\nB\nm\nn\no\np\nq\nr\ny\nZ\nz', hunks)).toBe('a\nb\nm\nn\no\np\nq\nr\ny\nz')
  })
  it('没有上下文也没有删除行时返回 null', () => {
    expect(reverseApply('a\nb', parseDiffBody('+a\n+b')!)).toBeNull()
  })
})

describe('turnBaseline', () => {
  it('往返：mock 的 before / after', () => {
    const diff = unifiedDiff(HEADER_BEFORE, HEADER_AFTER).join('\n')
    expect(turnBaseline(HEADER_AFTER, [diff], 'update', false)).toBe(HEADER_BEFORE)
  })
  it('CRLF 先统一成 \\n', () => {
    const diff = unifiedDiff(HEADER_BEFORE, HEADER_AFTER).join('\n')
    expect(turnBaseline(HEADER_AFTER.replaceAll('\n', '\r\n'), [diff], 'update', false)).toBe(HEADER_BEFORE)
  })
  it('同一个文件两次编辑，倒序还原', () => {
    const v0 = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n'
    const v1 = 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n'
    const v2 = 'a\nB\nc\nd\ne\nf\ng\nh\nI\nj\n'
    const d1 = unifiedDiff(v0, v1).join('\n'),
      d2 = unifiedDiff(v1, v2).join('\n')
    expect(turnBaseline(v2, [d1, d2], 'update', false)).toBe(v0)
  })
  it('Claude Edit / MultiEdit 没有 @@ 的正文', () => {
    const before = 'one\ntwo\nthree\nfour\nfive'
    const after = 'one\nTWO\nthree\nfour\nFIVE'
    // 两个 Edit 各自的 diffText，MultiEdit 拼在一起
    const diff = '-two\n+TWO\n-five\n+FIVE'
    expect(turnBaseline(after, [diff], 'update', false)).toBeNull() // 没有上下文，位置不唯一也无法确定
    const withCtx = ' one\n-two\n+TWO\n three\n four\n-five\n+FIVE'
    expect(turnBaseline(after, [withCtx], 'update', false)).toBe(before)
  })
  it('Codex 带文件头的 diff', () => {
    const diff = '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c'
    expect(turnBaseline('a\nB\nc', [diff], 'update', false)).toBe('a\nb\nc')
  })
  it('纯新增文件返回空串', () => {
    expect(turnBaseline('a\nb', ['+a\n+b'], 'add', true)).toBe('')
  })
  it('覆盖写入的 add（不是新文件）返回 null，不是空串', () => {
    expect(turnBaseline('a\nb', ['+a\n+b'], 'add', false)).toBeNull()
  })
  it('delete 返回 null；空 diff 返回 null；上下文对不上返回 null', () => {
    expect(turnBaseline('', ['-a'], 'delete', false)).toBeNull()
    expect(turnBaseline('a', [''], 'update', false)).toBeNull()
    expect(turnBaseline('a', [], 'update', false)).toBeNull()
    expect(turnBaseline('q\nr', ['@@ -1,2 +1,2 @@\n a\n-b\n+B'], 'update', false)).toBeNull()
  })
})

function applyUndo(baseline: string, current: string, pick: (i: number) => boolean = () => true): string {
  const doc = Text.of(current.split('\n'))
  const hunks = reviewHunks(baseline, current)
  const changes = hunks.filter((_, i) => pick(i)).map(h => ({ from: h.undoFrom, to: h.undoTo, insert: h.undoInsert }))
  return ChangeSet.of(changes, doc.length).apply(doc).toString()
}

describe('reviewHunks', () => {
  it('mock 的 SessionHeader 有两块以上，位置和文字对得上', () => {
    const hunks = reviewHunks(HEADER_BEFORE, HEADER_AFTER)
    expect(hunks.length).toBeGreaterThanOrEqual(2)
    const first = hunks[0]
    expect(first.currentText).toContain('MachineSwitch')
    expect(HEADER_AFTER.slice(first.fromB, first.toB)).toBe(first.currentText)
    expect(HEADER_BEFORE.slice(first.fromA, first.toA)).toBe(first.baselineText)
  })
  it('全部撤销得到基准；单块撤销只改这一块', () => {
    expect(applyUndo(HEADER_BEFORE, HEADER_AFTER)).toBe(HEADER_BEFORE)
    const partial = applyUndo(HEADER_BEFORE, HEADER_AFTER, i => i === 0)
    expect(partial).not.toBe(HEADER_BEFORE)
    expect(partial).not.toBe(HEADER_AFTER)
  })
  it('各种位置的纯增、纯删、替换，撤销都能还原', () => {
    const cases: Array<[string, string]> = [
      ['a\nb\nc', 'a\nb\nc\nd'],
      ['a\nb\nc\nd', 'a\nb\nc'],
      ['a\nb\nc', 'X\na\nb\nc'],
      ['X\na\nb\nc', 'a\nb\nc'],
      ['a\nb\nc\n', 'a\nb\nc\nd\n'],
      ['a\nb\nc\nd\n', 'a\nb\nc\n'],
      ['a\nb\nc', 'a\nQ\nc'],
      ['', 'a\nb'],
      ['a\nb', ''],
      ['a\nb\nc\nd\ne', 'a\nc\ne'],
      ['a\nc\ne', 'a\nb\nc\nd\ne'],
    ]
    for (const [baseline, current] of cases)
      expect(applyUndo(baseline, current), `${baseline} -> ${current}`).toBe(baseline)
  })
  it('随机文本：全部撤销一定回到基准', () => {
    let seed = 7
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const word = (): string => ['a', 'b', 'c', 'd', ''][rand(5)]
    const make = (): string => Array.from({ length: rand(8) }, word).join('\n') + (rand(2) ? '\n' : '')
    for (let i = 0; i < 300; i++) {
      const baseline = make(),
        current = make()
      expect(applyUndo(baseline, current), JSON.stringify([baseline, current])).toBe(baseline)
    }
  })
  it('完全相同没有块', () => {
    expect(reviewHunks('a\nb', 'a\nb')).toEqual([])
  })
  it('CRLF 统一后再比', () => {
    expect(reviewHunks('a\r\nb', 'a\nb')).toEqual([])
  })
  it('hunkKey 随内容变化', () => {
    expect(hunkKey('a', 'b')).toBe(hunkKey('a', 'b'))
    expect(hunkKey('a', 'b')).not.toBe(hunkKey('a', 'c'))
    expect(hunkKey('ab', '')).not.toBe(hunkKey('a', 'b'))
  })
})

describe('baselineFor', () => {
  const diffs = ['@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n']
  const file = { diffs, kind: 'update' as const }
  const afterAi = 'a\nB\nc\nd\ne\nf\ng\n'
  const start = 'a\nb\nc\nd\ne\nf\ng\n'

  it('用户保存后基准不变，diff 换了新数组也一样', () => {
    expect(baselineFor('s1', afterAi, 'v1', file, false)).toBe(start)
    const saved = afterAi.replace('f', 'USER')
    expect(baselineFor('s1', saved, 'v2', file, false)).toBe(start)
    expect(baselineFor('s1', saved, 'v3', { ...file, diffs: [...diffs] }, false)).toBe(start)
  })

  it('这一轮又改了同一个文件：重新算', () => {
    baselineFor('s2', afterAi, 'v1', file, false)
    const more = { ...file, diffs: [...diffs, '@@ -5,1 +5,1 @@\n-e\n+E\n'] }
    expect(baselineFor('s2', afterAi.replace('e', 'E'), 'v2', more, false)).toBe(start)
  })

  it('内容还没读到最新时倒推不出来：内容变了再算', () => {
    expect(baselineFor('s3', start, 'v0', file, false)).toBeNull()
    expect(baselineFor('s3', afterAi, 'v1', file, false)).toBe(start)
  })

  it('diff 读不出来时退回上一次的基准', () => {
    baselineFor('s4', afterAi, 'v1', file, false)
    expect(baselineFor('s4', start, 'v2', { ...file, diffs: [...diffs, ''] }, false)).toBe(start)
  })
})
