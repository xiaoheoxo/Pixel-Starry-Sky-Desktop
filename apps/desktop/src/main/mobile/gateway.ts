// 手机网关（docs/mobile-remote.md §4、§5）：处理中转转来的帧。不依赖 electron，测试见 gateway.test.ts。
// - 配对：核对二维码密钥算的校验码 → 等用户在电脑上确认 → 记下手机公钥；
// - 握手：只和已配对的手机做 Noise KK，之后一部手机一条加密通道 + 一个 RpcCore；
// - 调用：只放行契约里标了 mobile 的通道，「只看」的手机不能调 act 的；参数先清洗（不能放宽权限、改线路）；
// - 事件：和窗口看到的同一份；会话事件只推给打开着这个会话的手机，会话列表合并节流。
// - 网关自己的几个调用（不在契约里）：hello、unwatch、defaults、search、image（docs/mobile-remote.md §17）；
//   工具（Git / 文件 / 产物 / 任务）和加项目也由网关放行（PHONE_TOOLS、directories、addProject，§18.4）。
import {
  EFFORTS,
  ENGINES,
  IPC_CONTRACT,
  SESSION_TITLE_LIMIT,
  type Effort,
  type EngineCaps,
  type EngineCatalog,
  type EngineId,
  type HostEvent,
  type ImageAttachment,
  type ArtifactResponse,
  type IpcChannelSpec,
  type Item,
  type OpenedSession,
  type ProjectRecord,
  type SearchResponse,
  type SearchResult,
  type SessionSummary,
} from '@pixelsky/protocol'
import {
  FrameType,
  LINK_VERSION,
  PROLOGUE,
  Responder,
  RpcCore,
  SecureChannel,
  decodeFrame,
  decodeJson,
  encodeFrame,
  encodeJson,
  encodeOffer,
  fingerprint,
  fromBase64Url,
  newPairingSecret,
  toBase64Url,
  verifyPairRequest,
  type Codec,
  type PairStatus,
} from '@pixelsky/link'
import type { EngineCall } from '../app/context'
import type { DirectoryChoices } from '../core/directories'
import { slimForPhone } from '../core/engine/tail'
import type { MobilePairing } from '../../shared/types/mobile'
import type { GitDiff } from '../../shared/types/project-tools'
import type { FileDocument } from '../../shared/types/workspace'
import { phoneDiff, PHONE_DIFF_LIMIT, type PhoneDiff } from './diff'
import { PushScheduler, pushChanges, waitingCount, type PushPayload } from './push'
import type { MobileStore } from './store'

const contract: Readonly<Record<string, IpcChannelSpec>> = IPC_CONTRACT
type MobileAccess = NonNullable<IpcChannelSpec['mobile']>

/** 二维码有效期 */
export const PAIRING_TTL = 5 * 60_000
/** 每部手机最多同时盯几个会话的实时事件 */
const MAX_WATCHED = 4
/** 会话列表推送的节流间隔 */
const SESSIONS_THROTTLE = 500
/**
 * 流式增量攒这么久打包成一帧发（云端每条连接限 500 帧/秒，docs/mobile-remote.md §17.4）；
 * 只对 hello 时说了能拆包的手机这样做
 */
export const DELTA_BATCH = 100
/** 攒着的增量超过这么多字符就立刻发，一帧不会太大（单帧 1 MB，中文转义后会变长） */
const DELTA_BATCH_CHARS = 64_000
/**
 * 这么久没收到手机的任何消息：当它不在前台（突然断网时中转要等心跳超时才发现），照样推送提醒。
 * 新版手机在前台时每 20 秒说一次 away(false)
 */
const SILENT_AFTER = 45_000
/** 推给手机的会话列表最多几条（去掉归档，按更新时间） */
const MAX_SESSIONS = 200
/** 搜索对话内容最多回几条 */
const MAX_SEARCH = 30
/** 单张图片的 base64 不超过这么长才整张发（单帧 1 MB，压缩加密后留余量）；更大的先缩小 */
export const IMAGE_INLINE = 700_000
/** 缩小图片时依次试的长边 */
const SHRINK_EDGES = [2048, 1600, 1200, 800]
/** 手机打开的文本文件最多发这么多字符（按行截断） */
export const PHONE_TEXT_LIMIT = 500_000
/** 产物最多回几轮、几个交付 */
const MAX_ARTIFACTS = 100

export interface GatewayDeps {
  store: Pick<MobileStore, 'desktopId' | 'device' | 'devices' | 'addDevice' | 'touch' | 'keypair'>
  desktopName(): string
  relay(): string
  /** 手机网页版的地址：二维码做成这个地址的链接，手机相机扫了直接打开；null 时二维码是 pixelsky:// */
  web?(): string | null
  call: EngineCall
  /** 经中转发一帧给手机 */
  send(phone: string, frame: Uint8Array): void
  codec: Codec
  /**
   * 云端的设备管理（M2，services/cloud 的 /v1/bridge/*）：配对码、确认、移除。
   * 为 null 时（单元测试、本机测试中转）不经过云端，二维码里没有配对码。
   */
  cloud: CloudDevices | null
  /** 配对状态、在线状态变了（设置页刷新） */
  changed(): void
  now?(): number
  /** 推送提醒攒多久合成一条、两条至少隔多久（测试改短），默认 PUSH_DELAY / PUSH_GAP */
  pushTiming?: { delay: number; gap: number }
  /**
   * 本机引擎宿主上的只读查询（手机的「默认引擎」「搜索对话内容」）。契约里的 engine:defaults、engine:search
   * 跟着电脑界面当前选中的机器走，手机没法指定，所以只查本机；没有时手机退回自己的做法。
   */
  local?: LocalQueries | null
  /** 把一张图缩小成 JPEG（Electron 的 nativeImage）；解不开时返回 null。没有时取不到超过单帧的图 */
  shrinkImage?(image: ImageAttachment, maxEdge: number): ImageAttachment | null
}

export interface LocalQueries {
  defaultEngine(): EngineId
  search(text: string, projectId: string | null, signal: AbortSignal): Promise<SearchResponse>
  /** 加项目时列这台电脑上的目录（不传时从主目录开始） */
  directories?(path: string | null): Promise<DirectoryChoices>
  /** 把这台电脑上的一个目录加成项目 */
  addProject?(path: string): ProjectRecord | Promise<ProjectRecord>
}

/** 手机搜索对话内容的结果 */
export interface PhoneSearch {
  results: SearchResult[]
  truncated: boolean
}

export interface CloudDevices {
  pairing(): Promise<{ code: string; expiresAt: number }>
  confirm(phone: string): Promise<void>
  remove(phone: string): Promise<void>
  /** 网页推送（§22.2）：请云端推给这部手机；手机没登记推送时云端什么都不做 */
  push?(phone: string, payload: PushPayload): Promise<void>
}

interface Peer {
  phone: string
  channel: SecureChannel
  rpc: RpcCore
  watching: string[]
  /** 进行中的搜索：新的搜索来了就取消它 */
  search?: AbortController
  /** 电脑上已经吊销：回完这一次就断开 */
  revoked?: boolean
  /** 手机页面切到后台了（它自己说的）：照样推送提醒 */
  away?: boolean
  /** 最后一次收到这部手机的消息 */
  heardAt?: number
  /** 手机能拆开打包成一帧的多个事件（hello 时说的）；旧版手机不能，事件照旧一条一帧 */
  batch?: boolean
  /** 攒着还没发的会话事件 */
  pending?: SessionEvent[]
  pendingChars?: number
  flushTimer?: ReturnType<typeof setTimeout>
}

type SessionEvent = Extract<HostEvent, { kind: 'session' }>

interface Pairing {
  secret: string
  offer: string
  expires: number
  status: MobilePairing['status']
  request: { phone: string; publicKey: Uint8Array; name: string } | null
}

/** 手机看到的会话列表：不含归档，最近更新的在前，最多 200 条 */
export function phoneSessions(list: readonly SessionSummary[]): SessionSummary[] {
  return list
    .filter(s => !s.record.archivedAt)
    .sort((a, b) => b.record.updatedAt - a.record.updatedAt)
    .slice(0, MAX_SESSIONS)
}

const asString = (v: unknown, max = 200): string => {
  if (typeof v !== 'string' || !v || v.length > max) throw new Error('MOBILE_BAD_ARGUMENT')
  return v
}

// ---------------------------------------------------------------------------
// 工具（docs/mobile-remote.md §18.4）
// ---------------------------------------------------------------------------

/** 项目或会话（第一个参数）：只认 { projectId } / { sessionId }，跟着它所在的机器走 */
function workspaceArg(v: unknown): { projectId: string } | { sessionId: string } {
  const o = (v ?? {}) as Record<string, unknown>
  return typeof o.sessionId === 'string' ? { sessionId: asString(o.sessionId) } : { projectId: asString(o.projectId) }
}

/** 项目里的相对路径，根目录是空字符串（越界由文件 / Git 那一层按项目目录校验） */
function relativePath(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string' || v.length > 4096) throw new Error('MOBILE_BAD_ARGUMENT')
  return v
}

function pathsArg(v: unknown): string[] | 'all' {
  if (v === 'all') return 'all'
  if (!Array.isArray(v) || !v.length || v.length > 1000) throw new Error('MOBILE_BAD_ARGUMENT')
  return v.map(p => asString(p, 4096))
}

const field = (o: Record<string, unknown>, key: string, max: number): Record<string, string> =>
  typeof o[key] === 'string' && (o[key] as string).length <= max ? { [key]: o[key] as string } : {}

/** 任务的字段：标题、说明、状态、优先级、截止日期（其余的不让手机改） */
function taskArg(v: unknown): Record<string, string> {
  const o = (v ?? {}) as Record<string, unknown>
  return {
    ...field(o, 'title', 200),
    ...field(o, 'note', 4000),
    ...field(o, 'status', 20),
    ...field(o, 'priority', 20),
    ...field(o, 'due', 10),
  }
}

interface PhoneTool {
  access: MobileAccess
  /** 按手机能给的重新拼参数 */
  args(args: unknown[]): unknown[]
}

/**
 * 手机能用的工具。契约里这些通道跟着电脑界面选中的机器走，不能标 mobile，所以由网关放行：
 * 参数按这里重新拼，第一个参数是项目 / 会话（和窗口同一层路由，只查它所在的机器）。
 * 写操作只有暂存、取消暂存、提交、推送（不强推）、新建 / 改任务；放弃改动、删分支、改写历史都不放行（§18.7）。
 */
export const PHONE_TOOLS: Readonly<Record<string, PhoneTool>> = {
  'files:list': { access: 'view', args: a => [workspaceArg(a[0]), relativePath(a[1])] },
  'files:read': { access: 'view', args: a => [workspaceArg(a[0]), relativePath(a[1])] },
  'projectTools:gitStatus': { access: 'view', args: a => [workspaceArg(a[0])] },
  'projectTools:gitDiff': {
    access: 'view',
    args: a => {
      const o = (a[1] ?? {}) as Record<string, unknown>
      if (!['staged', 'unstaged', 'untracked', 'conflicted'].includes(o.area as string))
        throw new Error('MOBILE_BAD_ARGUMENT')
      const origPath = typeof o.origPath === 'string' ? { origPath: asString(o.origPath, 4096) } : {}
      return [workspaceArg(a[0]), { path: asString(o.path, 4096), area: o.area, ...origPath }]
    },
  },
  'projectTools:tasks': { access: 'view', args: a => [asString(a[0])] },
  'engine:artifacts': {
    access: 'view',
    args: a => {
      const o = (a[0] ?? {}) as Record<string, unknown>
      const days = typeof o.days === 'number' && Number.isInteger(o.days) ? Math.min(30, Math.max(1, o.days)) : 7
      return [{ ...workspaceArg(o), days }]
    },
  },
  'engine:artifactChange': {
    access: 'view',
    args: a => {
      const o = (a[0] ?? {}) as Record<string, unknown>
      return [{ sessionId: asString(o.sessionId), itemId: asString(o.itemId) }]
    },
  },
  'projectTools:gitStage': { access: 'act', args: a => [workspaceArg(a[0]), pathsArg(a[1])] },
  'projectTools:gitUnstage': { access: 'act', args: a => [workspaceArg(a[0]), pathsArg(a[1])] },
  'projectTools:gitCommit': {
    access: 'act',
    args: a => {
      const o = (a[1] ?? {}) as Record<string, unknown>
      return [workspaceArg(a[0]), { message: asString(o.message, 20_000), all: o.all === true, push: o.push === true }]
    },
  },
  'projectTools:gitPush': {
    access: 'act',
    args: a => [workspaceArg(a[0]), { publish: (a[1] as { publish?: unknown } | null)?.publish === true }],
  },
  'projectTools:createTask': { access: 'act', args: a => [asString(a[0]), taskArg(a[1])] },
  'projectTools:updateTask': { access: 'act', args: a => [asString(a[0]), taskArg(a[1])] },
}

/** 手机看的 Git 改动：电脑上比好，只发改动和前后几行 */
export type PhoneGitDiff = Pick<GitDiff, 'path' | 'binary' | 'tooLarge'> & PhoneDiff

/** 文本按行截断到 limit 以内 */
function cutText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const end = text.lastIndexOf('\n', limit)
  return text.slice(0, end > 0 ? end + 1 : limit)
}

/** 手机能选的权限模式：不含 full（完全放行只能在电脑上开，docs/mobile-remote.md §21.5） */
const PHONE_MODES = ['ask', 'edits', 'plan'] as const
type PhoneMode = (typeof PHONE_MODES)[number]

/** 手机能改的会话设置（新建和修改共用）；平台、接口、引擎、fast、ultracode 不让手机动 */
export interface PhoneSettings {
  permissionMode?: PhoneMode
  /** null：用引擎默认的模型 */
  model?: string | null
  /** null：用引擎默认的强度 */
  effort?: Effort | null
  thinkingSummaries?: boolean
}

/**
 * 从一份参数里挑出手机能改的设置，别的字段一律丢掉。字段给了但值不对（包括 full）整条拒绝，不静默丢弃；
 * 值是否被这个引擎支持（权限模式、强度、模型）见 checkSettings / MobileGateway.vet
 */
export function phoneSettings(o: Record<string, unknown>): PhoneSettings {
  const out: PhoneSettings = {}
  if (o.permissionMode !== undefined) {
    if (!PHONE_MODES.includes(o.permissionMode as PhoneMode)) throw new Error('MOBILE_BAD_ARGUMENT')
    out.permissionMode = o.permissionMode as PhoneMode
  }
  if (o.model !== undefined) out.model = o.model === null ? null : asString(o.model)
  if (o.effort !== undefined) {
    if (o.effort !== null && !EFFORTS.includes(o.effort as Effort)) throw new Error('MOBILE_BAD_ARGUMENT')
    out.effort = o.effort as Effort | null
  }
  if (o.thinkingSummaries !== undefined) {
    if (typeof o.thinkingSummaries !== 'boolean') throw new Error('MOBILE_BAD_ARGUMENT')
    out.thinkingSummaries = o.thinkingSummaries
  }
  return out
}

/** 引擎能力表认不认这些设置：权限模式要在 caps.permissionModes 里、强度在 caps.efforts 里、思考摘要要引擎有这个开关 */
export function checkSettings(caps: EngineCaps, s: PhoneSettings): void {
  if (s.permissionMode !== undefined && !caps.permissionModes.includes(s.permissionMode))
    throw new Error('MOBILE_BAD_ARGUMENT')
  if (s.effort && !caps.efforts.includes(s.effort)) throw new Error('MOBILE_BAD_ARGUMENT')
  if (s.thinkingSummaries !== undefined && !caps.thinkingSummaries) throw new Error('MOBILE_BAD_ARGUMENT')
}

const asBoolean = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new Error('MOBILE_BAD_ARGUMENT')
  return v
}

const asEngine = (v: unknown): EngineId => {
  if (v !== 'claude' && v !== 'codex' && v !== 'pixel') throw new Error('MOBILE_BAD_ARGUMENT')
  return v
}

/** 会话标题：去首尾空白、非空、不含控制字符、不超过桌面重命名的上限 */
function asTitle(v: unknown): string {
  if (typeof v !== 'string') throw new Error('MOBILE_BAD_ARGUMENT')
  const title = v.trim()
  // eslint-disable-next-line no-control-regex -- 故意匹配控制字符：和桌面一样不让标题带换行
  if (!title || /[\u0000-\u001f\u007f]/.test(title) || Array.from(title).length > SESSION_TITLE_LIMIT)
    throw new Error('MOBILE_BAD_ARGUMENT')
  return title
}

/** 手机传来的参数：只留手机该给的字段，其余由电脑上的设置决定（线路、平台、引擎用电脑上的；权限模式、模型、强度只认 phoneSettings 那几项） */
export function sanitize(method: string, args: unknown[]): unknown[] {
  switch (method) {
    case 'engine:createSession': {
      const o = (args[0] ?? {}) as Record<string, unknown>
      const engine = o.engine === 'claude' || o.engine === 'codex' || o.engine === 'pixel' ? { engine: o.engine } : {}
      return [{ projectId: asString(o.projectId), ...engine, ...phoneSettings(o) }]
    }
    case 'engine:updateSession': {
      const patch = phoneSettings((args[1] ?? {}) as Record<string, unknown>)
      // 一项都没留下（只给了被丢弃的字段）：没东西可改，报错让手机知道
      if (!Object.keys(patch).length) throw new Error('MOBILE_BAD_ARGUMENT')
      // 第三个参数告诉电脑这是手机改的，会话里留一条记录（ops.ts 的 engine:updateSession）
      return [asString(args[0]), patch, 'mobile']
    }
    case 'engine:catalog':
      return [asEngine(args[0])]
    case 'engine:renameSession':
      return [asString(args[0]), asTitle(args[1])]
    case 'engine:setSessionPinned':
      return [asString(args[0]), asBoolean(args[1])]
    case 'engine:archiveSession':
      return [asString(args[0]), asBoolean(args[1]), args[2] === undefined ? false : asBoolean(args[2])]
    case 'engine:send': {
      const input = args[1]
      if (typeof input === 'string') return [args[0], asString(input, 100_000)]
      const o = (input ?? {}) as Record<string, unknown>
      return [
        args[0],
        {
          text: typeof o.text === 'string' ? o.text.slice(0, 100_000) : '',
          clientMessageId: asString(o.clientMessageId),
          ...(Array.isArray(o.attachments) ? { attachments: o.attachments.slice(0, 5) } : {}),
        },
      ]
    }
    default:
      return args
  }
}

export class MobileGateway {
  private readonly peers = new Map<string, Peer>()
  private pairing: Pairing | null = null
  private sessionsTimer: ReturnType<typeof setTimeout> | null = null
  private latestSessions: SessionSummary[] | null = null
  /** 产物扫描的请求号 */
  private scans = 0
  /** 上一次的会话列表：和这次比，算出要推送的提醒 */
  private pushPrev: SessionSummary[] | null = null
  private readonly pushes: PushScheduler

  constructor(private readonly d: GatewayDeps) {
    this.pushes = new PushScheduler(
      (phone, payload) => d.cloud?.push?.(phone, payload) ?? Promise.resolve(),
      d.pushTiming?.delay,
      d.pushTiming?.gap,
      () => this.now(),
      () => waitingCount(this.pushPrev),
    )
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  online(phone: string): boolean {
    return this.peers.has(phone)
  }

  // -------------------------------------------------------------------------
  // 配对
  // -------------------------------------------------------------------------

  pairingState(): MobilePairing | null {
    const p = this.pairing
    if (!p) return null
    const status = p.status === 'waiting' && this.now() > p.expires ? 'expired' : p.status
    return {
      offer: p.offer,
      expires: p.expires,
      status,
      request: p.request ? { name: p.request.name, fingerprint: fingerprint(p.request.publicKey) } : null,
    }
  }

  async startPairing(): Promise<MobilePairing> {
    const key = this.d.store.keypair()
    if (!key) throw new Error('MOBILE_NO_CIPHER')
    const relay = this.d.relay()
    if (!relay) throw new Error('MOBILE_BAD_RELAY')
    // 云端的配对码：手机拿它换设备令牌；二维码和配对码同时过期
    const cloud = this.d.cloud ? await this.d.cloud.pairing() : null
    const secret = newPairingSecret(),
      expires = cloud ? Math.min(cloud.expiresAt, this.now() + PAIRING_TTL) : this.now() + PAIRING_TTL
    const offer = encodeOffer(
      {
        v: LINK_VERSION,
        relay,
        desktop: this.d.store.desktopId,
        key: toBase64Url(key.publicKey),
        secret,
        name: this.d.desktopName().slice(0, 64),
        expires,
        ...(cloud ? { code: cloud.code } : {}),
      },
      this.d.web?.() ?? undefined,
    )
    this.pairing = { secret, offer, expires, status: 'waiting', request: null }
    return this.pairingState()!
  }

  cancelPairing(): void {
    const request = this.pairing?.request
    if (request && this.pairing?.status === 'confirm') this.reject(request.phone)
    this.pairing = null
  }

  /** 拒绝一部扫了码的手机：告诉它，并让云端作废它的设备令牌（尽力而为，云端的待确认设备 10 分钟后也会过期） */
  private reject(phone: string): void {
    this.pairResult(phone, 'rejected')
    void this.d.cloud?.remove(phone).catch(() => {})
  }

  /** 用户在电脑上确认或拒绝扫码的手机 */
  async decide(accept: boolean): Promise<void> {
    const p = this.pairing
    if (!p?.request || p.status !== 'confirm') throw new Error('MOBILE_NO_PAIRING')
    const { phone, publicKey, name } = p.request
    if (!accept) {
      p.status = 'rejected'
      this.reject(phone)
      this.d.changed()
      return
    }
    // 先让云端放行（待确认的手机只能发配对请求），再记下来、告诉手机
    await this.d.cloud?.confirm(phone)
    if (this.pairing !== p) return
    {
      this.d.store.addDevice({
        id: phone,
        name,
        publicKey: toBase64Url(publicKey),
        access: 'act',
        pairedAt: this.now(),
      })
      p.status = 'accepted'
    }
    this.pairResult(phone, 'accepted')
    this.d.changed()
  }

  private pairResult(phone: string, status: PairStatus): void {
    try {
      this.d.send(
        phone,
        encodeFrame(
          FrameType.PairResult,
          encodeJson(status === 'handshake_failed' ? { status, v: LINK_VERSION } : { status }),
        ),
      )
    } catch {}
  }

  private onPair(phone: string, body: Uint8Array): void {
    const p = this.pairing,
      key = this.d.store.keypair()
    let request: unknown
    try {
      request = decodeJson(body)
    } catch {
      return
    }
    // 已经允许过的手机又发来配对请求：「允许」结果帧只发一次，手机当时不在线（锁屏、切走、中转在重连）就没收到，
    // 重连后会重发请求。公钥和记下的一致就再回一次（审查报告 2026-10-14）；不一致照常走下面的配对流程
    const known = this.d.store.device(phone)
    if (known && (request as { key?: unknown } | null)?.key === known.publicKey) {
      this.pairResult(phone, 'accepted')
      return
    }
    // 没在配对、过期、已经有一部在等确认：不理（不回结果，免得被拿来探测）
    if (!p || !key || p.status !== 'waiting' || this.now() > p.expires) return
    const verified = verifyPairRequest(request, p.secret, key.publicKey)
    if (!verified) return
    p.request = { phone, ...verified }
    p.status = 'confirm'
    this.pairResult(phone, 'pending')
    this.d.changed()
  }

  // -------------------------------------------------------------------------
  // 帧、握手、调用
  // -------------------------------------------------------------------------

  receive(phone: string, frame: Uint8Array): void {
    let decoded: ReturnType<typeof decodeFrame>
    try {
      decoded = decodeFrame(frame)
    } catch {
      return
    }
    if (decoded.type === FrameType.Pair) this.onPair(phone, decoded.body)
    else if (decoded.type === FrameType.Handshake1) this.onHandshake(phone, decoded.body)
    else if (decoded.type === FrameType.Data) {
      const peer = this.peers.get(phone)
      if (!peer) return
      peer.heardAt = this.now()
      peer.channel.receive(decoded.body)
    }
  }

  private onHandshake(phone: string, body: Uint8Array): void {
    const device = this.d.store.device(phone),
      key = this.d.store.keypair()
    // 只是提示：结果帧不加密，手机不会因此删掉配对
    if (!key) return this.pairResult(phone, 'unavailable')
    if (!device) return this.pairResult(phone, 'unknown')
    let message: Uint8Array, keys
    try {
      const responder = new Responder({ local: key, remote: fromBase64Url(device.publicKey), prologue: PROLOGUE })
      responder.readMessage1(body)
      ;({ message, result: keys } = responder.writeMessage2())
    } catch {
      // 解不开（密钥对不上或版本不一致）：回一声，手机不用干等
      return this.pairResult(phone, 'handshake_failed')
    }
    this.drop(phone)
    let rpc: RpcCore | null = null
    const channel = new SecureChannel(
      keys,
      f => this.d.send(phone, f),
      value => rpc?.receive(value),
      () => this.drop(phone, peer),
      this.d.codec,
    )
    rpc = new RpcCore(
      out => {
        channel.send(out).then(
          // 被吊销的手机：把「已吊销」的回复发出去之后再断开
          () => peer.revoked && this.drop(phone, peer),
          (error: Error) => {
            // 回复太大：告诉手机这次调用失败，而不是让它一直等到超时
            if (error.message === 'LINK_FRAME_TOO_LARGE' && 'result' in out)
              void channel.send({ id: out.id, error: 'MOBILE_TOO_LARGE' }).catch(() => {})
          },
        )
      },
      (method, args) => this.handle(peer, method, args),
    )
    const peer: Peer = { phone, channel, rpc, watching: [], heardAt: this.now() }
    rpc.onClose = () => this.drop(phone, peer)
    this.peers.set(phone, peer)
    try {
      this.d.send(phone, encodeFrame(FrameType.Handshake2, message))
    } catch {
      this.drop(phone, peer)
      return
    }
    this.d.store.touch(phone, this.now())
    this.d.changed()
  }

  private async handle(peer: Peer, method: string, args: unknown[]): Promise<unknown> {
    const device = this.d.store.device(peer.phone)
    if (!device) {
      peer.revoked = true
      throw new Error('MOBILE_REVOKED')
    }
    // tools：这台电脑能给手机用工具和加项目（§18.4），旧版没有这个字段；
    // queueMoveBefore：认得队列调序的 { before }，旧版没有，手机据此决定发对象还是数字下标
    if (method === 'hello') {
      peer.batch = (args[0] as { batch?: unknown } | undefined)?.batch === true
      // 新连上的页面在前台：断开时排上的提醒不用推了（在后台连上的手机会接着说 away）
      this.pushes.cancel(peer.phone)
      return {
        version: LINK_VERSION,
        name: this.d.desktopName(),
        access: device.access,
        tools: true,
        queueMoveBefore: true,
      }
    }
    // 页面切到后台 / 回到前台（§22.2）：后台时照样推送提醒；旧版电脑不认这个方法，手机不管报错
    if (method === 'away') {
      peer.away = args[0] === true
      if (!peer.away) this.pushes.cancel(peer.phone)
      return null
    }
    if (method === 'unwatch') {
      peer.watching = peer.watching.filter(id => id !== args[0])
      return null
    }
    if (method === 'defaults') return { engine: this.d.local?.defaultEngine() ?? null }
    if (method === 'search') return this.search(peer, args)
    if (method === 'image') return this.image(peer, args)
    if (method === 'directories' || method === 'addProject') return this.project(device.access, method, args)
    const tool = Object.hasOwn(PHONE_TOOLS, method) ? PHONE_TOOLS[method] : undefined
    if (tool) {
      if (tool.access === 'act' && device.access !== 'act') throw new Error('MOBILE_FORBIDDEN')
      const clean = tool.args(args)
      // 产物扫描按调用方分桶，同一部手机新的会取消上一次
      if (method === 'engine:artifacts') clean[0] = { ...(clean[0] as object), requestId: ++this.scans }
      return this.toolResult(method, await this.d.call(method, clean, 'mobile:' + peer.phone))
    }
    const spec = Object.hasOwn(contract, method) ? contract[method] : undefined
    if (!spec?.mobile) throw new Error('MOBILE_UNSUPPORTED')
    if (spec.mobile === 'act' && device.access !== 'act') throw new Error('MOBILE_FORBIDDEN')
    const clean = sanitize(method, args)
    const owner = 'mobile:' + peer.phone
    if (method === 'engine:updateSession' || method === 'engine:createSession') await this.vet(method, clean, owner)
    if (method === 'engine:openSessionTail') {
      // 先登记再取快照：取快照期间到的事件也推过去，手机按 seq 丢掉重复的
      const id = asString(args[0])
      peer.watching = [...peer.watching.filter(w => w !== id), id].slice(-MAX_WATCHED)
    }
    const result = await this.d.call(method, clean, owner)
    if (method === 'engine:sessions') return phoneSessions(result as SessionSummary[])
    return result
  }

  /**
   * 手机要改 / 新建时带的设置，对着这个会话（新会话是将要用的）引擎的能力表和模型目录再核一遍：
   * 不支持的权限模式、强度、思考摘要，不在目录里的模型，整条拒绝。sanitize 已经拦掉了 full
   */
  private async vet(method: string, clean: unknown[], owner: string): Promise<void> {
    let engine: EngineId, settings: PhoneSettings
    if (method === 'engine:updateSession') {
      // 引擎以电脑上这个会话记录里的为准，手机不能改引擎；运行中选了下一个引擎还没生效时，设置算它的（engine/host/sessions.ts）
      const sessions = (await this.d.call('engine:sessions', [], owner)) as SessionSummary[]
      const record = sessions.find(s => s.record.id === clean[0])?.record
      if (!record) throw new Error('MOBILE_NOT_FOUND')
      engine = record.nextEngine ?? record.engine
      settings = clean[1] as PhoneSettings
      // 用自定义接口的会话：模型来自那个接口，不在引擎目录里，手机不能改（docs/mobile-remote.md §23.5）
      if (record.provider && settings.model !== undefined) throw new Error('MOBILE_BAD_ARGUMENT')
    } else {
      const create = clean[0] as { engine?: EngineId }
      settings = phoneSettings(create)
      if (!Object.keys(settings).length) return
      // 手机没指定引擎时用电脑上的默认引擎，并写明在参数里，核对的和实际用的是同一个
      engine = create.engine ?? this.d.local?.defaultEngine() ?? 'claude'
      create.engine = engine
    }
    checkSettings(ENGINES[engine].caps, settings)
    if (typeof settings.model === 'string') {
      const catalog = (await this.d.call('engine:catalog', [engine], owner)) as EngineCatalog | null
      if (!catalog?.models?.some(m => m.id === settings.model)) throw new Error('MOBILE_BAD_ARGUMENT')
    }
  }

  /** 工具的结果放进一帧：Git 改动比成 diff、大文件截断、大图缩小、产物只留最近的 */
  private toolResult(method: string, result: unknown): unknown {
    if (method === 'projectTools:gitDiff') {
      const r = result as GitDiff
      return { path: r.path, binary: r.binary, tooLarge: r.tooLarge, ...phoneDiff(r.original, r.modified) }
    }
    if (method === 'files:read') return this.phoneFile(result as FileDocument)
    if (method === 'engine:artifacts') {
      const r = result as ArtifactResponse
      return {
        ...r,
        turns: r.turns.slice(0, MAX_ARTIFACTS),
        delivered: r.delivered.slice(0, MAX_ARTIFACTS),
        truncated: r.truncated || r.turns.length > MAX_ARTIFACTS || r.delivered.length > MAX_ARTIFACTS,
      }
    }
    if (method === 'engine:artifactChange' && result) {
      const item = result as Extract<Item, { kind: 'file_change' }>
      const each = Math.floor(PHONE_DIFF_LIMIT / Math.max(1, item.changes.length))
      return { ...item, changes: item.changes.map(c => ({ ...c, diff: cutText(c.diff, each) })) }
    }
    return result
  }

  /** 手机打开的文件：长文本截断（标 cut），大图缩小，缩不了就说太大 */
  private phoneFile(doc: FileDocument): FileDocument | (FileDocument & { cut: true }) {
    if (doc.kind === 'text' && doc.content.length > PHONE_TEXT_LIMIT)
      return { ...doc, content: cutText(doc.content, PHONE_TEXT_LIMIT), readonly: true, cut: true }
    if (doc.kind !== 'image' || doc.dataUrl.length <= IMAGE_INLINE) return doc
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(doc.dataUrl)
    const image: ImageAttachment | null = m && {
      id: 'file',
      name: doc.path,
      mediaType: m[1] as ImageAttachment['mediaType'],
      bytes: doc.bytes,
      width: 0,
      height: 0,
      dataBase64: m[2],
    }
    for (const edge of image ? SHRINK_EDGES : []) {
      const small = this.d.shrinkImage?.(image!, edge)
      if (!small) break
      if (small.dataBase64.length <= IMAGE_INLINE)
        return { ...doc, dataUrl: `data:${small.mediaType};base64,${small.dataBase64}` }
    }
    return { kind: 'unsupported', path: doc.path, reason: '图片太大，请到电脑上看', bytes: doc.bytes }
  }

  /** 加项目：列这台电脑上的目录、把选的目录加成项目（只在这台电脑上，不经 SSH 机器） */
  private async project(access: MobileAccess, method: string, args: unknown[]): Promise<unknown> {
    if (access !== 'act') throw new Error('MOBILE_FORBIDDEN')
    const local = this.d.local
    if (method === 'directories') {
      if (!local?.directories) throw new Error('MOBILE_UNSUPPORTED')
      return local.directories(args[0] ? asString(args[0], 4096) : null)
    }
    if (!local?.addProject) throw new Error('MOBILE_UNSUPPORTED')
    return local.addProject(asString(args[0], 4096))
  }

  /** 搜索本机会话的对话内容（标题在手机上自己筛）；同一部手机新的搜索会取消上一次 */
  private async search(peer: Peer, args: unknown[]): Promise<PhoneSearch> {
    const local = this.d.local
    if (!local) throw new Error('MOBILE_UNSUPPORTED')
    const text = typeof args[0] === 'string' ? args[0].trim().slice(0, 200) : ''
    const projectId = typeof args[1] === 'string' && args[1] ? asString(args[1]) : null
    peer.search?.abort()
    peer.search = undefined
    if (!text) return { results: [], truncated: false }
    const controller = new AbortController()
    peer.search = controller
    try {
      const r = await local.search(text, projectId, controller.signal)
      return { results: r.results.slice(0, MAX_SEARCH), truncated: r.truncated || r.results.length > MAX_SEARCH }
    } finally {
      if (peer.search === controller) peer.search = undefined
    }
  }

  /**
   * 一条消息里的一张图（用户发的图、工具结果里的图）：会话尾部和推送事件里图片都被去掉了，点开时再取。
   * 放得下一帧就整张发，放不下就缩小成 JPEG；缩小不了报 MOBILE_TOO_LARGE。
   */
  private async image(peer: Peer, args: unknown[]): Promise<ImageAttachment> {
    const sessionId = asString(args[0]),
      itemId = asString(args[1]),
      index = args[2]
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 100)
      throw new Error('MOBILE_BAD_ARGUMENT')
    const opened = (await this.d.call('engine:openSession', [sessionId], 'mobile:' + peer.phone)) as OpenedSession
    const item = opened.snapshot.items.find(i => i.id === itemId)
    const images = item?.kind === 'user' ? item.attachments : item?.kind === 'tool' ? item.images : undefined
    const image = images?.[index]
    if (!image?.dataBase64) throw new Error('MOBILE_NOT_FOUND')
    if (image.dataBase64.length <= IMAGE_INLINE) return image
    for (const edge of SHRINK_EDGES) {
      const small = this.d.shrinkImage?.(image, edge)
      if (!small) break
      if (small.dataBase64.length <= IMAGE_INLINE) return small
    }
    throw new Error('MOBILE_TOO_LARGE')
  }

  // -------------------------------------------------------------------------
  // 事件、断开
  // -------------------------------------------------------------------------

  /** EventBus 的 tap：窗口收到什么，这里就看到什么 */
  hostEvent(channel: string, args: unknown[]): void {
    if (channel === 'engine:event' && (args[0] as HostEvent | undefined)?.kind === 'sessions')
      this.remind((args[0] as Extract<HostEvent, { kind: 'sessions' }>).sessions)
    if (!this.peers.size) return
    // 任务、Git 状态变了（电脑上已经合并过）：手机上开着的工具页重新取。
    // 手机只看事件内容不看通道名，旧版手机认不得 kind: 'tools'，会直接忽略
    if (channel === 'projectTools:changed') {
      for (const peer of this.peers.values()) peer.rpc.event('projectTools:changed', { kind: 'tools' })
      return
    }
    if (channel !== 'engine:event') return
    const event = args[0] as HostEvent
    if (event.kind === 'session') {
      let slim: SessionEvent | null = null
      for (const peer of this.peers.values())
        if (peer.watching.includes(event.sessionId)) this.sessionEvent(peer, (slim ??= slimForPhone(event)))
    } else if (event.kind === 'sessions') {
      this.latestSessions = event.sessions
      this.sessionsTimer ??= setTimeout(() => {
        this.sessionsTimer = null
        const sessions = this.latestSessions
        this.latestSessions = null
        if (!sessions) return
        const data = slimForPhone({ kind: 'sessions', sessions: phoneSessions(sessions) })
        for (const peer of this.peers.values()) peer.rpc.event('engine:event', data)
      }, SESSIONS_THROTTLE)
    } else if (event.kind === 'projects') {
      for (const peer of this.peers.values()) peer.rpc.event('engine:event', event)
    }
  }

  /**
   * 会话事件：流式增量攒一会儿，打包成一帧发；别的事件（审批、状态、条目完成）到了先发攒着的，再立刻发它，顺序不变。
   * 不合并增量的内容：手机按 seq 一条条应用（apps/mobile/src/data/session.ts）
   */
  private sessionEvent(peer: Peer, event: SessionEvent): void {
    if (!peer.batch) {
      peer.rpc.event('engine:event', event)
      return
    }
    if (event.event.type !== 'item_delta') {
      // 先发攒着的，再单独发这一条：它可能很大（条目完成带整段输出），不和增量挤一帧
      this.flush(peer)
      peer.rpc.event('engine:event', event)
      return
    }
    ;(peer.pending ??= []).push(event)
    peer.pendingChars = (peer.pendingChars ?? 0) + event.event.delta.length
    if (peer.pendingChars >= DELTA_BATCH_CHARS) this.flush(peer)
    else peer.flushTimer ??= setTimeout(() => this.flush(peer), DELTA_BATCH)
  }

  private flush(peer: Peer): void {
    if (peer.flushTimer) clearTimeout(peer.flushTimer)
    peer.flushTimer = undefined
    const events = peer.pending ?? []
    peer.pending = undefined
    peer.pendingChars = 0
    if (events.length === 1) peer.rpc.event('engine:event', events[0])
    else if (events.length) peer.rpc.event('engine:event', { kind: 'batch', events })
  }

  /** 会话列表变了：有新的「等你处理 / 完成 / 出错」时，推给不在线或页面在后台的手机 */
  private remind(sessions: SessionSummary[]): void {
    if (!this.d.cloud?.push) return
    const changes = pushChanges(this.pushPrev, sessions)
    this.pushPrev = sessions
    for (const device of this.d.store.devices) {
      const peer = this.peers.get(device.id)
      if (!peer || peer.away || this.now() - (peer.heardAt ?? 0) > SILENT_AFTER) this.pushes.add(device.id, changes)
    }
  }

  /** 中转说这部手机断开了 */
  phoneLeft(phone: string): void {
    this.drop(phone)
  }

  /** 到中转的连接断了：所有加密会话作废，手机重连后重新握手 */
  dropAll(): void {
    for (const phone of [...this.peers.keys()]) this.drop(phone)
    if (this.pairing?.status === 'confirm') this.pairing = null
  }

  /** 电脑上移除了这部手机：告诉它（手机显示「已被电脑移除」、不再自动重连），再断开 */
  revoke(phone: string): void {
    this.reject(phone)
    this.drop(phone)
  }

  /** 断开这部手机的加密会话（手机可以重新握手） */
  drop(phone: string, only?: Peer): void {
    const peer = this.peers.get(phone)
    if (!peer || (only && peer !== only)) return
    this.peers.delete(phone)
    if (peer.flushTimer) clearTimeout(peer.flushTimer)
    peer.search?.abort()
    peer.channel.fail(new Error('MOBILE_DISCONNECTED'))
    peer.rpc.close()
    this.d.changed()
  }

  close(): void {
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer)
    this.sessionsTimer = null
    this.pushes.close()
    this.dropAll()
    this.pairing = null
  }
}
