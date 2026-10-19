// 只读用的 Codex app-server（docs/ui/codex-resume.md §3.5）：列线程、读线程的元数据和轮次。
// 只发 thread/list、thread/read、thread/turns/list，绝不 thread/resume（不拿线程的写入锁，不会挡住终端里的 codex）。
// 按需起一个进程，空闲 60 秒自己关；请求排队一个一个发；signal 触发时不等回包。
// 每次请求前核对启动配置（程序、参数、环境变量含 CODEX_HOME、工作目录），变了就换一个进程，不会接着读旧目录。
import { QUICK_CLOSE_MS, type Launcher } from '../adapter'
import { startupReason } from '../exec'
import { logger } from '../log'
import { NATIVE_TEXT } from '../native/text'
import { CodexProcess, type Message } from './process'

const log = logger('engine.codex.reader')

/** 读取层需要的东西：native.ts 里的函数只认这个，测试里用假的 */
export interface CodexRpc {
  request(method: string, params: Message, signal?: AbortSignal): Promise<Message>
}

/** 起读取进程要用的东西；Codex 没装好 / 没检测成功时 launch() 返回 null */
export interface ReaderLaunch {
  launcher: Launcher
  /** app-server 之外的启动参数（用户在设置里追加的） */
  args: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

/** 读取进程的最小接口（CodexProcess 实现），测试可以换成假的 */
export interface ReaderProcess {
  readonly alive: boolean
  request(method: string, params: unknown, timeoutMs?: number): Promise<Message>
  close(timeoutMs?: number): Promise<void>
  kill(): void
}

export interface ReaderOptions {
  /** 空闲多久关进程，默认 60 秒 */
  idleMs?: number
  /** 单个请求的超时，默认 60 秒 */
  timeoutMs?: number
  /** 起进程并完成 initialize；测试注入假的 */
  open?: (launch: ReaderLaunch, onExit: () => void) => Promise<ReaderProcess>
}

export const READER_IDLE_MS = 60_000

/** 启动配置的指纹：任何一项变了（换了 CODEX_HOME、追加参数、程序）都要换进程 */
export function readerLaunchKey(launch: ReaderLaunch): string {
  const env = Object.entries(launch.env)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify([launch.launcher.command, launch.launcher.args, launch.args, launch.cwd, env])
}

/** 起 app-server 并握手；握手失败带上 stderr 的头两行当原因 */
async function openProcess(launch: ReaderLaunch, onExit: () => void): Promise<ReaderProcess> {
  let tail = ''
  const proc: CodexProcess = new CodexProcess(
    launch.launcher,
    ['app-server', '--listen', 'stdio://', ...launch.args],
    launch.cwd,
    launch.env,
    {
      notification() {},
      request: id => proc.respondError(id, 'Read-only history'),
      exit: (_code, stderr) => {
        tail = stderr
        onExit()
      },
    },
  )
  try {
    // ThreadListParams 的几个过滤字段是实验字段
    await proc.initialize(true)
  } catch (err) {
    proc.kill()
    const reason = startupReason(tail) || (err as Error).message
    throw new Error(`${NATIVE_TEXT.codexUnavailable}：${reason}`)
  }
  return proc
}

export class CodexReader implements CodexRpc {
  private proc: ReaderProcess | null = null
  /** 当前进程是按哪份启动配置起的（readerLaunchKey） */
  private procKey: string | null = null
  private starting: Promise<ReaderProcess> | null = null
  private idle: NodeJS.Timeout | null = null
  /** 排队：上一个请求完了才发下一个 */
  private tail: Promise<unknown> = Promise.resolve()
  private waiting = 0
  /** 「代」：close() 加一。close 之前排队的请求、正在起的进程都属于旧的一代，不能再用 */
  private generation = 0

  constructor(
    private readonly launch: () => Promise<ReaderLaunch | null>,
    private readonly opts: ReaderOptions = {},
  ) {}

  /** 进程现在是不是开着（测试用） */
  get running(): boolean {
    return !!this.proc?.alive
  }

  /**
   * 发一个只读请求。Codex 没装好时抛 NATIVE_TEXT.codexUnavailable；进程起不来、请求出错都抛带原因的 Error。
   * signal 触发时立刻拒绝（进程不杀，晚到的回包丢掉）
   */
  request(method: string, params: Message, signal?: AbortSignal): Promise<Message> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    this.stopIdle()
    this.waiting++
    const generation = this.generation
    const run = this.tail.then(async () => {
      signal?.throwIfAborted()
      // 排队期间被 close() 了：不再起进程
      if (generation !== this.generation) throw new Error(NATIVE_TEXT.codexReaderClosed)
      return this.send(method, params, generation)
    })
    // 队列接着往下走，不管这一个成不成
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    const done = (): void => {
      this.waiting--
      if (this.waiting === 0) this.armIdle()
    }
    const result = signal ? raceAbort(run, signal) : run
    run.then(done, done)
    return result
  }

  /**
   * 关掉进程（Codex 路径变了、更新 / 安装前、应用退出）；之后的新请求会重新起。
   * 挡得住两种漏网的情况：正在启动的进程（起来后马上关掉）和排队中的请求（立即拒绝）
   */
  async close(opts: { quick?: boolean } = {}): Promise<void> {
    this.generation++
    this.stopIdle()
    const proc = this.proc
    this.proc = null
    this.procKey = null
    this.starting = null
    if (proc) await proc.close(opts.quick ? QUICK_CLOSE_MS : undefined).catch(() => {})
  }

  private async send(method: string, params: Message, generation: number): Promise<Message> {
    const timeout = this.opts.timeoutMs ?? 60_000
    // 请求途中进程死了（崩溃、被杀）：重起一次再试（读取都是幂等的）。
    // 真进程退出时先同步拒绝挂着的请求、再同步通知 onExit，所以这里看到失败时 this.proc 已经被清掉了，只看进程自己的 alive；
    // 但 close() 引起的失败不重试
    for (let attempt = 0; ; attempt++) {
      const proc = await this.ensure(generation)
      try {
        return await proc.request(method, params, timeout)
      } catch (err) {
        if (attempt === 0 && !proc.alive && generation === this.generation) {
          if (this.proc === proc) this.proc = null
          continue
        }
        throw err
      }
    }
  }

  private async ensure(generation: number): Promise<ReaderProcess> {
    if (generation !== this.generation) throw new Error(NATIVE_TEXT.codexReaderClosed)
    if (!this.starting) {
      // close() 会把 starting 清掉；旧的启动收尾时不能把后来新起的那个也清了
      const starting: Promise<ReaderProcess> = this.acquire(generation).finally(() => {
        if (this.starting === starting) this.starting = null
      })
      this.starting = starting
    }
    return this.starting
  }

  /** 拿一个按当前启动配置起的进程：开着且配置没变就接着用，配置变了先关掉旧的再起新的 */
  private async acquire(generation: number): Promise<ReaderProcess> {
    const launch = await this.launch()
    // 取启动参数期间被 close() 了
    if (generation !== this.generation) throw new Error(NATIVE_TEXT.codexReaderClosed)
    const key = launch ? readerLaunchKey(launch) : null
    const current = this.proc
    if (current?.alive && key === this.procKey) return current
    this.proc = null
    this.procKey = null
    if (current?.alive) {
      // 用户在设置里改了 CODEX_HOME / 参数 / 程序：旧进程还读着旧配置，换掉。
      // 直接杀（只读进程，没东西要收尾）：换下来的进程没人再管，慢慢退出的话之后的 close() 等不到它，会占着 codex.exe 挡住更新
      log.debug('启动配置变了，换读取进程')
      current.kill()
    }
    if (!launch || key === null) throw new Error(NATIVE_TEXT.codexUnavailable)
    return this.start(generation, launch, key)
  }

  private async start(generation: number, launch: ReaderLaunch, key: string): Promise<ReaderProcess> {
    let self: ReaderProcess | null = null
    const onExit = (): void => {
      if (self && this.proc === self) this.proc = null
    }
    const open = this.opts.open ?? openProcess
    self = await open(launch, onExit)
    // 起进程期间被 close() 了：这个进程已经没人要，马上关掉（不然 update / install 前关了又被拉起来，占着 codex.exe）
    if (generation !== this.generation) {
      self.kill()
      throw new Error(NATIVE_TEXT.codexReaderClosed)
    }
    this.proc = self
    this.procKey = key
    log.debug('读取进程已启动')
    return self
  }

  private armIdle(): void {
    this.stopIdle()
    if (!this.proc) return
    this.idle = setTimeout(() => {
      this.idle = null
      if (this.waiting > 0) return
      log.debug('读取进程空闲，关闭')
      void this.close()
    }, this.opts.idleMs ?? READER_IDLE_MS)
    this.idle.unref?.()
  }

  private stopIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
  }
}

/** promise 和 signal 赛跑：signal 先触发就拒绝（promise 之后的结果丢掉，不算未处理） */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
