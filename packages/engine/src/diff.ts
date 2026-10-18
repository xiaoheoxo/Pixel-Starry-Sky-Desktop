// 生成显示用的 diff（只有 @@ 行和 +/-/空格 开头的行，没有文件头）

/** 去掉相同的开头结尾后，中间两段行数乘积超过这个值就改用 Myers（动态规划表太大） */
const MAX_CELLS = 2_000_000
/** Myers 最多追到这么多处增删；再多（几乎整个重写）就把中间那段当作整段删再整段加 */
const MAX_EDITS = 4000

function splitLines(s: string): string[] {
  if (!s) return []
  const lines = s.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

export interface DiffResult {
  diff: string
  added: number
  removed: number
}

/** 逐行比对的一行：空格 = 两边都有，- = 只在旧文本，+ = 只在新文本 */
export type DiffLine = readonly [' ' | '-' | '+', string]

/** 中间一段用动态规划（最长公共子序列）：dp[i][j] = a[i..] 和 b[j..] 的最长公共子序列长度 */
function lcsMiddle(a: string[], b: string[], out: DiffLine[]): void {
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push([' ', a[i]])
      i++
      j++
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      // 同样长度时先删后加，和常见的 diff 显示一致
      out.push(['-', a[i]])
      i++
    } else {
      out.push(['+', b[j]])
      j++
    }
  }
}

/** 中间一段用 Myers O(ND)：每一轮 d 只存一份对角线数组，内存 O(D²)；超过 MAX_EDITS 返回 false */
function myersMiddle(a: string[], b: string[], out: DiffLine[]): boolean {
  // 行内容换成整数编号，比较更快
  const ids = new Map<string, number>()
  const id = (l: string): number => {
    let v = ids.get(l)
    if (v === undefined) ids.set(l, (v = ids.size))
    return v
  }
  const A = Int32Array.from(a, id)
  const B = Int32Array.from(b, id)
  const n = A.length
  const m = B.length
  const max = Math.min(n + m, MAX_EDITS)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && A[x] === B[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    // 记下这一轮之后 -d..d 的对角线（回溯时要用）
    trace.push(v.slice(off - d - 1, off + d + 2))
  }
  if (found < 0) return false
  // 回溯：trace[d] 是第 d 轮结束后的 V，起点下标 off-d-1 对应 k=-d-1
  const rev: DiffLine[] = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1] // 第 d-1 轮结束后：下标 (k + d) 对应 k（起点 k=-(d-1)-1=-d）
    const k = x - y
    const at = (kk: number): number => prev[kk + d]
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const pk = down ? k + 1 : k - 1
    const px = at(pk)
    const py = px - pk
    // 先走对角线（相同行），再是这一步的增删
    while (x > (down ? px : px + 1) && y > (down ? py + 1 : py)) {
      x--
      y--
      rev.push([' ', a[x]])
    }
    if (down) rev.push(['+', b[--y]])
    else rev.push(['-', a[--x]])
  }
  while (x > 0 && y > 0) {
    x--
    y--
    rev.push([' ', a[x]])
  }
  for (let i = rev.length - 1; i >= 0; i--) out.push(rev[i])
  return true
}

/**
 * 两组行的逐行比对，保留全部上下文行。
 * 先去掉相同的开头和结尾，只比中间；中间不大用动态规划，大了用 Myers；
 * 改动实在太多（超过 MAX_EDITS 处）才把中间整段当作删了再加。
 * 两段长度之差本身就超过 MAX_EDITS 时，增删数下限已经超了，直接走整段删加，不再白跑 Myers。
 * 注意：增删的处数是最小的（LCS 和 Myers 都是），但相同行怎么对齐可能和旧的实现不完全一样
 * （Myers 的对齐更接近 git）；手机端小文件走 LCS，输出和以前一致。
 */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push([' ', a[i]])
  const ma = a.slice(start, endA)
  const mb = b.slice(start, endB)
  if (!ma.length || !mb.length) {
    for (const l of ma) out.push(['-', l])
    for (const l of mb) out.push(['+', l])
  } else if (ma.length * mb.length <= MAX_CELLS) {
    lcsMiddle(ma, mb, out)
  } else if (Math.abs(ma.length - mb.length) > MAX_EDITS || !myersMiddle(ma, mb, out)) {
    for (const l of ma) out.push(['-', l])
    for (const l of mb) out.push(['+', l])
  }
  for (let i = endA; i < a.length; i++) out.push([' ', a[i]])
  return out
}

/** 两段文本的逐行 diff，保留全部上下文行 */
export function diffText(oldText: string, newText: string): DiffResult {
  const lines = diffLines(splitLines(oldText), splitLines(newText))
  let added = 0
  let removed = 0
  for (const [t] of lines) {
    if (t === '+') added++
    else if (t === '-') removed++
  }
  return { diff: lines.map(([t, l]) => t + l).join('\n'), added, removed }
}

/** 新文件：每行都是新增 */
export function diffAdded(content: string): DiffResult {
  const lines = splitLines(content)
  return { diff: lines.map(l => `+${l}`).join('\n'), added: lines.length, removed: 0 }
}

export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** Claude Edit / Write 工具结果里的 structuredPatch */
export function diffFromHunks(hunks: PatchHunk[]): DiffResult {
  const out: string[] = []
  let added = 0
  let removed = 0
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines) {
      out.push(l)
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
  }
  return { diff: out.join('\n'), added, removed }
}
