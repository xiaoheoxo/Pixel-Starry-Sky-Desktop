import { describe, expect, it } from 'vitest'
import type { AgentMember, Channel } from '@/data/types'
import type { AgentConfig } from '../../../../shared/types/channels'
import {
  COPY_SOURCE,
  PRESET_MAX,
  createFromForm,
  formFromPreset,
  membersElsewhere,
  parsePresets,
  planPresetMembers,
  presetFromChannel,
  projectAfterSwitch,
  refreshSource,
  sameForm,
  withPreset,
  withoutPreset,
  type ChannelPreset,
} from './presets'

const config = (id: string, projectId = 'p1'): AgentConfig => ({
  id,
  name: id,
  engine: 'claude',
  machineId: 'local',
  projectId,
  copyId: null,
  settings: { provider: { id: 'prov' } },
  instructions: '职责',
  mode: 'shared',
  sharedSessionId: 'session-1',
  bound: true,
  createdAt: 1,
})
const agent = (id: string, extra: Partial<AgentMember> = {}): AgentMember => ({
  id,
  kind: 'agent',
  name: id,
  engine: 'claude',
  model: null,
  machineId: 'local',
  machine: '本机',
  project: 'P1',
  status: 'idle',
  config: config(id),
  ...extra,
})
const channel = (extra: Partial<Channel> = {}): Channel => ({
  id: 'c1',
  name: '频道',
  topic: null,
  scope: 'local',
  memberIds: ['you', 'a', 'b'],
  unread: 0,
  createdAt: 1,
  ...extra,
})
const head = { id: 'x', name: '预设', updatedAt: 5 }

describe('parsePresets', () => {
  it('坏数据按空，单个坏条目跳过', () => {
    expect(parsePresets(null).items).toEqual([])
    expect(parsePresets('不是 json').items).toEqual([])
    expect(parsePresets('{"items":3}').items).toEqual([])
    const state = parsePresets(
      JSON.stringify({
        defaultId: 'gone',
        items: [
          { id: 'a', name: 'A', members: [{ sourceId: 's' }], relayRules: { hops: 'x' }, notify: 'bad' },
          { id: 3 },
        ],
      }),
    )
    expect(state.defaultId).toBeNull()
    expect(state.items).toEqual([{ id: 'a', name: 'A', updatedAt: 0, members: [] }])
  })
  it('存下去再读回来不变', () => {
    const preset = presetFromChannel(channel({ lead: 'a', relay: true }), [agent('a')], head)
    const text = JSON.stringify(withPreset({ defaultId: null, items: [] }, preset, true))
    expect(parsePresets(text)).toEqual({ defaultId: 'x', items: [preset] })
  })
})

describe('withPreset / withoutPreset', () => {
  const preset = (id: string): ChannelPreset => ({ id, name: id, updatedAt: 0 })
  it('同 id 覆盖；新增到上限报错，覆盖不受限', () => {
    const full = { defaultId: null, items: Array.from({ length: PRESET_MAX }, (_, i) => preset(`p${i}`)) }
    expect(() => withPreset(full, preset('new'), false)).toThrow()
    expect(withPreset(full, { ...preset('p0'), name: '改了' }, false).items[0].name).toBe('改了')
  })
  it('删默认预设后回到没有默认', () => {
    expect(withoutPreset({ defaultId: 'a', items: [preset('a')] }, 'a')).toEqual({ defaultId: null, items: [] })
  })
})

describe('presetFromChannel', () => {
  it('成员不带 id、会话和绑定，也不带机器', () => {
    const { members } = presetFromChannel(channel(), [agent('a')], head)
    expect(members?.[0].sourceId).toBe('a')
    expect(members?.[0].config).not.toHaveProperty('id')
    expect(members?.[0].config).not.toHaveProperty('sharedSessionId')
    expect(members?.[0].config).not.toHaveProperty('bound')
    expect(members?.[0].config).not.toHaveProperty('machineId')
    expect(members?.[0].config.settings).toEqual({ provider: { id: 'prov' } })
  })
  it('别人的成员、没有配置的成员、不在频道里的不进预设', () => {
    const list = [agent('a', { mine: false }), agent('b', { config: undefined }), agent('c')]
    expect(presetFromChannel(channel({ memberIds: ['a', 'b'] }), list, head).members).toEqual([])
  })
  it('没勾的部分不写', () => {
    const preset = presetFromChannel(channel({ notes: '说明', lead: 'a' }), [agent('a')], head, ['notes'])
    expect(preset).toEqual({ ...head, notes: '说明' })
  })
  it('牵头不在带上的成员里就不带', () => {
    expect(presetFromChannel(channel({ lead: 'a' }), [agent('b')], head).lead).toBeNull()
    expect(presetFromChannel(channel({ lead: 'a' }), [agent('a')], head, ['dispatch']).lead).toBeNull()
  })
})

describe('planPresetMembers / formFromPreset', () => {
  const preset = presetFromChannel(channel({ lead: 'b', planFirst: false }), [agent('a'), agent('b')], head)
  it('已删除的跳过，牵头被删时清掉', () => {
    const plan = planPresetMembers(preset, [agent('a')])
    expect(plan).toEqual({ usable: ['a'], deleted: ['b'] })
    const form = formFromPreset(preset, [agent('a')])
    expect(form.members).toEqual(['a'])
    expect(form.lead).toBe('')
    expect(form.planFirst).toBe(false)
  })
  it('勾选的成员里目录不同的才标出来；取消勾选、没设项目时不算', () => {
    const list = [agent('a'), agent('b', { config: config('b', 'p2'), project: 'P2' })]
    expect(membersElsewhere(['a', 'b'], list, 'p1').map(m => m.id)).toEqual(['b'])
    expect(membersElsewhere(['a'], list, 'p1')).toEqual([])
    expect(membersElsewhere(['a', 'b'], list, '')).toEqual([])
  })
  it('成员只是先后变了不算改动，换了人才算', () => {
    const base = { ...formFromPreset(null, []), members: ['a', 'b'] }
    expect(sameForm(base, { ...base, members: ['b', 'a'] })).toBe(true)
    expect(sameForm(base, { ...base, members: ['a'] })).toBe(false)
    expect(sameForm(base, { ...base, notes: '改了' })).toBe(false)
  })
  it('空白和现在的新建默认值一样', () => {
    expect(formFromPreset(null, [agent('a')])).toMatchObject({
      notes: '',
      members: [],
      relay: false,
      planFirst: true,
      leadRoute: true,
      lead: '',
      notify: 'all',
    })
  })
})

describe('refreshSource', () => {
  const preset: ChannelPreset = { id: 'p', name: '新名字', updatedAt: 2 }
  const source = { id: 'p', name: '旧名字', preset: { ...preset, name: '旧名字' } }
  it('选中的预设删除了返回 null，改名了跟着改', () => {
    expect(refreshSource(source, [])).toBeNull()
    expect(refreshSource(source, [preset])).toEqual({ id: 'p', name: '新名字', preset })
  })
  it('照着频道复制的不受预设列表影响', () => {
    const copy = { id: COPY_SOURCE, name: '#频道', preset: { ...preset, id: COPY_SOURCE } }
    expect(refreshSource(copy, [])).toBe(copy)
  })
})

describe('projectAfterSwitch', () => {
  it('新来源带项目就用它，带项目切到不带回到打开时的项目，手动改过的不动', () => {
    expect(projectAfterSwitch('p1', undefined, 'p2', 'p0')).toBe('p2')
    expect(projectAfterSwitch('p1', 'p1', undefined, 'p0')).toBe('p0')
    expect(projectAfterSwitch('p3', 'p1', undefined, 'p0')).toBe('p3')
    expect(projectAfterSwitch('p3', undefined, undefined, 'p0')).toBe('p3')
  })
})

describe('createFromForm', () => {
  const form = () => ({
    ...formFromPreset(null, []),
    members: ['a'],
    notes: ' 说明 ',
    relay: true,
    planFirst: false,
    lead: 'a',
  })
  const fake = (failOn?: (patch: Record<string, unknown>) => boolean) => {
    const calls: unknown[] = []
    return {
      calls,
      createChannel: async (input: unknown) => {
        calls.push(['create', input])
        return 'new'
      },
      updateChannel: async (id: string, patch: Record<string, unknown>) => {
        calls.push(['update', id, patch])
        if (failOn?.(patch)) throw new Error('失败')
      },
    }
  }
  it('先建频道带成员，再存设置，牵头最后设', async () => {
    const actions = fake()
    const result = await createFromForm(actions, { name: 'n', topic: null, projectId: 'p1' }, form())
    expect(result).toEqual({ id: 'new', failed: [] })
    expect(actions.calls[0]).toEqual(['create', { name: 'n', topic: null, projectId: 'p1', memberIds: ['a'] }])
    expect(actions.calls[1]).toMatchObject(['update', 'new', { notes: '说明', relay: true, planFirst: false }])
    expect(actions.calls[2]).toEqual(['update', 'new', { lead: 'a' }])
  })
  it('空白不写默认值', async () => {
    const actions = fake()
    await createFromForm(actions, { name: 'n' }, formFromPreset(null, []))
    const patch = (actions.calls[1] as unknown[])[2] as object
    expect(Object.keys(patch).sort()).toEqual(['alerts', 'digestHour', 'notes'])
    expect(actions.calls).toHaveLength(2)
  })
  it('互派关着时自定义规则也写，默认规则不写', async () => {
    const rules = { ...formFromPreset(null, []).rules, hops: 5 }
    const actions = fake()
    await createFromForm(actions, { name: 'n' }, { ...formFromPreset(null, []), rules })
    const patch = (actions.calls[1] as unknown[])[2] as Record<string, unknown>
    expect(patch.relayRules).toEqual(rules)
    expect(patch).not.toHaveProperty('relay')
    const withDefault = fake()
    await createFromForm(withDefault, { name: 'n' }, { ...formFromPreset(null, []), relay: true })
    expect((withDefault.calls[1] as unknown[])[2]).not.toHaveProperty('relayRules')
  })
  it('建频道失败时什么都不写', async () => {
    const actions = fake()
    actions.createChannel = () => Promise.reject(new Error('已经有同名的频道'))
    await expect(createFromForm(actions, { name: 'n' }, form())).rejects.toThrow('同名')
    expect(actions.calls).toEqual([])
  })
  it('设置没存上不连累牵头，失败项返回', async () => {
    const actions = fake(patch => 'notes' in patch)
    const result = await createFromForm(actions, { name: 'n' }, form())
    expect(result.failed).toHaveLength(1)
    expect(actions.calls.at(-1)).toEqual(['update', 'new', { lead: 'a' }])
  })
  it('牵头没被选上就不设', async () => {
    const actions = fake()
    await createFromForm(actions, { name: 'n' }, { ...form(), members: [] })
    expect(actions.calls).toHaveLength(2)
  })
})
