// 子进程输出的解码：先按严格 UTF-8，不是合法 UTF-8 时（Windows 中文系统上 cmd / 原生程序按系统 OEM 代码页输出，
// 例如 GBK）改按 OEM 代码页解，最后才是宽松的 UTF-8。macOS / Linux 上除了去掉开头的 BOM 与以前一样。
import { execFile } from 'node:child_process'
import { join } from 'node:path'

const WINDOWS = process.platform === 'win32'

/** 代码页 → WHATWG 编码名；不认识的代码页返回 null（按宽松 UTF-8） */
export function codePageLabel(cp: number | null | undefined): string | null {
  if (!cp) return null
  if (cp === 936 || cp === 54936) return 'gb18030' // GBK 是 GB18030 的子集
  if (cp === 950) return 'big5'
  if (cp === 932) return 'shift_jis'
  if (cp === 949) return 'euc-kr'
  if (cp === 866) return 'ibm866'
  if (cp === 874) return 'windows-874'
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`
  return null
}

let detected: number | null | undefined // undefined = 还没查完
let detecting: Promise<number | null> | undefined

/** 按系统语言猜 OEM 代码页（注册表没查完或查不到时用）：繁体中文 950、简体中文 936、日文 932、韩文 949 */
export function guessCodePage(locale?: string): number | null {
  let tag = locale
  try {
    tag ??= Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return null
  }
  if (/^zh[-_](tw|hk|mo|hant)\b/i.test(tag)) return 950
  if (/^zh\b/i.test(tag)) return 936
  if (/^ja\b/i.test(tag)) return 932
  if (/^ko\b/i.test(tag)) return 949
  return null
}

/**
 * 系统 OEM 代码页（查注册表，只查一次并缓存；不会抛错）。注册表查不到（被组策略禁用、超时等）时按系统语言猜。
 * Windows 以外直接是 null
 */
export function detectOemCodePage(): Promise<number | null> {
  if (!WINDOWS) return Promise.resolve(null)
  detecting ??= new Promise<number | null>(resolve => {
    const done = (cp: number | null): void => {
      detected = cp ?? guessCodePage()
      resolve(detected)
    }
    try {
      const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
      execFile(
        reg,
        ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'OEMCP'],
        { windowsHide: true, timeout: 5000, encoding: 'utf8' },
        (err, stdout) => done(err ? null : Number(/OEMCP\s+REG_SZ\s+(\d+)/i.exec(stdout)?.[1]) || null),
      )
    } catch {
      done(null)
    }
  })
  return detecting
}
/** 已知的 OEM 代码页。第一次用到时才去查（要准确结果的调用方先 await detectOemCodePage()）；还没查完时按系统语言猜 */
export function oemCodePage(): number | null {
  if (detected !== undefined) return detected
  void detectOemCodePage()
  return guessCodePage()
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const legacy = new Map<string, TextDecoder | null>()
function legacyDecoder(label: string): TextDecoder | null {
  if (!legacy.has(label)) {
    try {
      legacy.set(label, new TextDecoder(label))
    } catch {
      legacy.set(label, null) // 这个 Node 构建不带该编码
    }
  }
  return legacy.get(label) ?? null
}

export interface ConsoleDecodeOptions {
  /** 指定 OEM 代码页（默认用系统的）；null = 未知 */
  codePage?: number | null
  /** 是否 Windows（默认看当前平台），非 Windows 不会尝试 OEM 代码页 */
  windows?: boolean
}

/**
 * 粗算一段字节像不像 UTF-8：合法的多字节序列有几个、坏字节有几个（末尾被切断的半个字符两边都不算）。
 * GBK 等代码页的双字节字符很少恰好是合法的 UTF-8 序列，所以坏字节会远多于合法序列
 */
function utf8Shape(bytes: Uint8Array): { valid: number; invalid: number } {
  let valid = 0
  let invalid = 0
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]
    if (b < 0x80) {
      i++
      continue
    }
    const need = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1
    if (need < 0) {
      invalid++
      i++
      continue
    }
    let ok = 0
    while (ok < need && i + 1 + ok < bytes.length && (bytes[i + 1 + ok] & 0xc0) === 0x80) ok++
    if (ok === need) {
      valid++
      i += need + 1
    } else if (i + 1 + ok >= bytes.length) {
      break // 末尾被切断的半个字符
    } else {
      invalid++
      i++
    }
  }
  return { valid, invalid }
}

function decodeRaw(bytes: Uint8Array, options?: ConsoleDecodeOptions): string {
  try {
    return strictUtf8.decode(bytes)
  } catch {
    // 基本是 UTF-8、只夹了个别坏字节（或末尾切断）：按宽松 UTF-8 解，坏的地方是 U+FFFD，其余照常。
    // 整行改按 GB18030 解反而会把 UTF-8 的中文全变成乱码，还可能把坏字节后面的 ASCII 并进一个汉字
    const shape = utf8Shape(bytes)
    if (shape.invalid === 0 || shape.valid >= shape.invalid) return Buffer.from(bytes).toString('utf8')
    if ((options?.windows ?? WINDOWS) === true) {
      const label = codePageLabel(options?.codePage !== undefined ? options.codePage : oemCodePage())
      const decoder = label ? legacyDecoder(label) : null
      if (decoder) return decoder.decode(bytes)
    }
    return Buffer.from(bytes).toString('utf8')
  }
}

/** 逐行判断编码再拼起来：同一个流里 UTF-8 的行（PowerShell 自己的输出）和 OEM 的行（原生程序）可能混在一起 */
function decodeLines(bytes: Uint8Array, options?: ConsoleDecodeOptions): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  let out = ''
  for (let start = 0; start < buf.length; ) {
    const nl = buf.indexOf(0x0a, start)
    const end = nl < 0 ? buf.length : nl + 1
    out += decodeRaw(buf.subarray(start, end), options)
    start = end
  }
  return out
}

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

/** 一段完整的输出：逐行按 严格 UTF-8 → （Windows）OEM 代码页 → 宽松 UTF-8 解，并去掉开头的 BOM */
export function decodeConsoleText(bytes: Uint8Array | string, options?: ConsoleDecodeOptions): string {
  if (typeof bytes === 'string') return bytes
  return stripBom(decodeLines(bytes, options))
}

/** 末尾不完整的 UTF-8 多字节序列有几个字节（0 = 没有） */
function incompleteUtf8Tail(buf: Buffer): number {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const b = buf[buf.length - back]
    if ((b & 0xc0) === 0x80) continue // 续字节，再往前找起始字节
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    return need > back ? back : 0
  }
  return 0
}

const MAX_HELD = 64 * 1024

/**
 * 流式解码，用法同 setEncoding('utf8')：write() 返回目前能解出的文字，end() 交出剩下的。
 * UTF-8 数据（Claude / Codex 的协议行）只留住末尾被切断的多字节字符，其余立刻交出；
 * 不是 UTF-8 的数据（OEM 代码页）只解到最后一个换行（0x0A 在 GBK / Big5 / Shift_JIS 里不会是后续字节），
 * 半行留到下一块或 end()，所以多字节字符不会被块边界切坏——代价是这类输出的提示符要等换行才出来。
 */
export class ConsoleStreamDecoder {
  private held: Buffer = Buffer.alloc(0)
  private started = false
  constructor(private readonly options?: ConsoleDecodeOptions) {}

  private emit(text: string): string {
    if (!text) return text
    if (this.started) return text
    this.started = true
    return stripBom(text)
  }

  write(chunk: Uint8Array | string): string {
    if (typeof chunk === 'string') return chunk
    const buf = this.held.length
      ? Buffer.concat([this.held, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)
    try {
      this.held = Buffer.alloc(0)
      return this.emit(strictUtf8.decode(buf))
    } catch {
      // 不是完整的 UTF-8：先看是不是只是末尾的字符被切断
    }
    const tail = incompleteUtf8Tail(buf)
    if (tail) {
      try {
        const text = strictUtf8.decode(buf.subarray(0, buf.length - tail))
        this.held = Buffer.from(buf.subarray(buf.length - tail))
        return this.emit(text)
      } catch {
        // 前面也不是 UTF-8
      }
    }
    const nl = buf.lastIndexOf(0x0a)
    if (nl < 0 && buf.length <= MAX_HELD) {
      this.held = Buffer.from(buf)
      return ''
    }
    const cut = nl < 0 ? buf.length : nl + 1
    this.held = Buffer.from(buf.subarray(cut))
    return this.emit(decodeLines(buf.subarray(0, cut), this.options))
  }

  end(): string {
    const buf = this.held
    this.held = Buffer.alloc(0)
    return buf.length ? this.emit(decodeLines(buf, this.options)) : ''
  }
}

/** 字节里出现的每个 needle 换成 [redacted]（解码前先做：按哪种编码解都不会把密钥拆散、躲过后面的文字脱敏） */
function maskBytes(buf: Buffer, needles: readonly Buffer[]): Buffer {
  let out = buf
  for (const needle of needles) {
    let at = out.indexOf(needle)
    if (at < 0) continue
    const parts: Buffer[] = []
    let from = 0
    while (at >= 0) {
      // 前一个字节可能是落单的双字节首字节：隔一个空格，免得按 GBK 解时把 [ 并进一个汉字
      parts.push(out.subarray(from, at), at > 0 && out[at - 1] >= 0x80 ? SPACED_REDACTED : REDACTED)
      from = at + needle.length
      at = out.indexOf(needle, from)
    }
    parts.push(out.subarray(from))
    out = Buffer.concat(parts)
  }
  return out
}
const REDACTED = Buffer.from('[redacted]')
const SPACED_REDACTED = Buffer.from(' [redacted]')

/**
 * 按行解码：只交出完整的行（含结尾的 \n），半行留着。每行单独判断编码；
 * 0x0A 在 UTF-8 和各代码页里都不会是多字节字符的一部分，所以不会把字符切坏。
 * 一行超过 maxLine 字节还没换行就丢掉，交出 omitted 提示，并一直丢到下一个换行。
 * mask：解码前在字节里先遮掉的密钥（4 个字符以上的才遮，和文字脱敏一致）
 */
export class ConsoleLineDecoder {
  private held: Buffer = Buffer.alloc(0)
  private started = false
  /** 丢掉超长行之后丢到下一个换行：不然这一行的后半截会单独显示，跨在边界上的密钥后半截也躲过脱敏 */
  private skipping = false
  private readonly needles: Buffer[]
  constructor(
    private readonly options?: ConsoleDecodeOptions & { mask?: readonly string[] },
    private readonly maxLine = 64 * 1024,
    private readonly omitted = '[long output omitted]\n',
  ) {
    this.needles = (options?.mask ?? [])
      .filter(s => s.length >= 4)
      .sort((a, b) => b.length - a.length)
      .map(s => Buffer.from(s, 'utf8'))
  }

  private text(bytes: Buffer): string {
    const s = decodeLines(this.needles.length ? maskBytes(bytes, this.needles) : bytes, this.options)
    if (this.started || !s) return s
    this.started = true
    return stripBom(s)
  }

  write(chunk: Uint8Array): string {
    let buf = this.held.length
      ? Buffer.concat([this.held, chunk])
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length)
    this.held = Buffer.alloc(0)
    if (this.skipping) {
      const first = buf.indexOf(0x0a)
      if (first < 0) return ''
      this.skipping = false
      buf = buf.subarray(first + 1)
    }
    const nl = buf.lastIndexOf(0x0a)
    if (nl < 0) {
      if (buf.length > this.maxLine) {
        this.skipping = true
        return this.omitted
      }
      this.held = Buffer.from(buf)
      return ''
    }
    this.held = Buffer.from(buf.subarray(nl + 1))
    let out = this.text(buf.subarray(0, nl + 1))
    if (this.held.length > this.maxLine) {
      this.held = Buffer.alloc(0)
      this.skipping = true
      out += this.omitted
    }
    return out
  }

  /** 进程结束：交出最后没有换行的半行 */
  end(): string {
    const buf = this.held
    this.held = Buffer.alloc(0)
    this.skipping = false
    return buf.length ? this.text(buf) : ''
  }
}
