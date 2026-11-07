// 频道预设（docs/ui/channel-presets.md）：设好的频道存一份，新建时选中就能填好；只在创建时复制，不和频道保持关联。
// 存在本机（localStorage），不跟着换电脑走
import { useSyncExternalStore } from 'react'
import type { AgentMember, Channel } from '@/data/types'
import { tr } from '../../i18n/core'
import {
  DEFAULT_RELAY_RULES,
  cleanRelayRules,
  relayRulesOf,
  type AgentConfig,
  type ChannelAlertRule,
  type ChannelInput,
  type ChannelNotify,
  type RelayRules,
} from '../../../../shared/types/channels'
import { DIGEST_HOUR, alertRulesOf, cleanAlertRules, cleanDigestHour } from '../../../../shared/channels/alerts'

const KEY = 'pixelsky.channels.presets'
export const PRESET_MAX = 30
export const PRESET_NAME_MAX = 40

/** 成员配置快照：不存 id、会话、机器（机器由项目算），不含密钥（额度来源只有分组、账号或接口 id） */
export type PresetMemberConfig = Pick<
  AgentConfig,
  'name' | 'engine' | 'projectId' | 'copyId' | 'settings' | 'instructions' | 'mode' | 'tools'
>

/** 除了 id、名字和时间，没写的字段 = 存的时候没勾，新建时用表单默认值 */
export interface ChannelPreset {
  id: string
  name: string
  updatedAt: number
  projectId?: string | null
  notes?: string | null
  members?: { sourceId: string; config: PresetMemberConfig }[]
  lead?: string | null
  leadRoute?: boolean
  planFirst?: boolean
  relay?: boolean
  relayRules?: RelayRules
  notify?: ChannelNotify
  alerts?: Partial<Record<ChannelAlertRule, boolean>>
  digestHour?: number
}

export interface PresetState {
  defaultId: string | null
  items: ChannelPreset[]
}

const EMPTY: PresetState = { defaultId: null, items: [] }

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function parseMember(raw: unknown): NonNullable<ChannelPreset['members']>[number] | null {
  const m = raw as { sourceId?: unknown; config?: Partial<PresetMemberConfig> } | null
  const c = m?.config
  if (!str(m?.sourceId) || !c || !str(c.name) || !str(c.engine) || !str(c.projectId)) return null
  return {
    sourceId: m!.sourceId as string,
    config: {
      name: c.name!,
      engine: c.engine!,
      projectId: c.projectId!,
      copyId: str(c.copyId),
      settings: c.settings && typeof c.settings === 'object' ? c.settings : {},
      instructions: typeof c.instructions === 'string' ? c.instructions : '',
      mode: c.mode === 'shared' ? 'shared' : 'per-task',
      ...(c.tools ? { tools: c.tools } : {}),
    },
  }
}

function parsePreset(raw: unknown): ChannelPreset | null {
  const p = raw as Record<string, unknown> | null
  if (!p || !str(p.id) || !str(p.name)) return null
  const preset: ChannelPreset = {
    id: p.id as string,
    name: p.name as string,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
  }
  if (typeof p.projectId === 'string' || p.projectId === null) preset.projectId = p.projectId
  if (typeof p.notes === 'string' || p.notes === null) preset.notes = p.notes
  if (Array.isArray(p.members)) preset.members = p.members.map(parseMember).filter(m => m !== null)
  if (typeof p.lead === 'string' || p.lead === null) preset.lead = p.lead
  if (typeof p.leadRoute === 'boolean') preset.leadRoute = p.leadRoute
  if (typeof p.planFirst === 'boolean') preset.planFirst = p.planFirst
  if (typeof p.relay === 'boolean') preset.relay = p.relay
  if (p.relayRules !== undefined)
    try {
      preset.relayRules = cleanRelayRules(p.relayRules)
    } catch {
      /* 坏的规则不要，用默认 */
    }
  if (p.notify === 'all' || p.notify === 'important' || p.notify === 'mute') preset.notify = p.notify
  if (p.alerts !== undefined) preset.alerts = cleanAlertRules(p.alerts)
  if (p.digestHour !== undefined) preset.digestHour = cleanDigestHour(p.digestHour)
  return preset
}

/** 读 localStorage 的值：坏数据按空，单个坏条目跳过 */
export function parsePresets(text: string | null): PresetState {
  try {
    const raw = JSON.parse(text ?? 'null') as { defaultId?: unknown; items?: unknown } | null
    if (!raw || !Array.isArray(raw.items)) return EMPTY
    const items = raw.items
      .map(parsePreset)
      .filter(p => p !== null)
      .slice(0, PRESET_MAX)
    const defaultId = str(raw.defaultId)
    return { defaultId: defaultId && items.some(p => p.id === defaultId) ? defaultId : null, items }
  } catch {
    return EMPTY
  }
}

export const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** 新增或覆盖（按 id）；新增超过上限时抛错 */
export function withPreset(state: PresetState, preset: ChannelPreset, makeDefault: boolean): PresetState {
  const exists = state.items.some(p => p.id === preset.id)
  if (!exists && state.items.length >= PRESET_MAX) throw new Error(tr('channels.preset.full', { n: PRESET_MAX }))
  return {
    items: exists ? state.items.map(p => (p.id === preset.id ? preset : p)) : [...state.items, preset],
    defaultId: makeDefault ? preset.id : state.defaultId,
  }
}

export function withoutPreset(state: PresetState, id: string): PresetState {
  return {
    items: state.items.filter(p => p.id !== id),
    defaultId: state.defaultId === id ? null : state.defaultId,
  }
}

let state: PresetState = typeof localStorage !== 'undefined' ? parsePresets(localStorage.getItem(KEY)) : EMPTY
const listeners = new Set<() => void>()

/** 存不下（配额满）时抛错，不改内存里的值：弹窗要告诉用户没存上 */
export function setPresets(next: PresetState): void {
  localStorage.setItem(KEY, JSON.stringify({ version: 1, ...next }))
  state = next
  for (const l of listeners) l()
}

export function usePresets(): PresetState {
  return useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => state,
  )
}

export const PRESET_PARTS = ['members', 'dispatch', 'notes', 'alerts', 'project'] as const
export type PresetPart = (typeof PRESET_PARTS)[number]
export const DEFAULT_PRESET_PARTS: readonly PresetPart[] = ['members', 'dispatch', 'notes', 'alerts']

/** 能进预设的成员：自己的、有配置的（团队里别人的成员不算） */
export const presetableMembers = (channel: Channel, members: readonly AgentMember[]): AgentMember[] =>
  members.filter(m => channel.memberIds.includes(m.id) && !!m.config && m.mine !== false && !m.teamAgentId)

/** 频道 → 预设（「存为预设」和「从频道复制」共用）；parts 是要带的部分 */
export function presetFromChannel(
  channel: Channel,
  members: readonly AgentMember[],
  head: Pick<ChannelPreset, 'id' | 'name' | 'updatedAt'>,
  parts: readonly PresetPart[] = PRESET_PARTS,
): ChannelPreset {
  const preset: ChannelPreset = { ...head }
  const picked = parts.includes('members') ? presetableMembers(channel, members) : []
  if (parts.includes('members'))
    preset.members = picked.map(m => {
      const { name, engine, projectId, copyId, settings, instructions, mode, tools } = m.config!
      return {
        sourceId: m.id,
        config: { name, engine, projectId, copyId, settings, instructions, mode, ...(tools ? { tools } : {}) },
      }
    })
  if (parts.includes('dispatch')) {
    preset.relay = channel.relay === true
    preset.relayRules = relayRulesOf(channel)
    preset.planFirst = channel.planFirst !== false
    preset.leadRoute = channel.leadRoute !== false
    // 牵头是带上的成员之一才有意义
    preset.lead = picked.some(m => m.id === channel.lead) ? channel.lead : null
  }
  if (parts.includes('notes')) preset.notes = channel.notes ?? null
  if (parts.includes('alerts')) {
    preset.notify = channel.notify ?? 'all'
    preset.alerts = alertRulesOf(channel)
    preset.digestHour = channel.digestHour ?? DIGEST_HOUR
  }
  if (parts.includes('project')) preset.projectId = channel.projectId ?? null
  return preset
}

/** 新建弹窗里能改的设置；空白（没选预设）和现在的新建默认值一样 */
export interface PresetForm {
  notes: string
  members: string[]
  relay: boolean
  rules: RelayRules
  planFirst: boolean
  leadRoute: boolean
  lead: string
  notify: ChannelNotify
  alerts: ReturnType<typeof alertRulesOf>
  digestHour: number
}

/** 表单有没有改动：成员只看选了谁，不看先后 */
export function sameForm(a: PresetForm, b: PresetForm): boolean {
  const key = (form: PresetForm) => JSON.stringify({ ...form, members: [...form.members].sort() })
  return key(a) === key(b)
}

/** 预设里的成员现在什么情况 */
export interface PresetMemberPlan {
  /** 还在、可以直接用的成员 id */
  usable: string[]
  /** 已经删除的成员（名字） */
  deleted: string[]
}

export function planPresetMembers(preset: ChannelPreset, agents: readonly AgentMember[]): PresetMemberPlan {
  const plan: PresetMemberPlan = { usable: [], deleted: [] }
  for (const { sourceId, config } of preset.members ?? []) {
    if (agents.some(a => a.id === sourceId)) plan.usable.push(sourceId)
    else plan.deleted.push(config.name)
  }
  return plan
}

/**
 * 勾选的成员里，工作目录不在这个频道项目的；没设项目时不算。
 * shortcut: 第 1 批不新建成员，先留在原目录并提示，第 2 批改成新建一份（docs/ui/channel-presets.md §5.3）
 */
export function membersElsewhere(
  members: readonly string[],
  agents: readonly AgentMember[],
  projectId: string,
): AgentMember[] {
  if (!projectId) return []
  return agents.filter(a => members.includes(a.id) && !!a.config && a.config.projectId !== projectId)
}

export function formFromPreset(preset: ChannelPreset | null, agents: readonly AgentMember[]): PresetForm {
  const members = preset ? planPresetMembers(preset, agents).usable : []
  return {
    notes: preset?.notes ?? '',
    members,
    relay: preset?.relay ?? false,
    rules: preset?.relayRules ?? DEFAULT_RELAY_RULES,
    planFirst: preset?.planFirst ?? true,
    leadRoute: preset?.leadRoute ?? true,
    lead: preset?.lead && members.includes(preset.lead) ? preset.lead : '',
    notify: preset?.notify ?? 'all',
    alerts: alertRulesOf({ alerts: preset?.alerts }),
    digestHour: preset?.digestHour ?? DIGEST_HOUR,
  }
}

/** 新建频道用的设置从哪来：一个预设，或者照着已有频道（id 是 copy，不保存） */
export interface PresetSource {
  id: string
  name: string
  preset: ChannelPreset
}
export const COPY_SOURCE = 'copy'

/** 按现在的预设列表更新来源：改名了跟着改，删除了返回 null（照着频道复制的不受影响） */
export function refreshSource(source: PresetSource, items: readonly ChannelPreset[]): PresetSource | null {
  if (source.id === COPY_SOURCE) return source
  const preset = items.find(p => p.id === source.id)
  return preset ? { id: preset.id, name: preset.name, preset } : null
}

export interface PresetCreateActions {
  createChannel(input: ChannelInput): Promise<string>
  updateChannel(id: string, patch: Record<string, unknown>): Promise<void>
}

/**
 * 按顺序建频道：先建频道（重名在这里就失败，什么都没写入）；之后的设置分开存，一项失败不连累其他项。
 * 牵头最后设：要先在频道里。返回没存上的错误，频道这时已经建好
 */
export async function createFromForm(
  actions: PresetCreateActions,
  head: Pick<ChannelInput, 'name' | 'topic' | 'projectId'>,
  form: PresetForm,
): Promise<{ id: string; failed: unknown[] }> {
  const id = await actions.createChannel({ ...head, memberIds: form.members })
  const failed: unknown[] = []
  await actions
    .updateChannel(id, {
      notes: form.notes.trim() || null,
      alerts: form.alerts,
      digestHour: form.digestHour,
      // 下面这些没写时就是默认值，和现在的新建一样不写进频道
      ...(form.relay ? { relay: true, relayRules: form.rules } : {}),
      ...(form.planFirst ? {} : { planFirst: false }),
      ...(form.leadRoute ? {} : { leadRoute: false }),
      ...(form.notify === 'all' ? {} : { notify: form.notify }),
    })
    .catch((e: unknown) => failed.push(e))
  if (form.lead && form.members.includes(form.lead))
    await actions.updateChannel(id, { lead: form.lead }).catch((e: unknown) => failed.push(e))
  return { id, failed }
}
