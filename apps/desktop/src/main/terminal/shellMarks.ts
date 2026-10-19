// 终端 shell 集成的标记解析：我们给自己开的 shell 在提示符前输出用户看不见的 OSC 633 序列（参照 VS Code），
// 这里从 pty 输出里认出来并剥掉（xterm 和历史文本都看不到），变成「命令结束 / 提示符开始」事件。
//   ESC ] 633 ; D [; <退出码>] BEL    上一条命令结束（只有真跑过命令才发）
//   ESC ] 633 ; A BEL                提示符开始
// 结尾 BEL 或 ESC \ 都认。别的 633 子命令（别的工具发的）原样放行。

export type ShellMark = { kind: 'prompt' } | { kind: 'end'; exitCode: number | null }

export interface MarkParser {
  /** 喂一段 pty 输出：返回剥掉标记后的文本和认出的标记；跨块切开的序列会留到下一块 */
  push(chunk: string): { text: string; marks: ShellMark[] }
}

const START = '\u001b]633;'
/** 标记正文（D;-1073741510 之类）的长度上限，超过的不是我们的 */
const MAX_BODY = 32

/** buf 结尾有多少个字符是 START 的真前缀（可能是被切开的标记开头） */
function partialTail(buf: string): number {
  for (let k = Math.min(START.length - 1, buf.length); k > 0; k--) if (buf.endsWith(START.slice(0, k))) return k
  return 0
}

type Terminator = { end: number; length: number } | 'partial' | 'invalid'
/** 从 from 开始找结尾：BEL 或 ESC \；还没收全 → partial；中间夹了别的转义或太长 → invalid */
function findTerminator(buf: string, from: number): Terminator {
  const limit = Math.min(buf.length, from + MAX_BODY + 1)
  for (let i = from; i < limit; i++) {
    const c = buf[i]
    if (c === '\u0007') return { end: i, length: 1 }
    if (c === '\u001b') {
      if (i + 1 >= buf.length) return 'partial'
      return buf[i + 1] === '\\' ? { end: i, length: 2 } : 'invalid'
    }
  }
  return buf.length - from > MAX_BODY ? 'invalid' : 'partial'
}

function parseBody(body: string): ShellMark | null {
  if (body === 'A') return { kind: 'prompt' }
  const end = /^D(?:;(-?\d{1,10})?)?$/.exec(body)
  if (!end) return null
  const code = end[1] === undefined ? null : Number(end[1])
  return { kind: 'end', exitCode: code !== null && Number.isSafeInteger(code) ? code : null }
}

export function createMarkParser(): MarkParser {
  let held = ''
  return {
    push(chunk) {
      let buf = held + chunk
      held = ''
      let text = ''
      const marks: ShellMark[] = []
      for (;;) {
        const at = buf.indexOf(START)
        if (at < 0) {
          const keep = partialTail(buf)
          text += buf.slice(0, buf.length - keep)
          held = buf.slice(buf.length - keep)
          break
        }
        text += buf.slice(0, at)
        const body = at + START.length
        const term = findTerminator(buf, body)
        if (term === 'partial') {
          held = buf.slice(at)
          break
        }
        if (term === 'invalid') {
          // 不是完整的标记：当普通输出，从下一个字符接着找
          text += buf[at]
          buf = buf.slice(at + 1)
          continue
        }
        const mark = parseBody(buf.slice(body, term.end))
        // 认不得的 633 序列（别的工具发的）不动它
        if (mark) marks.push(mark)
        else text += buf.slice(at, term.end + term.length)
        buf = buf.slice(term.end + term.length)
      }
      return { text, marks }
    },
  }
}
