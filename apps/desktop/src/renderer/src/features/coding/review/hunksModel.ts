// 逐块审查的纯逻辑：解析 diff 正文、把一轮改动倒着应用得到「这一轮开始前」的内容、算出编辑器里每个改动块
// 不 import 任何界面或 store（node 环境可测）
import { Text } from '@codemirror/state'
import { Chunk } from '@codemirror/merge'
import type { TurnFile } from '../ai/turnChangesModel'

export interface DiffHunk {
  oldStart: number | null
  newStart: number | null
  lines: Array<{ op: ' ' | '-' | '+'; text: string }>
}

/** 没有 @@ 的正文按 git 的习惯切块：块前后各留这么多行上下文，间隔不超过 2 倍就并成一块 */
const CONTEXT = 3

const HEADER =
  /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) |Binary files )/
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

type BodyLine = { op: ' ' | '-' | '+'; text: string }

/** 评审 b-11：跳过文件头；没有 @@ 的正文拆成位置未知的块；完全解析不了时返回 null */
export function parseDiffBody(body: string): DiffHunk[] | null {
  if (!body) return null
  const raw = body.replace(/\r\n/g, '\n').split('\n')
  if (raw[raw.length - 1] === '') raw.pop()
  const hunks: DiffHunk[] = []
  const loose: BodyLine[] = []
  let current: DiffHunk | null = null
  let header = true
  for (const line of raw) {
    if (line.startsWith('\\')) continue // \ No newline at end of file
    if (line.startsWith('diff --git ')) {
      header = true
      current = null
      continue
    }
    if (header && HEADER.test(line)) continue
    const head = HUNK_HEAD.exec(line)
    if (head) {
      header = false
      current = { oldStart: Number(head[1]), newStart: Number(head[2]), lines: [] }
      hunks.push(current)
      continue
    }
    header = false
    const op = line.charAt(0)
    let entry: BodyLine
    if (op === ' ' || op === '-' || op === '+') entry = { op, text: line.slice(1) }
    else if (line === '') entry = { op: ' ', text: '' }
    else return null
    if (current) current.lines.push(entry)
    else if (!hunks.length) loose.push(entry)
    else return null
  }
  if (hunks.length) {
    if (loose.length) return null
    return hunks.some(h => h.lines.some(l => l.op !== ' ')) ? hunks : null
  }
  return splitLoose(loose)
}

function splitLoose(lines: readonly BodyLine[]): DiffHunk[] | null {
  const changes: number[] = []
  lines.forEach((l, i) => {
    if (l.op !== ' ') changes.push(i)
  })
  if (!changes.length) return null
  const ranges: Array<[number, number]> = []
  for (const index of changes) {
    const last = ranges[ranges.length - 1]
    if (last && index - last[1] - 1 <= CONTEXT * 2) last[1] = index
    else ranges.push([index, index])
  }
  return ranges.map(([first, last]) => ({
    oldStart: null,
    newStart: null,
    lines: lines.slice(Math.max(0, first - CONTEXT), Math.min(lines.length, last + CONTEXT + 1)).map(l => ({ ...l })),
  }))
}

/** 在 lines 里找 pattern 出现的所有起点 */
function findAll(lines: readonly string[], pattern: readonly string[]): number[] {
  const found: number[] = []
  const last = lines.length - pattern.length
  for (let i = 0; i <= last; i++) {
    let ok = true
    for (let j = 0; j < pattern.length; j++)
      if (lines[i + j] !== pattern[j]) {
        ok = false
        break
      }
    if (ok) found.push(i)
  }
  return found
}

/**
 * 把一次编辑倒回去：在 text 里找「上下文 + '+' 行」那一段，换成「上下文 + '-' 行」。
 * 有多处匹配时取离 newStart 最近的；newStart 为 null 时要求唯一匹配；hunk 从下往上应用；任何一块找不到就返回 null
 */
export function reverseApply(text: string, hunks: readonly DiffHunk[]): string | null {
  const lines = text.split('\n')
  for (let k = hunks.length - 1; k >= 0; k--) {
    const hunk = hunks[k]
    // 没有上下文也没有删除行（整段覆盖写入）：没法确定该换回什么
    if (!hunk.lines.some(l => l.op !== '+')) return null
    const now = hunk.lines.filter(l => l.op !== '-').map(l => l.text)
    const before = hunk.lines.filter(l => l.op !== '+').map(l => l.text)
    if (!now.length) return null
    const found = findAll(lines, now)
    if (!found.length) return null
    let at = found[0]
    if (hunk.newStart === null) {
      if (found.length !== 1) return null
    } else {
      const want = hunk.newStart - 1
      for (const i of found) if (Math.abs(i - want) < Math.abs(at - want)) at = i
    }
    lines.splice(at, now.length, ...before)
  }
  return lines.join('\n')
}

/**
 * 这一轮开始前的内容：
 * - kind==='add' 而且 isNewFile：返回 ''；kind==='add' 但不是新文件按 update 处理（D8，评审 b-12）
 * - 'delete'：返回 null
 * - 其它：从 current（\r\n 统一成 \n）开始按 diffs 倒序逐个 reverseApply；有空 diff 时返回 null
 */
export function turnBaseline(
  current: string,
  diffs: readonly string[],
  kind: TurnFile['kind'],
  isNewFile: boolean,
): string | null {
  if (kind === 'delete') return null
  if (kind === 'add' && isNewFile) return ''
  if (!diffs.length) return null
  let text: string | null = current.replace(/\r\n/g, '\n')
  for (let i = diffs.length - 1; i >= 0; i--) {
    if (!diffs[i]) return null
    const hunks = parseDiffBody(diffs[i])
    if (!hunks) return null
    text = reverseApply(text, hunks)
    if (text === null) return null
  }
  return text
}

interface BaselineEntry {
  version: string
  diffs: readonly string[]
  kind: TurnFile['kind']
  isNew: boolean
  baseline: string | null
  /** 这次真的从内容倒推出来了 */
  exact: boolean
}
/** 按 scope 缓存；算不出来时（例如撤销后已经存盘）退回上一次算出来的基准 */
const baselines = new Map<string, BaselineEntry>()
const lastGood = new Map<string, string>()

/**
 * 这一轮开始前的内容，这一轮的 diff 没变就不再变：之后磁盘上的改动（用户保存、撤销）不是这一轮的，不能算进基准。
 * 没能倒推出来时可能只是内容还没读到最新，内容一变就再算。
 * shortcut: 只在内存里记，重启应用后从当时的内容倒推，已保存的改动会算进基准；要跨重启得把基准存盘
 */
export function baselineFor(
  scope: string,
  content: string,
  version: string,
  file: Pick<TurnFile, 'diffs' | 'kind'>,
  isNew: boolean,
): string | null {
  const hit = baselines.get(scope)
  if (
    hit &&
    hit.kind === file.kind &&
    hit.isNew === isNew &&
    (hit.exact || hit.version === version) &&
    hit.diffs.length === file.diffs.length &&
    hit.diffs.every((d, i) => d === file.diffs[i])
  )
    return hit.baseline
  const computed = turnBaseline(content, file.diffs, file.kind, isNew)
  if (computed !== null) lastGood.set(scope, computed)
  const baseline = computed ?? lastGood.get(scope) ?? null
  baselines.set(scope, { version, diffs: file.diffs, kind: file.kind, isNew, baseline, exact: computed !== null })
  return baseline
}

export interface ReviewHunk {
  key: string
  /** 基准文档里这一块的范围（整行；toA 不含行尾换行） */
  fromA: number
  toA: number
  /** 当前文档里这一块的范围（整行；toB 不含行尾换行；纯删除时 fromB === toB） */
  fromB: number
  toB: number
  baselineText: string
  currentText: string
  /** 「撤销」要做的替换：把 undoFrom..undoTo 换成 undoInsert（行尾换行已经算进去） */
  undoFrom: number
  undoTo: number
  undoInsert: string
  /** 有没有新增行 / 删除行 */
  hasCurrent: boolean
  hasBaseline: boolean
}

export function hunkKey(baselineText: string, currentText: string): string {
  let h = 5381
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
    h = ((h * 33) ^ 0x7c) >>> 0
  }
  mix(baselineText)
  mix(currentText)
  return `${baselineText.length}:${currentText.length}:${h.toString(36)}`
}

const toDoc = (text: string): Text => Text.of(text.replace(/\r\n/g, '\n').split('\n'))

/** 用 @codemirror/merge 的 Chunk.build 算出每个改动块；坐标是 Text 里的偏移 */
export function reviewHunks(baseline: string, current: string): ReviewHunk[] {
  const a = toDoc(baseline),
    b = toDoc(current)
  return Chunk.build(a, b).map((chunk): ReviewHunk => {
    const hasBaseline = chunk.toA > chunk.fromA,
      hasCurrent = chunk.toB > chunk.fromB
    const toA = hasBaseline ? Math.min(chunk.toA - 1, a.length) : chunk.fromA
    const toB = hasCurrent ? Math.min(chunk.toB - 1, b.length) : chunk.fromB
    const baselineText = hasBaseline ? a.sliceString(chunk.fromA, toA) : ''
    const currentText = hasCurrent ? b.sliceString(chunk.fromB, toB) : ''
    let undoFrom = chunk.fromB,
      undoTo = toB,
      undoInsert = baselineText
    if (!hasCurrent) {
      // 纯删除：在原位置补回旧行（带行尾换行）；补在文档末尾（最后一行没有换行）时换行放前面
      undoTo = undoFrom
      if (chunk.fromB >= b.length && b.length > 0 && b.sliceString(b.length - 1) !== '\n') {
        undoFrom = undoTo = b.length
        undoInsert = `\n${baselineText}`
      } else undoInsert = `${baselineText}\n`
    } else if (!hasBaseline) {
      // 纯新增：把新增的整行连同一个换行删掉
      undoInsert = ''
      if (toB < b.length) undoTo = toB + 1
      else if (chunk.fromB > 0) undoFrom = chunk.fromB - 1
    }
    return {
      key: hunkKey(baselineText, currentText),
      fromA: chunk.fromA,
      toA,
      fromB: chunk.fromB,
      toB,
      baselineText,
      currentText,
      undoFrom,
      undoTo,
      undoInsert,
      hasCurrent,
      hasBaseline,
    }
  })
}
