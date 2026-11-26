// 频道成员工具（docs/ui/channels-member-tools.md）：member_list / member_update / member_remove 的纯函数。
// 发卡、点卡在 service.ts（toolMembers 等、memberChange），这里只管文字、校验和比对
import { ENGINES, type Effort } from '@pixelsky/protocol'
import type { AgentConfig, AgentInput, ChannelMemberChange, MemberChangeFields } from '../../../shared/types/channels'

/** 一个成员在一个频道里开着（没处理）的成员卡最多几张（§3） */
export const MEMBER_CARDS_OPEN_MAX = 3
/** 理由最长几个字 */
export const MEMBER_REASON_MAX = 200
/** member_list 带 member 时最多列几个能换的模型 */
export const MEMBER_MODELS_LISTED = 30
/** 「改回去」「加回来」能点多久 */
export const MEMBER_UNDO_MS = 24 * 3600_000

const FIELD_NAME: Record<keyof MemberChangeFields, string> = { model: '模型', effort: '强度', instructions: '职责' }
const FIELDS = Object.keys(FIELD_NAME) as (keyof MemberChangeFields)[]

/** 成员现在的这几项；没设的是 null（跟随默认） */
export function fieldsOf(m: AgentConfig): Required<MemberChangeFields> {
  return { model: m.settings.model || null, effort: m.settings.effort ?? null, instructions: m.instructions }
}

const shown = (k: keyof MemberChangeFields, v: MemberChangeFields[typeof k]): string =>
  k === 'instructions' ? '' : v || '跟随默认'

/** 职责的第一行（≤80 字），和 relayPeers 的说法一样 */
export function roleLine(instructions: string): string {
  const line =
    instructions
      .split(/\r?\n/)
      .find(l => l.trim())
      ?.trim() ?? ''
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

export interface RosterEntry {
  /** 本机频道里只有「你」一个真人 */
  human?: boolean
  name: string
  member?: AgentConfig
  self?: boolean
  lead?: boolean
  running?: number
  queued?: number
}

/** member_list 的一行 */
export function rosterLine(e: RosterEntry): string {
  const m = e.member
  if (e.human || !m) return `- ${e.name}（用户）`
  const tags = [e.self && '你自己', e.lead && '牵头', m.bound && '跟着用户自己的会话'].filter(Boolean)
  const f = fieldsOf(m)
  const work = [e.running && `在做 ${e.running} 项`, e.queued && `排队 ${e.queued} 项`].filter(Boolean)
  const role = roleLine(m.instructions)
  return [
    `- ${m.name}（AI${tags.length ? `，${tags.join('，')}` : ''}）`,
    m.engine,
    m.bound ? '模型、强度跟着那个会话' : `${shown('model', f.model)} · 强度 ${shown('effort', f.effort)}`,
    m.mode === 'shared' ? '一直用同一个会话' : '每项活新开会话',
    ...work,
    ...(role ? [`职责：${role}`] : []),
  ].join(' · ')
}

/** 引擎能选的强度 */
export const effortsOf = (m: AgentConfig): readonly Effort[] => ENGINES[m.engine]?.caps.efforts ?? []

/** member_list 带 member 时多的几行：能换的模型、能选的强度、还在哪些频道 */
export function memberDetail(m: AgentConfig, models: string[] | null, elsewhere: string[]): string {
  const efforts = effortsOf(m)
  const listed = models?.slice(0, MEMBER_MODELS_LISTED) ?? []
  const more = models && models.length > listed.length ? `（还有 ${models.length - listed.length} 个没列）` : ''
  return [
    m.bound
      ? '能换的模型：不能改（跟着用户自己的会话）'
      : models === null
        ? '能换的模型：现在读不到模型目录'
        : `能换的模型：${listed.join('、') || '（没有）'}${more}`,
    m.bound ? '能选的强度：不能改' : `能选的强度：${efforts.join(' / ') || '（这个引擎不能选）'}`,
    `也在这些频道里：${elsewhere.length ? `${elsewhere.map(n => `#${n}`).join('、')}（改了那边一起变）` : '没有'}`,
  ].join('\n')
}

/** member_update 的参数（已经从 MCP 参数里取出来） */
export interface MemberUpdateArgs {
  model?: string
  effort?: string
  instructions?: string
  reason: string
}

/**
 * 校验要改的几项，算出 from / to（只含真要改的）。不合格抛错，原因直接给 AI 看。
 * models：能换的模型；null 是读不到目录（只查长度，点的时候界面再核对）
 */
export function checkUpdate(
  m: AgentConfig,
  args: MemberUpdateArgs,
  models: string[] | null,
  instructionsMax: number,
): { from: MemberChangeFields; to: MemberChangeFields } {
  if (m.bound && (args.model !== undefined || args.effort !== undefined))
    throw new Error(`${m.name} 是从用户自己的会话加入的，模型、强度跟着那个会话走，不能改；只能改职责`)
  const want: MemberChangeFields = {}
  if (args.model !== undefined) {
    const model = args.model.trim()
    if (model.length > 200 || /\s/.test(model)) throw new Error('模型名不对')
    if (!model && (m.settings.platform || m.settings.provider))
      throw new Error(`${m.name} 用的是平台线路或自定义接口，必须指定一个模型`)
    if (model && models && !models.includes(model))
      throw new Error(
        `「${model}」不在 ${m.name} 能用的模型里。能换的：${models.slice(0, MEMBER_MODELS_LISTED).join('、') || '（没有）'}`,
      )
    want.model = model || null
  }
  if (args.effort !== undefined) {
    const effort = args.effort.trim()
    const efforts = effortsOf(m)
    if (effort && !efforts.includes(effort as Effort))
      throw new Error(`${m.name}（${m.engine}）的强度只能是：${efforts.join(' / ') || '（这个引擎不能选）'}`)
    want.effort = (effort || null) as Effort | null
  }
  if (args.instructions !== undefined) {
    const text = args.instructions.trim()
    if (!text) throw new Error('职责不能为空')
    if (text.length > instructionsMax) throw new Error(`职责最多 ${instructionsMax} 字`)
    want.instructions = text
  }
  if (!Object.keys(want).length) throw new Error('要改的至少给一项：model、effort 或 instructions')
  const now = fieldsOf(m)
  const from: MemberChangeFields = {}
  const to: MemberChangeFields = {}
  for (const k of FIELDS)
    if (k in want && want[k] !== now[k]) {
      Object.assign(from, { [k]: now[k] })
      Object.assign(to, { [k]: want[k] })
    }
  if (!Object.keys(to).length) throw new Error(`${m.name} 现在就是这样，没有要改的`)
  return { from, to }
}

export function cleanReason(raw: string | undefined): string {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('写一下为什么（reason）')
  return text.length > MEMBER_REASON_MAX ? `${text.slice(0, MEMBER_REASON_MAX)}…` : text
}

/** 卡片的一句话（消息 text）：手机、搜索、channel_read 都用它 */
export function changeSummary(c: ChannelMemberChange, name: string, self: boolean): string {
  if (c.op === 'remove') return `想把 ${name} 移出频道：${c.reason}`
  const parts = FIELDS.filter(k => c.to && k in c.to).map(k =>
    k === 'instructions'
      ? '职责'
      : `${FIELD_NAME[k]} ${shown(k, c.from?.[k] ?? null)} → ${shown(k, c.to?.[k] ?? null)}`,
  )
  return `想改 ${self ? '自己' : name} 的${parts.join('、')}：${c.reason}`
}

/** channel_read 里卡片后面的状态 */
export function changeState(c: ChannelMemberChange): string {
  if (c.state === 'open') return '等用户点'
  if (c.state === 'dismissed') return '用户没采用'
  if (c.state === 'stale') return '已失效'
  if (c.op === 'remove') return c.state === 'done' ? '已移出' : '已加回来'
  return c.state === 'done' ? (c.adjusted ? '用户调整后改了' : '已改') : '已改回原来的'
}

/** 卡发出来以后变了的几项（和 expect 比） */
export function changedFields(m: AgentConfig, expect: MemberChangeFields | undefined): (keyof MemberChangeFields)[] {
  const now = fieldsOf(m)
  return FIELDS.filter(k => expect && k in expect && (expect[k] ?? null) !== now[k])
}

export const fieldNames = (keys: (keyof MemberChangeFields)[]): string => keys.map(k => FIELD_NAME[k]).join('、')

/** 把这几项合进成员现有的配置，给 saveMember（它每次从头重建，其它字段原样带上） */
export function inputWith(m: AgentConfig, fields: MemberChangeFields): AgentInput {
  const { createdAt: _c, sharedSessionId: _s, machineId: _m, ...rest } = m
  const settings = { ...m.settings }
  if ('model' in fields) {
    if (fields.model) settings.model = fields.model
    else delete settings.model
  }
  if ('effort' in fields) {
    if (fields.effort) settings.effort = fields.effort
    else delete settings.effort
  }
  return {
    ...rest,
    settings,
    ...(fields.instructions !== undefined ? { instructions: fields.instructions } : {}),
  }
}
