// 找可执行文件、跑一次性命令（--version 之类）
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, isAbsolute, join } from 'node:path'
import type { Launcher } from './adapter'
import { ConsoleStreamDecoder, decodeConsoleText } from './console-text'

export const IS_WINDOWS = process.platform === 'win32'

/**
 * 强制结束进程和它启动的子进程（正在跑的命令、MCP 服务等）。Windows 用 taskkill /T；
 * macOS / Linux 上进程要用 detached 启动（自成一个进程组），这里给整组发 SIGKILL。
 */
export function killTree(child: ChildProcess): void {
  try {
    if (IS_WINDOWS && child.pid)
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
        'error',
        () => child.kill(),
      )
    else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    } else child.kill()
  } catch {
    // 已经退出
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** 在 PATH 里找某个文件名（Windows 上要带扩展名，例如 claude.exe） */
export function findOnPath(fileName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PATH ?? env.Path ?? ''
  for (const dir of raw.split(delimiter)) {
    if (!dir) continue
    const p = join(dir.replace(/^"|"$/g, ''), fileName)
    if (existsSync(p) && isFile(p)) return p
  }
  return null
}

/** PATH 里所有包含某个文件的目录 */
export function dirsOnPath(fileName: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PATH ?? env.Path ?? ''
  return raw
    .split(delimiter)
    .filter(Boolean)
    .map(d => d.replace(/^"|"$/g, ''))
    .filter(d => isFile(join(d, fileName)))
}

/** PATH 环境变量的值（Windows 上键名大小写不定，复制出来的环境对象不再忽略大小写） */
function pathValue(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH')
  return (key ? env[key] : undefined) ?? ''
}

/** 能直接启动的文件：Windows 上只有 .exe / .com（脚本要经过 cmd.exe），其它系统要有执行权限 */
function launchable(p: string): boolean {
  if (IS_WINDOWS) return /\.(?:exe|com)$/i.test(p)
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 用户替换的命令解析结果（docs/ui/engine-launch.md §3） */
export type ResolvedCommand =
  | { ok: true; path: string }
  | { ok: false; reason: 'notFound' | 'notAbsolute' }
  /** 找到了，但不能直接启动（Windows 上的 .cmd / .bat / .ps1 等）；适配器可以再试着从 npm 垫片找到真正的程序 */
  | { ok: false; reason: 'script'; path: string }

/**
 * 解析用户替换的命令：带路径分隔符的按绝对路径找（~ 指用户目录），否则在 PATH 上找。
 * Windows 上没写扩展名时按 PATHEXT 补；PATH 上同名的脚本排在 .exe 前面时，继续往后找 .exe。
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): ResolvedCommand {
  let c = command.trim().replace(/^"(.*)"$/, '$1')
  if (c === '~' || c.startsWith('~/') || c.startsWith('~\\')) c = join(homedir(), c.slice(1))
  const exts = IS_WINDOWS
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map(e => e.trim().toLowerCase())
        .filter(e => e.startsWith('.'))
    : []
  const variants = (base: string): string[] =>
    !IS_WINDOWS ? [base] : [...(extname(base) ? [base] : []), ...exts.map(e => base + e)]
  let candidates: string[] = []
  if (/[\\/]/.test(c)) {
    if (!isAbsolute(c)) return { ok: false, reason: 'notAbsolute' }
    candidates = variants(c)
  } else if (c) {
    for (const dir of pathValue(env).split(delimiter))
      if (dir) candidates.push(...variants(join(dir.replace(/^"|"$/g, ''), c)))
  }
  const found = candidates.filter(isFile)
  const path = found.find(launchable)
  if (path) return { ok: true, path }
  return found.length ? { ok: false, reason: 'script', path: found[0] } : { ok: false, reason: 'notFound' }
}

export interface ExecResult {
  ok: boolean
  /** 进程起来了（退出码非 0、超时、输出过大也算）；false 是程序根本启动不了 */
  started: boolean
  stdout: string
  stderr: string
  /** 启动失败、超时或输出过大时的错误说明 */
  error: string | null
}

/** 跑一次性命令，不经过 shell，不弹窗口 */
export function run(
  launcher: Launcher,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Promise<ExecResult> {
  return new Promise(resolve => {
    try {
      execFile(
        launcher.command,
        [...launcher.args, ...args],
        { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' },
        (err, stdout, stderr) => {
          // 输出超过 maxBuffer 时 Node 也会结束进程（有的版本还标 killed），和超时分开报
          const tooLarge = (err as NodeJS.ErrnoException | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          resolve({
            ok: !err,
            started: !err || err.killed || tooLarge || typeof (err as { code?: unknown }).code === 'number',
            stdout: decodeConsoleText(stdout ?? new Uint8Array()),
            stderr: decodeConsoleText(stderr ?? new Uint8Array()),
            error: err
              ? tooLarge
                ? '输出过大'
                : (err as NodeJS.ErrnoException).code === 'ETIMEDOUT' || err.killed
                  ? '超时'
                  : err.message
              : null,
          })
        },
      )
    } catch (err) {
      // 不是合法程序的文件（例如 Windows 上的 EFTYPE）会同步抛出，而不是走回调
      resolve({ ok: false, started: false, stdout: '', stderr: '', error: (err as Error).message })
    }
  })
}

/** 安装 / 更新命令输出的最后几行（给用户看）；没有输出时用错误原因 */
export function outputTail(r: ExecResult, count = 6): string {
  const lines = [r.stdout, r.stderr]
    .join('\n')
    .split(/\r?\n|\r/)
    .map(plainLine)
    .filter(Boolean)
  return lines.slice(-count).join('\n') || (r.error ?? '')
}

/** 一行输出给界面看：去掉颜色控制序列和首尾空白 */
export function plainLine(line: string): string {
  // eslint-disable-next-line no-control-regex -- 就是要去掉颜色和光标控制序列
  return line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()
}

/**
 * 跑一个要好一会儿的命令（安装、更新），边跑边把每一行输出交给 onLine（\r 刷新的进度行也算一行）。
 * 不经过 shell，不弹窗口；超时连同子进程一起结束。结果和 run() 一样
 */
export function runStream(
  launcher: Launcher,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  onLine: (line: string) => void,
): Promise<ExecResult> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(launcher.command, [...launcher.args, ...args], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !IS_WINDOWS,
      })
    } catch (err) {
      resolve({ ok: false, started: false, stdout: '', stderr: '', error: (err as Error).message })
      return
    }
    const out = { stdout: '', stderr: '' }
    const pending = { stdout: '', stderr: '' }
    const LIMIT = 256 * 1024
    let timedOut = false
    const take = (key: 'stdout' | 'stderr', chunk: string, flush = false): void => {
      if (out[key].length < LIMIT) out[key] += chunk
      const parts = (pending[key] + chunk).split(/\r\n|\r|\n/)
      pending[key] = flush ? '' : (parts.pop() ?? '')
      for (const part of parts) {
        const line = plainLine(part)
        if (line) onLine(line)
      }
    }
    // 按字节收再解码（UTF-8 优先，Windows 上退到系统 OEM 代码页）；多字节字符被块边界切开也不会坏
    const decoders = { stdout: new ConsoleStreamDecoder(), stderr: new ConsoleStreamDecoder() }
    child.stdout!.on('data', (chunk: Buffer) => take('stdout', decoders.stdout.write(chunk)))
    child.stderr!.on('data', (chunk: Buffer) => take('stderr', decoders.stderr.write(chunk)))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    let settled = false
    const done = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    child.on('error', err =>
      done({ ok: false, started: false, stdout: out.stdout, stderr: out.stderr, error: err.message }),
    )
    child.on('close', code => {
      take('stdout', decoders.stdout.end(), true)
      take('stderr', decoders.stderr.end(), true)
      done({
        ok: code === 0 && !timedOut,
        started: true,
        stdout: out.stdout,
        stderr: out.stderr,
        error: timedOut ? '超时' : code === 0 ? null : `退出码 ${code ?? '?'}`,
      })
    })
  })
}

/** 一个交互式命令：能往 stdin 写、能随时结束 */
export interface InteractiveProcess {
  write(text: string): void
  kill(): void
  done: Promise<ExecResult>
}

/** 没换行结尾的半行停多久还没后续，就当作提示符交给 onText（Claude 的「Paste code here if prompted >」不带换行） */
const PARTIAL_IDLE_MS = 150

/**
 * 跑一个要和用户交互的命令（授权登录）：stdin 可写，每一整行和停住不动的半行（提示符）都交给 onText。
 * 不经过 shell，不弹窗口；没有超时，由调用方 kill()
 */
export function runInteractive(
  launcher: Launcher,
  args: string[],
  env: NodeJS.ProcessEnv,
  onText: (line: string) => void,
): InteractiveProcess {
  let child: ChildProcess
  try {
    child = spawn(launcher.command, [...launcher.args, ...args], {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !IS_WINDOWS,
    })
  } catch (err) {
    const failed: ExecResult = { ok: false, started: false, stdout: '', stderr: '', error: (err as Error).message }
    return { write() {}, kill() {}, done: Promise.resolve(failed) }
  }
  const out = { stdout: '', stderr: '' }
  const pending = { stdout: '', stderr: '' }
  const timers: Partial<Record<'stdout' | 'stderr', NodeJS.Timeout>> = {}
  const LIMIT = 256 * 1024
  /** 已经当提示符交出去的半行：后面接着来的输出补齐这一行时再交完整的一行（网址分两段到也不会被截断） */
  const shown = { stdout: '', stderr: '' }
  const take = (key: 'stdout' | 'stderr', chunk: string, flush = false): void => {
    if (out[key].length < LIMIT) out[key] += chunk
    clearTimeout(timers[key])
    const parts = (pending[key] + chunk).split(/\r\n|\r|\n/)
    pending[key] = flush ? '' : (parts.pop() ?? '')
    // 交过的半行补齐了：半行里有网址（被分成两段送来）就重交完整的一行，否则是提示符，只交后面接上的部分
    if (parts.length && shown[key] && parts[0].startsWith(shown[key]) && !/https?:/.test(shown[key]))
      parts[0] = parts[0].slice(shown[key].length)
    if (parts.length) shown[key] = ''
    for (const part of parts) {
      const line = plainLine(part)
      if (line) onText(line)
    }
    // 半行停住不动：当作提示符交出去；同一段不会交两次
    if (pending[key] && pending[key] !== shown[key]) {
      timers[key] = setTimeout(() => {
        shown[key] = pending[key]
        const line = plainLine(pending[key])
        if (line) onText(line)
      }, PARTIAL_IDLE_MS)
    }
  }
  // 按字节收再解码（UTF-8 优先，Windows 上退到系统 OEM 代码页）；多字节字符被块边界切开也不会坏
  const decoders = { stdout: new ConsoleStreamDecoder(), stderr: new ConsoleStreamDecoder() }
  child.stdout!.on('data', (chunk: Buffer) => take('stdout', decoders.stdout.write(chunk)))
  child.stderr!.on('data', (chunk: Buffer) => take('stderr', decoders.stderr.write(chunk)))
  // 命令先退出时往 stdin 写会报 EPIPE，忽略
  child.stdin!.on('error', () => undefined)
  let killed = false
  const done = new Promise<ExecResult>(resolve => {
    let settled = false
    const finish = (result: ExecResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timers.stdout)
      clearTimeout(timers.stderr)
      resolve(result)
    }
    child.on('error', err =>
      finish({ ok: false, started: false, stdout: out.stdout, stderr: out.stderr, error: err.message }),
    )
    child.on('close', code => {
      take('stdout', decoders.stdout.end(), true)
      take('stderr', decoders.stderr.end(), true)
      finish({
        ok: code === 0 && !killed,
        started: true,
        stdout: out.stdout,
        stderr: out.stderr,
        error: killed ? '已结束' : code === 0 ? null : `退出码 ${code ?? '?'}`,
      })
    })
  })
  return {
    write: text => {
      try {
        child.stdin!.write(text)
      } catch {
        // 已经退出
      }
    },
    kill: () => {
      killed = true
      killTree(child)
    },
    done,
  }
}

/**
 * 进程起不来时（例如追加了它不认的参数）给用户看的原因：stderr 开头两行，比「进程已退出」有用。
 * 命令行报错带颜色（\x1b[...m），界面上只要文字（docs/ui/engine-launch.md §9.2）
 */
export function startupReason(stderr: string): string {
  // 启动时就抛了未捕获的异常（Node 会先印出错的源码行）：和跑到一半崩的一样只取报错那句
  if (/^\s*at\s/m.test(stderr) && /^Node\.js v\d/m.test(stderr)) return crashReason(stderr)
  return (
    stderr
      // eslint-disable-next-line no-control-regex -- 就是要去掉颜色控制序列
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join('\n')
  )
}

const ERROR_LINE = /^(?:Uncaught )?(?:[A-Za-z_$][\w$]*)?(?:Error|Exception)\b(?: \[[^\]]*\])?:?/
const STACK_LINE = /^at\s|^Node\.js v\d/
/** 一行最多显示这么多字；Node 报错时会把出错的那行源码印出来，打包压缩过的源码一行就有几十 KB */
const CRASH_LINE_MAX = 500

/**
 * 进程跑到一半崩了（Node 未捕获的异常）时给用户看的原因：只要「Error: …」那句和它的续行，
 * 不要 Node 印出来的出错源码（打包压缩后一行几十 KB）、^ 标记和调用栈。认不出来时去掉源码和调用栈，取最后几行。
 * 完整的 stderr 照旧写进进程日志
 */
export function crashReason(stderr: string): string {
  const lines = stderr
    // eslint-disable-next-line no-control-regex -- 就是要去掉颜色控制序列
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(l => l.trim())
  const clip = (l: string): string => (l.length > CRASH_LINE_MAX ? l.slice(0, CRASH_LINE_MAX) + '…' : l)
  let at = -1
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_LINE.test(lines[i])) at = i
  // 取第一个报错行（后面的往往是 cause / 重复），带上紧跟着的说明行，到调用栈为止
  if (at >= 0) {
    const out: string[] = []
    for (let i = at; i < lines.length && out.length < 3; i++) {
      if (!lines[i] || STACK_LINE.test(lines[i])) break
      out.push(clip(lines[i]))
    }
    return out.join('\n')
  }
  return lines
    .filter(l => l && l.length <= CRASH_LINE_MAX && !STACK_LINE.test(l) && l !== '^' && !/^\^+$/.test(l))
    .slice(-3)
    .join('\n')
}

/** 比较版本号 a 是否 >= b（只看数字部分） */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map(x => parseInt(x, 10) || 0)
  const pb = b.split('.').map(x => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}
