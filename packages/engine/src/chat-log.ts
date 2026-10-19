// 跨引擎接力只带「聊天」：用户说过的话和助手每轮的最后一条回复，直接注入新引擎的原生会话。
// 命令输出、工具调用、文件改动都是工作区里的状态，新引擎和旧引擎面对同一个目录，自己看就行；
// 重新推不出来的只有用户说过什么、助手得出了什么结论。所以这里不渲染那些条目。
import { MAX_IMAGE_COUNT, MAX_IMAGE_TOTAL, type ImageAttachment, type Item } from '@pixelsky/protocol'
import { cut } from './text'

/** 一轮回放：用户说了什么，助手最后回了什么（助手那条可能没有，例如被打断） */
export interface ChatTurn {
  /** 这一轮用户消息条目的 id；写进 Claude 记录当 uuid，回退时照样找得到 */
  id: string
  /** 用户消息原文（含附件名），已按上限截断 */
  user: string
  /** 这一轮最后一条有内容的助手回复，没有为 null */
  assistant: string | null
  /** 这一轮用户消息（含中途补充）带上的图片原图，没有为 undefined；user 里的附件名和它对得上 */
  images?: ImageAttachment[]
}

/** 发给支持原生注入的引擎的交接：注入不了时退回 fallback（旧的文字交接材料） */
export interface ChatSeed {
  /** 更早几轮的概要，接在第一轮用户话前面；全部装得下时为 null */
  overview: string | null
  turns: ChatTurn[]
  /** 注入失败时加在用户消息前面的文字交接材料 */
  fallback: string
  /** 注入失败退回 fallback 时，随当前消息一起发的更早消息的图片（排在当前消息自己的图片前面，fallback 里有说明）；没有为 undefined */
  fallbackImages?: ImageAttachment[]
  /** 这份回放里有图、但没带上的张数（更早的几轮、超出数量或大小上限、目标引擎不能看图）；没有为 undefined */
  omittedImages?: number
  /** 引擎那边的原生会话记录没了，这份回放是整段聊天、写进新的引擎会话：宿主已经提示过，引擎不再重复报「没能恢复」 */
  recreated?: true
}

export interface ChatLogOptions {
  /** 单条用户消息的字数上限 */
  userLimit?: number
  /** 单条助手回复的字数上限 */
  assistantLimit?: number
  /** 带上的图片；不传就是全部带上。不在里面的图片，用户话里写「未带上」，turn.images 里也没有 */
  carried?: ReadonlySet<ImageAttachment>
  /** 已经随当前消息重发的图片 id（失败重试时同一张图还在上一轮里）：只写附件名，不带原图、不算没带上 */
  skipIds?: ReadonlySet<string>
}

const DEFAULT_USER_LIMIT = 4_000
const DEFAULT_ASSISTANT_LIMIT = 8_000
/** 回放原文的总字数上限；超出的更早几轮只留用户的要求 */
export const DEFAULT_CHAT_BUDGET = 60_000
const OVERVIEW_ITEM_CHARS = 300
const OVERVIEW_CHARS = 6_000
/** 交接带图片的总大小上限（解码后的字节）：图片只是补背景，不能把一条消息撑得太大 */
export const HANDOFF_IMAGE_BYTES = 5 * 1024 * 1024
/**
 * 单张图片的上限：Claude API 拒收 base64 超过 5 MB 或任一边超过 8000 px 的图片，
 * 写进 Claude 记录后每次 --resume 都会失败。base64 约比原图大 1/3，所以原图最多 3.5 MiB
 */
export const HANDOFF_IMAGE_MAX_BYTES = 3.5 * 1024 * 1024
export const HANDOFF_IMAGE_MAX_SIDE = 8000

/** 这张图能不能随交接带上（单张不超过 Claude API 的大小和边长上限） */
export const carriableImage = (image: ImageAttachment): boolean =>
  image.bytes <= HANDOFF_IMAGE_MAX_BYTES &&
  image.width <= HANDOFF_IMAGE_MAX_SIDE &&
  image.height <= HANDOFF_IMAGE_MAX_SIDE

const clip = (text: string, max: number): string => (text.length > max ? `${cut(text, 0, max)}…（已截断）` : text)

/** 有内容的助手回复才算数：思考、提示、统计都不是回复 */
const isReply = (item: Item): item is Extract<Item, { kind: 'assistant' }> =>
  item.kind === 'assistant' && item.text.trim().length > 0

/** 一次能带多少张图片、多少字节 */
export interface ImageRoom {
  count: number
  bytes: number
}

/** 交接图片的额度：数量和大小各有上限；used 是同一条消息里已经占了额度的图片（当前消息自己的） */
export function handoffImageRoom(used: readonly ImageAttachment[] = []): ImageRoom {
  const bytes = used.reduce((sum, image) => sum + image.bytes, 0)
  return {
    count: Math.max(0, MAX_IMAGE_COUNT - used.length),
    bytes: Math.max(0, Math.min(HANDOFF_IMAGE_BYTES, MAX_IMAGE_TOTAL - bytes)),
  }
}

/** 按时间顺序传入，从最新往前挑带得动的：数量和大小都不能超，遇到第一张装不下的就停（更早的更没必要带）；按原顺序返回 */
export function pickRecentImages<T extends { bytes: number }>(images: readonly T[], room: ImageRoom): T[] {
  const picked: T[] = []
  let bytes = 0
  for (let i = images.length - 1; i >= 0; i--) {
    if (picked.length >= room.count || bytes + images[i].bytes > room.bytes) break
    bytes += images[i].bytes
    picked.unshift(images[i])
  }
  return picked
}

/**
 * 附件名接在用户话后面；用户只发了文件没写字时，附件名就是这条消息。没带上的图片单独写明。
 * 先截断正文再接这些说明，长消息的说明才不会被截掉
 */
function userText(
  item: Extract<Item, { kind: 'user' }>,
  limit: number,
  carried?: ReadonlySet<ImageAttachment>,
  skipIds?: ReadonlySet<string>,
): string {
  const images = item.attachments ?? []
  const skipped = (a: ImageAttachment): boolean => !!skipIds?.has(a.id)
  const left = carried ? images.filter(a => !skipped(a) && !carried.has(a)) : []
  const names = [
    ...images.filter(a => skipped(a) || !carried || carried.has(a)).map(a => a.name),
    ...(item.files ?? []).map(f => f.name),
  ]
  const text = clip(item.text.trim(), limit)
  const attached = names.length ? `（附：${names.join('、')}）` : ''
  return `${text}${attached}${left.length ? `（附图 ${left.map(a => a.name).join('、')}，未带上）` : ''}`
}

/**
 * 把对话条目压成一轮一轮的聊天。
 * 中途补充（guidance）不是新的一轮，并进当前这轮的用户话里；第一条普通用户消息之前的零散条目丢掉。
 */
export function buildChatLog(items: readonly Item[], opts: ChatLogOptions = {}): ChatTurn[] {
  const userLimit = opts.userLimit ?? DEFAULT_USER_LIMIT
  const assistantLimit = opts.assistantLimit ?? DEFAULT_ASSISTANT_LIMIT
  const turns: ChatTurn[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      const guidance = item.mode === 'guidance' && turns.length > 0
      // 中途补充并进上一轮，不单独截断
      const text = userText(item, guidance ? Infinity : userLimit, opts.carried, opts.skipIds)
      if (!text) continue
      const images = (item.attachments ?? []).filter(
        a => !opts.skipIds?.has(a.id) && (!opts.carried || opts.carried.has(a)),
      )
      if (guidance) {
        const last = turns[turns.length - 1]
        last.user = `${last.user}\n（中途补充）${text}`
        if (images.length) last.images = [...(last.images ?? []), ...images]
        continue
      }
      turns.push({ id: item.id, user: text, assistant: null, ...(images.length ? { images } : {}) })
      continue
    }
    // 助手回复：这一轮的最后一条胜出，过程宣告（「我会先…」）被后面的结论顶掉
    if (isReply(item) && turns.length > 0) turns[turns.length - 1].assistant = clip(item.text.trim(), assistantLimit)
  }
  return turns
}

/**
 * 太长的聊天按「最近的留全文、更早的捏成概要」处理，和 Codex 恢复会话的做法一致
 * （codex-rs/rollout/src/model_context.rs：压缩摘要 + 压缩之后的原文）。
 * turns 按时间顺序传入；至少留最近一轮。
 */
export function fitChatLog(
  turns: readonly ChatTurn[],
  budget: number,
  overview: (turns: readonly ChatTurn[]) => string | null,
): { overview: string | null; turns: ChatTurn[] } {
  const size = (turn: ChatTurn): number => turn.user.length + (turn.assistant?.length ?? 0) + 16
  let used = 0
  let from = turns.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const next = used + size(turns[i])
    if (i < turns.length - 1 && next > budget) break
    used = next
    from = i
  }
  if (from === 0) return { overview: null, turns: [...turns] }
  return { overview: overview(turns.slice(0, from)), turns: turns.slice(from) }
}

/** 装不下的更早几轮：只列用户的要求，从最近的往前装 */
export function chatOverview(turns: readonly ChatTurn[]): string | null {
  if (turns.length === 0) return null
  const lines: string[] = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const line = `- ${clip(turns[i].user.replace(/\s+/g, ' ').trim(), OVERVIEW_ITEM_CHARS)}`
    if (lines.length > 0 && used + line.length + 1 > OVERVIEW_CHARS) break
    lines.unshift(line)
    used += line.length + 1
  }
  const omitted = turns.length - lines.length
  return [
    `（像素星空补充：这段对话更早还有 ${turns.length} 轮，原文没有带过来，下面是其中用户的要求）`,
    ...(omitted > 0 ? [`（更早的 ${omitted} 条已省略）`] : []),
    ...lines,
  ].join('\n')
}

export interface ChatSeedOptions {
  /** 目标引擎能看图时才带图片，默认带 */
  carryImages?: boolean
  /** 能带的图片额度，默认是完整额度；当前消息自己有图片时要先扣掉，免得和回放里的图片加起来撑爆一次请求 */
  room?: ImageRoom
  /** 注入失败退回文字交接时随当前消息发的图片，fallback 里要有对应的说明 */
  fallbackImages?: readonly ImageAttachment[]
  /** 已经随当前消息重发的图片 id（失败重试），回放里不再带这些图，也不算没带上 */
  skipIds?: ReadonlySet<string>
}

/**
 * 交接用的聊天回放；没有可回放的聊天时返回 null。
 * 图片只带留着原文的几轮里最近的几张（数量和大小有上限），折进概要的更早几轮不带图
 */
export function buildChatSeed(
  items: readonly Item[],
  fallback: string,
  budget = DEFAULT_CHAT_BUDGET,
  opts: ChatSeedOptions = {},
): ChatSeed | null {
  const log = buildChatLog(items, { skipIds: opts.skipIds })
  if (log.length === 0) return null
  const fitted = fitChatLog(log, budget, chatOverview)
  let turns = fitted.turns
  const total = log.reduce((sum, turn) => sum + (turn.images?.length ?? 0), 0)
  let carried = 0
  if (total > 0) {
    const picked = new Set(
      opts.carryImages === false
        ? []
        : pickRecentImages(
            turns.flatMap(turn => turn.images ?? []).filter(carriableImage),
            opts.room ?? handoffImageRoom(),
          ),
    )
    // 带哪些图定了以后重排一遍，用户话里才写得对（带上了 / 未带上）
    turns = buildChatLog(items, { carried: picked, skipIds: opts.skipIds }).slice(log.length - turns.length)
    carried = picked.size
  }
  return {
    overview: fitted.overview,
    turns,
    fallback,
    ...(opts.fallbackImages?.length ? { fallbackImages: [...opts.fallbackImages] } : {}),
    ...(total > carried ? { omittedImages: total - carried } : {}),
  }
}

/** 回放里带上的图片张数 */
export const seedImageCount = (seed: ChatSeed): number =>
  seed.turns.reduce((sum, turn) => sum + (turn.images?.length ?? 0), 0)

/** 概要接在第一轮用户话前面，注入时当成同一条用户消息 */
export function seedTurns(seed: ChatSeed): ChatTurn[] {
  if (!seed.overview || seed.turns.length === 0) return seed.turns
  const [first, ...rest] = seed.turns
  return [{ ...first, user: `${seed.overview}\n\n${first.user}` }, ...rest]
}

/** 被打断、没有回复的一轮：原生会话里用户和助手要交替，补一句占位 */
export const NO_REPLY = '（这一轮没有回复，可能被中断了）'

/** 交接提示条目的 detail：注入了什么就给用户看什么 */
export function renderSeed(seed: ChatSeed): string {
  return seedTurns(seed)
    .map(turn => `用户：${turn.user}\n助手：${turn.assistant ?? NO_REPLY}`)
    .join('\n\n')
}
