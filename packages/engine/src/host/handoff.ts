// 跨引擎接力：换引擎、给新引擎的交接、各引擎读到哪里的游标
// 应用自己保存一份完整对话；每个引擎有自己的原生会话，engineSessions[引擎].seen 是它上下文里最后一条对话条目
import { randomUUID } from 'node:crypto'
import {
  EMPTY_FLAGS,
  messageWithFiles,
  type EngineId,
  type EngineSessionState,
  type FileAttachment,
  type ImageAttachment,
  type Item,
  type SessionRecord,
} from '@pixelsky/protocol'
import {
  buildChatSeed,
  carriableImage,
  handoffImageRoom,
  pickRecentImages,
  renderSeed,
  seedImageCount,
  type ChatSeed,
} from '../chat-log'
import { NATIVE_TEXT } from '../native/text'
import { buildHandoff, handoffEngines, hasHandoffContent, userImages } from '../handoff'
import { ENGINES } from '../registry'
import type { HostContext } from './context'

/** 对话里最后一条条目的 id；没有为 null */
export const lastItemId = (items: readonly Item[]): string | null => items.at(-1)?.id ?? null

/**
 * 回退 / 分叉保留 items 之后，这个引擎上下文里最后一条对话条目：它最后处理的那条用户消息所在的一轮的末尾
 * （下一条普通用户消息之前，没有下一条就是最后一条）；它一条都没处理过为 null。untagged 的用户消息按 fallback 引擎算。
 * 从头按轮重放 plan 的 hold 规则：斜杠命令派发时还有没交接的内容（游标之后、这条消息之前）就跳过这一轮，
 * 不推进游标，交接留给下一条普通消息；否则 /compact 那一轮的末尾会被当成已读
 */
export function derivedSeen(items: readonly Item[], engine: EngineId, fallback: EngineId): string | null {
  let seen = -1
  items.forEach((item, i) => {
    if (item.kind !== 'user' || (item.engine ?? fallback) !== engine) return
    // 斜杠命令派发时还有没交接的内容就不推进游标（同 plan 的 hold）
    if (
      item.mode !== 'guidance' &&
      item.text.trimStart().startsWith('/') &&
      hasHandoffContent(items.slice(seen + 1, i))
    )
      return
    const next = items.findIndex((it, j) => j > i && it.kind === 'user' && it.mode !== 'guidance')
    seen = next < 0 ? items.length - 1 : next - 1
  })
  return seen < 0 ? null : items[seen].id
}

/** 通知里图片的说明：带上几张、几张没带上；都没有就是空 */
const imageParts = (carried: number, omitted: number): string[] => [
  ...(carried > 0 ? [`含 ${carried} 张图片`] : []),
  ...(omitted > 0 ? [`${omitted} 张图片未带上`] : []),
]

/** 新引擎收到的这条消息要不要带交接 */
export interface HandoffPlan {
  /** 真正发给引擎的文字（引擎不能注入聊天时，前面带着交接材料） */
  text: string
  /** 要注入引擎原生会话的聊天（适配器 seedsHistory 时）；注入不了时适配器退回 seed.fallback（连同 seed.fallbackImages） */
  seed?: ChatSeed
  /** 文字交接时随这条消息一起发的更早消息的图片（text 里有说明），发送时排在消息自己的图片前面；没有为 undefined */
  attachments?: ImageAttachment[]
  /** 放在用户消息前面的提示条目，detail 是交接材料原文 */
  notice: Item | null
  /** 斜杠命令（如 /compact）本该带交接但没带：这一轮结束时不推进游标，交接留给下一条普通消息 */
  hold: boolean
}

export class HostHandoff {
  constructor(private readonly ctx: HostContext) {}

  /**
   * 把会话换到另一个引擎。只在空闲、没有在派发时调用（或由派发自己调用）：
   * 关掉当前进程，存好当前引擎的原生会话和游标，取出目标引擎以前的（没有就新建一个）。
   */
  async switchEngine(id: string, target: EngineId): Promise<void> {
    const { ctx } = this
    const m = ctx.m
    const rt = m.sessions.runtime(id)
    if (rt.snapshot.record.engine === target) return
    const adapter = ctx.adapters[target]
    if (!adapter) throw new Error('这个引擎暂不支持')
    if (rt.idleTimer) {
      clearTimeout(rt.idleTimer)
      rt.idleTimer = null
    }
    const old = rt.session
    rt.session = null
    await old?.close()
    // 关进程期间记录可能变了（引擎回报的会话 id 等），换引擎用最新的
    const record = rt.snapshot.record
    if (record.engine === target) return
    // 没打过标记的用户消息都是当前引擎处理的（以前不能换引擎）；补上标记，之后才分得清是谁处理的
    let items = rt.snapshot.items
    if (items.some(item => item.kind === 'user' && !item.engine)) {
      items = items.map(item => (item.kind === 'user' && !item.engine ? { ...item, engine: record.engine } : item))
      rt.snapshot = { ...rt.snapshot, items }
      ctx.store.replaceItems(id, items)
    }
    const map: Partial<Record<EngineId, EngineSessionState>> = { ...(record.engineSessions ?? {}) }
    const prev = map[record.engine]
    // 旧记录（没有 engineSessions）：当前引擎看到了全部对话
    map[record.engine] = {
      id: record.engineSessionId,
      seen: prev ? prev.seen : record.engineSessions ? null : lastItemId(items),
      ...(record.pendingRewind ? { pendingRewind: record.pendingRewind } : {}),
      ...(record.pendingFork ? { pendingFork: record.pendingFork } : {}),
    }
    const entry = map[target]
    // 引擎自己分配会话 id（Codex）时写 null，启动时新建；其他引擎预先给一个。
    // Claude 不能留 null：它会退回用会话自己的 id，那下面可能已经有一份旧记录
    const fresh = adapter.enginePicksSessionId ? null : randomUUID()
    const engineSessionId = entry?.id ?? fresh
    map[target] = { id: engineSessionId, seen: entry?.id ? entry.seen : null }
    const caps = ENGINES[target].caps
    m.events.patchRecord(id, {
      engine: target,
      nextEngine: null,
      engineSessionId,
      engineSessions: map,
      pendingRewind: entry?.pendingRewind ?? null,
      pendingFork: entry?.pendingFork ?? null,
      // 目标引擎没有的开关和强度档位清掉
      ...(!caps.ultracode && record.ultracode ? { ultracode: false } : {}),
      ...(!caps.fast && record.fast ? { fast: false } : {}),
      ...(!caps.thinkingSummaries && record.thinkingSummaries ? { thinkingSummaries: false } : {}),
      ...(record.effort && !caps.efforts.includes(record.effort) ? { effort: null } : {}),
    })
    this.resetRuntimeState(id)
  }

  /** 换引擎后界面不能再显示旧引擎的运行时状态（上下文用量、能力标记、后台任务、输入建议） */
  private resetRuntimeState(id: string): void {
    const { ctx } = this
    const m = ctx.m
    const rt = m.sessions.runtime(id)
    m.cache.reset(id)
    m.events.apply(id, { type: 'flags', flags: EMPTY_FLAGS })
    if (rt.snapshot.context) m.events.apply(id, { type: 'context', context: null })
    if (rt.snapshot.suggestion) m.events.apply(id, { type: 'suggestion', text: null })
    if (rt.snapshot.tasks.length) m.events.apply(id, { type: 'tasks', tasks: [] })
    if (rt.snapshot.subagents.length) m.events.apply(id, { type: 'subagents', subagents: [] })
    if (rt.snapshot.commands?.length) m.events.apply(id, { type: 'commands', commands: [] })
    if (rt.snapshot.mcp) m.events.apply(id, { type: 'mcp', report: null })
    if (rt.snapshot.background) m.events.apply(id, { type: 'background', count: 0 })
    let runs = { workflows: [], agents: [] } as typeof rt.snapshot.runs
    try {
      runs = ctx.adapters[rt.snapshot.record.engine]?.loadRuns?.(rt.snapshot.record) ?? runs
    } catch {
      // 读不到追踪数据不影响换引擎
    }
    m.events.apply(id, { type: 'runs', runs })
  }

  /**
   * 目标引擎当前选的模型能不能看图：目录里查得到这个模型就以它的输入类型为准（Codex / Pixel 有的模型不能看图），
   * 查不到（没有目录、目录里没有这个模型、读目录失败）按引擎能力。派发前先问，plan 是同步的。
   * 对话里没有图片时不用查，免得白白等目录（有的引擎要起进程）
   */
  async modelSees(id: string, record: SessionRecord): Promise<boolean> {
    const engineSees = !!ENGINES[record.engine].caps.imageInput
    if (!engineSees || !userImages(this.ctx.m.sessions.runtime(id).snapshot.items).length) return engineSees
    try {
      const catalog = await this.ctx.adapters[record.engine]?.catalog?.()
      const model = catalog?.models?.find(m => m.id === (record.model ?? catalog.currentModel))
      return model ? model.inputModalities.includes('image') : engineSees
    } catch {
      return engineSees
    }
  }

  /**
   * 派发一条消息前算要不要给引擎带交接：它没看过的对话（游标之后的，或游标不在了就是全部）。
   * 能注入的引擎只带聊天（用户话和每轮的助手结论），直接补进它的原生会话；
   * 不能注入的引擎（或注入失败时）退回整理好的文字材料，加在消息前面。
   * 旧记录（没有 engineSessions）当前引擎看到了全部对话，不带。
   * sees：当前模型能不能看图（modelSees 的结果），决定带不带更早消息的图片；不给按引擎能力
   */
  plan(
    id: string,
    record: SessionRecord,
    text: string,
    files: FileAttachment[] | undefined,
    attachments: readonly ImageAttachment[] = [],
    sees: boolean = !!ENGINES[record.engine].caps.imageInput,
    /** 这条消息是自动重连原样重发的：对话里已经有它的用户消息条目（这个 id），交接里不能再带一遍 */
    replacing?: string,
    /** 引擎那边的会话接不上了（恢复 / 回退 / 分叉失败，已改开新会话）：不管游标，整段聊天都要带 */
    lost = false,
  ): HandoffPlan {
    const rt = this.ctx.m.sessions.runtime(id)
    const body = messageWithFiles(text, files)
    const plain: HandoffPlan = { text: body, notice: null, hold: false }
    if (!record.engineSessions && !lost) return plain
    const full = rt.snapshot.items
    // 游标照原样在完整对话里找；交接材料和「上一条用户消息」里排除要被原样重发的这一条
    const prior = replacing ? full.filter(item => item.id !== replacing) : full
    // 引擎那边的原生会话记录没了（终端里删了、换了机器）：当没看过，下面的接力把整段聊天写进同一个 id 的新记录。
    // 待执行的回退 / 分叉本来就不在这个 id 的记录里，不算
    const recreate =
      lost ||
      (!!record.engineSessions?.[record.engine]?.seen &&
        !record.pendingRewind &&
        !record.pendingFork &&
        this.ctx.adapters[record.engine]?.hasNativeSession?.(record) === false)
    const seen = recreate ? null : (record.engineSessions?.[record.engine]?.seen ?? null)
    const at = seen === null ? -1 : full.findIndex(item => item.id === seen)
    const delta = (at >= 0 ? full.slice(at + 1) : full).filter(item => item.id !== replacing)
    const mode = at >= 0 ? 'delta' : 'full'
    // 走文字交接（适配器不能注入，或注入失败）时图片随这条消息发：先扣掉消息自己的图片占的额度，目标引擎不能看图就不带
    // 失败的一轮重试时，它的图片已经随当前消息重发（游标没动，那条用户消息还在 delta 里）：按图片 id 去重，
    // 只在文字里留附件名，不再当「更早的图」带一遍，也不算没带上；那一轮的文字照旧重发
    const skipIds = new Set(attachments.map(a => a.id))
    const all = userImages(delta).filter(({ image }) => !skipIds.has(image.id))
    const room = handoffImageRoom(attachments)
    // 单张超过 Claude 的大小 / 边长上限的不带（带了写进记录后每次 resume 都会被拒）
    const carry = sees
      ? pickRecentImages(
          all.filter(({ image }) => carriableImage(image)),
          room,
        )
      : []
    const built = buildHandoff({
      items: delta,
      mode,
      target: record.engine,
      conversationId: id,
      historyTool: this.ctx.opts.historyTool?.(record) ?? false,
      images: carry,
      omittedImages: all.length - carry.length,
    })
    if (!built) return plain
    // 斜杠命令（/compact 等）要原样交给引擎，不能前面加东西；交接留给下一条普通消息
    // 这条 hold 规则回退 / 分叉重建游标时由 derivedSeen 重放，两处要保持一致
    if (text.trimStart().startsWith('/')) return { ...plain, hold: true }
    // 错误恢复也会补发未确认的上下文，只有接手另一个引擎的普通轮次才显示换引擎提示。
    // 斜杠命令不交接，不能让它吞掉留给下一条普通消息的提示；中途补充也不算新轮次。
    const previous = prior.findLast(
      item => item.kind === 'user' && item.mode !== 'guidance' && !item.text.trimStart().startsWith('/'),
    )
    const showNotice = previous?.kind === 'user' && !!previous.engine && previous.engine !== record.engine
    const name = ENGINES[record.engine].name
    const others = handoffEngines(delta, record.engine)
    // 不知道是哪个引擎时写「其他引擎」（词典里有不带 {p0} 的专用模板，所以前后不留空格）
    const during = others.length ? ` ${others.map(e => ENGINES[e].name).join('、')} ` : '其他引擎'
    const seed = this.ctx.adapters[record.engine]?.seedsHistory
      ? buildChatSeed(delta, built.text, undefined, {
          carryImages: sees,
          room,
          skipIds,
          fallbackImages: carry.map(c => c.image),
        })
      : null
    if (seed) {
      const parts = imageParts(seedImageCount(seed), seed.omittedImages ?? 0)
      const turns = [`${seed.turns.length} 轮`, ...parts].join('，')
      return {
        text: body,
        seed: recreate ? { ...seed, recreated: true } : seed,
        hold: false,
        notice: recreate
          ? {
              kind: 'notice',
              id: randomUUID(),
              level: 'warn',
              text: lost
                ? NATIVE_TEXT.resumeLost(seed.turns.length, name)
                : NATIVE_TEXT.recreated(seed.turns.length, name),
              detail: renderSeed(seed),
            }
          : showNotice
            ? {
                kind: 'notice',
                id: randomUUID(),
                level: 'info',
                text:
                  mode === 'full'
                    ? `已把之前的聊天带给 ${name}（${turns}）`
                    : `已把${during}期间的聊天同步给 ${name}（${turns}）`,
                detail: renderSeed(seed),
              }
            : null,
      }
    }
    if (lost) return plain
    const parts = imageParts(carry.length, all.length - carry.length)
    return {
      text: `${built.text}\n\n${body}`,
      ...(carry.length ? { attachments: carry.map(c => c.image) } : {}),
      hold: false,
      notice: showNotice
        ? {
            kind: 'notice',
            id: randomUUID(),
            level: 'info',
            text:
              mode === 'full'
                ? `已把之前的对话交接给 ${name}（${[`${built.count} 条`, ...parts].join('，')}）`
                : `已把${during}期间的进展同步给 ${name}${parts.length ? `（${parts.join('，')}）` : ''}`,
            detail: built.text,
          }
        : null,
    }
  }

  /**
   * 引擎那边的会话接不上了（恢复 / 回退 / 分叉失败，适配器已改开新会话）：把这一轮之前的整段聊天做成回放，
   * 注进新会话，免得记忆丢掉。exclude 是这一轮自己的用户消息条目；没有可带的聊天或适配器不收回放时返回 null
   */
  recover(
    id: string,
    record: SessionRecord,
    exclude: string,
    sees: boolean,
  ): { seed: NonNullable<HandoffPlan['seed']>; notice: NonNullable<HandoffPlan['notice']> } | null {
    const plan = this.plan(id, record, '', undefined, [], sees, exclude, true)
    return plan.seed && plan.notice ? { seed: plan.seed, notice: plan.notice } : null
  }
}
