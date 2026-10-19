import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC_CONTRACT, type IpcChannelName, type IpcChannelSpec, type IpcTrust } from '@pixelsky/protocol'
import { logger } from '@pixelsky/engine'

/**
 * 主进程 IPC 注册的唯一入口：按契约（packages/protocol/src/ipc/contract.ts）里每个通道的 `trust` 档位校验调用方，
 * 再调用处理函数。主进程其他文件不再直接用 `ipcMain.handle / on`，也没有自己的来源校验。
 *
 * 档位（越往下越严，前一档的条件都要满足）：
 * - `none`：不校验。
 * - `sender`：来源页面是应用自己的页面（打包后的本地文件，或开发服务器的同源页面）。
 * - `frame`：再要求来自窗口的顶层主框架。
 * - `window`：再要求调用方所在的窗口存在，且（默认）该窗口的 webContents 就是调用方，内嵌网页视图不能冒充。
 *
 * 每个通道的拒绝方式不同（有的抛「不受信任的页面」，有的抛别的文案，有的软失败返回固定值），
 * 逐通道的行为表见 docs/restructure.md §8.3 P5；这里用 `GuardOptions` 逐个注册点保持原样。
 */
type Channel<K extends IpcChannelSpec['kind']> = {
  [C in IpcChannelName]: (typeof IPC_CONTRACT)[C]['kind'] extends K ? C : never
}[IpcChannelName]
/** 可以用 `handle` 注册的通道（`ipcRenderer.invoke`）。 */
export type InvokeChannel = Channel<'invoke'>
/** 可以用 `on` 注册的通道（`ipcRenderer.send` / `sendSync`）。 */
export type SendChannel = Channel<'send' | 'sendSync'>

export const DEFAULT_DENY = '不受信任的页面'

export interface OnOptions {
  /** window 档：不要求窗口的 webContents 就是调用方，只要求窗口存在（终端、窗口控制的现状）。 */
  looseOwner?: true
}
export interface HandleOptions extends OnOptions {
  /** 未受信时抛出的文案，默认「不受信任的页面」。 */
  deny?: string
  /** 软失败：未受信时不抛错，改为返回它的结果（`account:get` 返回未登录、`notify:supported` 返回 false 等）。 */
  onUntrusted?: () => unknown
  /** window 档：窗口不存在或已销毁时抛出的文案；不给则按未受信处理，只要求窗口存在。 */
  noWindow?: string
}

const registered = new Set<string>()

// 卡顿诊断（docs/ui/logging.md §4.9）：处理函数的同步部分占住主进程太久就记一条；
// 还没处理完的 invoke 请求在主进程卡住时一起记下，看那会儿在忙什么；
// 刚处理完的也留 5 秒（Electron 序列化大回复发生在处理函数返回之后，卡住时那条请求已经不在 inFlight 里了）
const perf = logger('perf')
/** 同步部分超过这么久就记：这段时间主进程什么都做不了（窗口拖不动、引擎的输出也收不到） */
const SLOW_SYNC_MS = 500
/** 平时列出最近多久内结束的请求 */
const RECENT_MS = 5_000
/**
 * 环里留多久、最多留几条：比列出的窗口宽得多。主进程卡住时排队的请求常常先于日志写入处理完，
 * 写入时若按 5 秒清理，卡住前刚结束的那条（罪魁）就在日志写出前被清掉了；时间过滤留到读取时按卡住时长放宽。
 * 高频通道会把环刷满，所以另有条数上限。
 */
const RECENT_KEEP_MS = 60_000
const RECENT_MAX = 256
/** 卡住时最多列出几条最近结束的请求 */
const RECENT_LISTED = 20
const inFlight = new Map<number, { channel: string; at: number }>()
const recent: { channel: string; end: number; ms: number; size?: string }[] = []
let lastCall = 0

function timed<T>(channel: string, run: () => T): T {
  const start = performance.now()
  try {
    return run()
  } finally {
    const ms = performance.now() - start
    if (ms >= SLOW_SYNC_MS) perf.warn('IPC 处理占住了主进程', { channel, ms: Math.round(ms) })
  }
}

/**
 * 回复的粗略大小：只看顶层的长度，不遍历、不序列化（为了量大小再 JSON.stringify 一遍大对象，诊断本身就成了卡顿的来源）。
 * 字符串取字符数，二进制取字节数，数组取 length，会话快照（`{ items }` 或 `{ snapshot: { items } }`）取 items.length；认不出的不记。
 * items 只是条数，不代表体积（一条消息带几十 MB 图片 base64 也只算一条），要量体积得在产出处另记。
 */
export function roughSize(value: unknown): string | undefined {
  if (typeof value === 'string') return `chars:${value.length}`
  if (typeof value !== 'object' || value === null) return undefined
  if (Array.isArray(value)) return `len:${value.length}`
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `bytes:${value.byteLength}`
  const v = value as { items?: unknown; snapshot?: { items?: unknown } | null }
  const items = Array.isArray(v.items) ? v.items : Array.isArray(v.snapshot?.items) ? v.snapshot.items : null
  return items ? `items:${items.length}` : undefined
}

function noteDone(channel: string, start: number, result?: unknown): void {
  const end = performance.now()
  const size = roughSize(result)
  recent.push({ channel, end, ms: Math.round(end - start), ...(size ? { size } : {}) })
  let drop = 0
  while (drop < recent.length && end - recent[drop].end > RECENT_KEEP_MS) drop++
  drop = Math.max(drop, recent.length - RECENT_MAX)
  if (drop > 0) recent.splice(0, drop)
}

/**
 * 给一次调用计时并登记：处理期间列在 ipcInFlight 里，结束后（含失败）记进最近结束的列表。
 * 窗口的 invoke 通道（handle）和手机网关的调用（通道名加 `mobile:` 前缀）都走这里。
 */
export function track<T>(channel: string, run: () => T): T {
  const id = ++lastCall
  const start = performance.now()
  inFlight.set(id, { channel, at: start })
  const done = (result?: unknown): void => {
    inFlight.delete(id)
    try {
      noteDone(channel, start, result)
    } catch {
      /* 诊断出错不能把已经成功的请求变成失败 */
    }
  }
  let result: T
  try {
    result = timed(channel, run)
  } catch (err) {
    done()
    throw err
  }
  if (result instanceof Promise)
    return result.then(
      value => {
        done(value)
        return value
      },
      (err: unknown) => {
        done()
        throw err
      },
    ) as T
  done(result)
  return result
}

/** 还没处理完的 invoke 请求，最近开始的在前（最多 10 个） */
export function ipcInFlight(): { channel: string; ms: number }[] {
  const now = performance.now()
  return [...inFlight.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, 10)
    .map(c => ({ channel: c.channel, ms: Math.round(now - c.at) }))
}

/**
 * 最近 5 秒内处理完的请求，最近结束的在前（最多 20 条）：通道、结束距今多久、处理花了多久、回复的粗略大小。
 * 卡住的日志是卡住结束后才写的，`extraMs` 传卡了多久，把卡住期间结束的也算进来；
 * 这时「卡住开始前最后结束的那条」（回复序列化多半就是它造成的）一定列出来，不被卡住期间排队的请求挤出 20 条的上限。
 */
export function ipcRecent(extraMs = 0): { channel: string; agoMs: number; ms: number; size?: string }[] {
  const now = performance.now()
  const kept = recent.filter(r => now - r.end <= RECENT_MS + extraMs)
  let listed = kept.slice(-RECENT_LISTED)
  if (extraMs > 0 && kept.length > RECENT_LISTED) {
    const culprit = kept.findLast(r => r.end <= now - extraMs)
    if (culprit && !listed.includes(culprit)) listed = [culprit, ...listed.slice(1)]
  }
  return listed
    .reverse()
    .map(r => ({ channel: r.channel, agoMs: Math.round(now - r.end), ms: r.ms, ...(r.size ? { size: r.size } : {}) }))
}
const contract: Readonly<Record<string, IpcChannelSpec>> = IPC_CONTRACT

function trustOf(channel: string, kinds: readonly IpcChannelSpec['kind'][]): IpcTrust {
  const spec = Object.hasOwn(contract, channel) ? contract[channel] : undefined
  if (!spec) throw new Error(`IPC 通道不在契约里：${channel}`)
  if (!kinds.includes(spec.kind)) throw new Error(`IPC 通道 ${channel} 的类型是 ${spec.kind}，不能这样注册`)
  if (registered.has(channel)) throw new Error(`IPC 通道重复注册：${channel}`)
  registered.add(channel)
  return spec.trust
}

/** 来源页面是应用自己的页面（打包后的本地文件，或开发服务器的同源页面）。 */
function trustedPage(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  try {
    const u = new URL(event.senderFrame?.url ?? '')
    if (u.protocol === 'file:') return true
    const dev = process.env.ELECTRON_RENDERER_URL
    return !!dev && !app.isPackaged && u.origin === new URL(dev).origin
  } catch {
    return false
  }
}

type Verdict = 'ok' | 'untrusted' | 'noWindow'

function check(event: IpcMainEvent | IpcMainInvokeEvent, trust: IpcTrust, opts: HandleOptions): Verdict {
  if (trust === 'none') return 'ok'
  if (!trustedPage(event)) return 'untrusted'
  if (trust === 'sender') return 'ok'
  if (event.senderFrame !== event.sender.mainFrame) return 'untrusted'
  if (trust === 'frame') return 'ok'
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || (opts.noWindow !== undefined && win.isDestroyed()))
    return opts.noWindow !== undefined ? 'noWindow' : 'untrusted'
  if (!opts.looseOwner && win.webContents !== event.sender) return 'untrusted'
  return 'ok'
}

/**
 * 注册 `ipcMain.handle` 通道：先按契约的信任档校验，通过后才调用 `fn`。
 * `fn` 的参数列表由各注册点自己声明（具体类型），这里用 `never[]` 接受任意参数列表；转发时的 IPC 参数不做类型保证。
 */
export function handle(
  channel: InvokeChannel,
  fn: (event: IpcMainInvokeEvent, ...args: never[]) => unknown,
  opts: HandleOptions = {},
): void {
  const trust = trustOf(channel, ['invoke'])
  ipcMain.handle(channel, (event, ...args) => {
    const verdict = check(event, trust, opts)
    if (verdict === 'noWindow') throw new Error(opts.noWindow)
    if (verdict === 'untrusted') {
      if (opts.onUntrusted) return opts.onUntrusted()
      throw new Error(opts.deny ?? DEFAULT_DENY)
    }
    return track(channel, () => fn(event, ...(args as never[])))
  })
}

/** 注册 `ipcMain.on` 通道（`send` / `sendSync`）：未受信的调用静默忽略。 */
export function on(
  channel: SendChannel,
  fn: (event: IpcMainEvent, ...args: never[]) => void,
  opts: OnOptions = {},
): void {
  const trust = trustOf(channel, ['send', 'sendSync'])
  ipcMain.on(channel, (event, ...args) => {
    if (check(event, trust, opts) === 'ok') timed(channel, () => fn(event, ...(args as never[])))
  })
}
