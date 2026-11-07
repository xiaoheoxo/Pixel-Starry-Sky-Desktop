// 新建 / 编辑频道、添加 / 编辑 AI 成员的对话框（docs/ui/channels-phase-b.md §3、§9）。只在正式模式用。
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { PERMISSION_MODES, type Effort, type EngineId, type PermissionMode } from '@pixelsky/protocol'
import { Button, cn, EngineIcon, IconButton, Segmented, Select, Switch, useToast, type SelectOption } from '@/ui'
import { formatTime } from '@/features/usage/format'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useEngineState, PERMISSION_INFO } from '@/features/engine'
import { useEngineCatalog } from '@/features/engine/catalog'
import { effortLabel } from '@/features/engine/labels'
import { effortDefaultsFor } from '@/features/engine/effortDefaults'
import { useMachines } from '@/features/machines/store'
import type { AgentMember, Channel } from '@/data/types'
import { relayRulesOf, type AgentConfig, type RelayRules } from '../../../../shared/types/channels'
import type { WorkspaceChoice } from '../../../../shared/types/machines'
import { channelActions, useChannels } from './store'
import { matchAgents, scheduleToInput } from './model'
import { RelayRulesEditor } from './RelayRules'
import { AlertRulesEditor } from './AlertRules'
import { CopyFromChannel, ManagePresetsDialog, PresetChooser, PresetSummary } from './ChannelPresets'
import {
  COPY_SOURCE,
  createFromForm,
  formFromPreset,
  membersElsewhere,
  planPresetMembers,
  presetFromChannel,
  projectAfterSwitch,
  refreshSource,
  sameForm,
  usePresets,
  type ChannelPreset,
  type PresetForm,
  type PresetSource,
} from './presets'
import { DIGEST_HOUR, alertRulesOf, type ChannelAlertRules } from '../../../../shared/channels/alerts'
import { MemberTools } from './MemberTools'
import { AiFilled, MemberQuickFill } from './MemberQuickFill'
import { PROMPT_CONTEXT_LIMIT, type AiMemberDraft, type MemberDraftField } from '../../../../shared/types/ai'
import { formatMultiplier, groupProblem, usePlatformCatalog } from '@/features/account/platform'
import { useProviders } from '@/features/account/providers'
import { channelLabel } from '@/features/model-channels/channelLabels'
import {
  applyDraft,
  memberDraftContext,
  modelChoices,
  modelForSource,
  pickRoute,
  platformRoutesFor,
  resolveRoute,
  routeModelsFor,
  settingsForSource,
  sourceKeyOf,
  sourceOptions,
  type DraftContext,
  type SourceContext,
  type SourceKey,
} from './agentSource'

const INPUT =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-composer-ring'

/** 频道的定时运行列表（docs/ui/channels-pipeline.md §10.3）：开关、删除马上存，不跟对话框的「保存」走 */
function ScheduleList({ channelId }: { channelId: string }) {
  useI18n()
  const toast = useToast()
  const list = useChannels(s => s.channels.find(c => c.id === channelId)?.schedules) ?? []
  // 整个列表一起存：存完（主进程推回新列表）之前不能再点，免得第二下按旧列表覆盖第一下
  const [busy, setBusy] = useState(false)
  const save = (next: typeof list) => {
    setBusy(true)
    return channelActions
      .updateChannel(channelId, { schedules: next.map(scheduleToInput) })
      .catch(e => toast(errorText(e)))
      .finally(() => setBusy(false))
  }
  return (
    <Field label={tr('channels.schedule.title')}>
      {list.length === 0 ? (
        <p className="text-meta text-fg-faint">{tr('channels.schedule.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {list.map(sc => (
            <li key={sc.id} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 text-ui text-fg">
                <span className="min-w-0 flex-1 truncate">{sc.title}</span>
                <span className="shrink-0 text-meta text-fg-muted">
                  {tr('channels.schedule.daily', { h: sc.hour })}
                </span>
                <Switch
                  size="sm"
                  checked={sc.enabled}
                  disabled={busy}
                  label={tr('channels.schedule.enable', { name: sc.title })}
                  onChange={on => void save(list.map(x => (x.id === sc.id ? { ...x, enabled: on } : x)))}
                />
                <IconButton
                  icon={Trash2}
                  iconSize={14}
                  size={26}
                  label={tr('channels.schedule.delete', { name: sc.title })}
                  disabled={busy}
                  onClick={() => void save(list.filter(x => x.id !== sc.id))}
                />
              </div>
              <span className="text-meta text-fg-faint">
                {sc.lastRunAt
                  ? tr('channels.schedule.lastRun', { time: formatTime(sc.lastRunAt) })
                  : tr('channels.schedule.never')}
              </span>
              {sc.lastError && <span className="text-meta text-warn">{translateMessage(sc.lastError)}</span>}
            </li>
          ))}
        </ul>
      )}
    </Field>
  )
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-fg-muted">{label}</span>
      {children}
      {hint}
    </label>
  )
}

const errorText = (error: unknown) => translateMessage((error as Error)?.message ?? String(error))

/** Fast / Ultracode：跟随引擎设置、开、关 */
type Toggle = 'follow' | 'on' | 'off'
const toggleOf = (v: boolean | undefined): Toggle => (v === undefined ? 'follow' : v ? 'on' : 'off')
const toggleValue = (t: Toggle): boolean | undefined => (t === 'follow' ? undefined : t === 'on')

/** 项目下拉：机器没连上的项目不能选 */
function useProjectOptions(): SelectOption<string>[] {
  const projects = useEngineState(s => s.projects)
  const { machines } = useMachines()
  return useMemo(
    () =>
      projects.map(p => {
        const machine = machines.find(m => p.id.startsWith(`${m.id}~`))
        const offline = !!machine && machine.status !== 'connected'
        return {
          value: p.id,
          label: p.name,
          hint: machine ? machine.name : tr('channels.thisComputer'),
          disabled: offline,
          description: offline ? tr('channels.agent.disconnected') : undefined,
        }
      }),
    [projects, machines],
  )
}

// ---------------------------------------------------------------------------
// 频道
// ---------------------------------------------------------------------------

/** 照着频道建时不带它的默认项目：和「存为预设」的默认一样，用当前打开的项目 */
const COPY_PARTS = ['members', 'dispatch', 'notes', 'alerts'] as const

/** 新建频道时 AI 成员超过这么多个，列表上面多一个搜索框 */
const MEMBER_SEARCH_MIN = 8

/** 新建频道（channel 为空）或编辑频道的名字、主题、默认项目 */
export function ChannelDialog({
  channel,
  agents,
  teamId,
  onClose,
}: {
  channel: Channel | null
  /** 可以一起加进来的已有 AI 成员（新建时） */
  agents: readonly AgentMember[]
  /** Phase C：新建团队频道。团队频道没有默认项目，也不在这里选 AI 成员（进频道后再加自己的） */
  teamId?: string | null
  onClose: () => void
}) {
  useI18n()
  const projectOptions = useProjectOptions()
  const currentProject = useEngineState(s => s.currentProjectId)
  const teamName = useChannels(s => {
    const id = teamId ?? channel?.teamId
    return id ? (s.teams.find(t => t.id === id)?.name ?? null) : null
  })
  const inTeam = !!teamId || channel?.scope === 'team'
  const creating = !channel && !inTeam
  // 频道预设（docs/ui/channel-presets.md）：打开新建时选中默认预设
  const presets = usePresets()
  const [source, setSource] = useState<PresetSource | null>(() => {
    const preset = creating ? presets.items.find(p => p.id === presets.defaultId) : undefined
    return preset ? { id: preset.id, name: preset.name, preset } : null
  })
  const [pending, setPending] = useState<PresetSource | null | undefined>(undefined)
  const [expanded, setExpanded] = useState(false)
  const [copying, setCopying] = useState(false)
  const [managing, setManaging] = useState(false)
  const copyable = useChannels(s => s.channels).filter(c => c.scope === 'local')
  // 表单的基准：选了预设就是预设的值，只选预设不算改动
  const [base, setBase] = useState<PresetForm>(() =>
    channel
      ? {
          notes: channel.notes ?? '',
          members: [],
          relay: channel.relay === true,
          rules: relayRulesOf(channel),
          planFirst: channel.planFirst !== false,
          leadRoute: channel.leadRoute !== false,
          lead: channel.lead ?? '',
          notify: channel.notify ?? 'all',
          alerts: alertRulesOf(channel),
          digestHour: channel.digestHour ?? DIGEST_HOUR,
        }
      : formFromPreset(source?.preset ?? null, agents),
  )
  const projectOf = (preset: ChannelPreset | undefined): string | undefined =>
    preset?.projectId === undefined
      ? undefined
      : !preset.projectId || projectOptions.some(o => o.value === preset.projectId)
        ? (preset.projectId ?? '')
        : undefined
  const [name, setName] = useState(channel?.name ?? '')
  const [topic, setTopic] = useState(channel?.topic ?? '')
  const [notes, setNotes] = useState(base.notes)
  const [openedProject] = useState(currentProject ?? '')
  const [projectId, setProjectId] = useState<string>(
    channel ? (channel.projectId ?? '') : (projectOf(source?.preset) ?? currentProject ?? ''),
  )
  const [members, setMembers] = useState<string[]>(base.members)
  const [memberQuery, setMemberQuery] = useState('')
  const [relay, setRelay] = useState(base.relay)
  const [lead, setLead] = useState(base.lead)
  const [planFirst, setPlanFirst] = useState(base.planFirst)
  const [leadRoute, setLeadRoute] = useState(base.leadRoute)
  const channelMembers = useChannels(s => s.members)
  const leadOptions = channelMembers.filter(
    m => m.kind === 'agent' && m.machineId === 'local' && (channel ? channel.memberIds : members).includes(m.id),
  )
  const [rules, setRules] = useState<RelayRules>(base.rules)
  // 主动提醒（docs/ui/channels-collab-v2.md §6）
  const [alerts, setAlerts] = useState<ChannelAlertRules>(base.alerts)
  const [digestHour, setDigestHour] = useState(base.digestHour)
  // 表单里没有提醒级别（在成员面板改），只有预设会带
  const [notify, setNotify] = useState(base.notify)
  const form: PresetForm = { notes, members, relay, rules, planFirst, leadRoute, lead, notify, alerts, digestHour }
  const changed = !sameForm(form, base)
  const applySource = (next: PresetSource | null): void => {
    const values = formFromPreset(next?.preset ?? null, agents)
    setSource(next)
    setBase(values)
    setNotes(values.notes)
    setMembers(values.members)
    setRelay(values.relay)
    setRules(values.rules)
    setPlanFirst(values.planFirst)
    setLeadRoute(values.leadRoute)
    setLead(values.lead)
    setNotify(values.notify)
    setAlerts(values.alerts)
    setDigestHour(values.digestHour)
    setProjectId(projectAfterSwitch(projectId, projectOf(source?.preset), projectOf(next?.preset), openedProject))
    setExpanded(false)
    setCopying(false)
    setPending(undefined)
  }
  // 切换来源会丢掉刚才的修改：改过就先问
  const pickSource = (next: PresetSource | null): void => {
    if (changed) setPending(next)
    else applySource(next)
  }
  const pickPreset = (id: string | null): void => {
    const preset = id ? presets.items.find(p => p.id === id) : undefined
    pickSource(preset ? { id: preset.id, name: preset.name, preset } : null)
  }
  const deletedMembers = source ? planPresetMembers(source.preset, agents).deleted : []
  // 管理预设回来：选中的预设删除了就回到空白，改名了跟着改（表单里的修改留着）
  const closeManage = (): void => {
    setManaging(false)
    if (!source) return
    const next = refreshSource(source, presets.items)
    if (next) setSource(next)
    else applySource(null)
  }
  // 牵头被取消勾选时下拉框显示「不启用」；再勾回来还是它
  const leadShown = leadOptions.some(m => m.id === lead) ? lead : ''
  const showForm = !source || expanded
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  // 名称、主题、说明是自己打的字：改过就先问再关（取消 / Esc / 点背景）
  const dirty = name !== (channel?.name ?? '') || topic !== (channel?.topic ?? '') || changed
  const submit = () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    const input = { name, topic: topic.trim() || null, projectId: inTeam ? null : projectId || null }
    // 频道建好后设置才存得上（建频道的接口不带它们）。没存上时频道已经建好（也切过去了）：照样关掉对话框，提示一下
    const done = channel
      ? channelActions.updateChannel(
          channel.id,
          inTeam
            ? { name, topic: input.topic }
            : {
                ...input,
                notes: notes.trim() || null,
                relay,
                relayRules: rules,
                alerts,
                digestHour,
                ...(lead !== base.lead ? { lead: lead || null } : {}),
                ...(planFirst !== base.planFirst ? { planFirst } : {}),
                ...(leadRoute !== base.leadRoute ? { leadRoute } : {}),
              },
        )
      : teamId
        ? channelActions.createChannel({ ...input, teamId })
        : createFromForm(channelActions, input, form).then(({ failed }) => {
            for (const e of failed) toast(tr('channels.dialog.notesFailed', { error: errorText(e) }))
          })
    done.then(onClose, e => {
      setError(errorText(e))
      setBusy(false)
    })
  }
  if (managing) return <ManagePresetsDialog onClose={closeManage} />
  return (
    <ConfirmDialog
      wide={creating && presets.items.length > 0}
      title={tr(channel ? 'channels.dialog.editTitle' : 'channels.dialog.newTitle')}
      confirmLabel={tr(channel ? 'channels.dialog.save' : 'channels.dialog.create')}
      cancelLabel={tr('channels.dialog.cancel')}
      busy={busy}
      error={error}
      focusInput
      confirmDisabled={!name.trim()}
      dirty={dirty}
      onConfirm={submit}
      onCancel={onClose}
      description={
        <form
          className="flex flex-col gap-3"
          onSubmit={e => {
            e.preventDefault()
            submit()
          }}
        >
          {creating && (
            <PresetChooser
              active={source?.id ?? null}
              canCopy={copyable.length > 0}
              onPick={pickPreset}
              onCopy={() => setCopying(on => !on)}
              onManage={() => setManaging(true)}
            />
          )}
          {pending !== undefined && (
            <div
              data-preset-switch
              className="flex flex-wrap items-center gap-3 rounded-md bg-subtle px-2.5 py-2 text-meta"
            >
              <span className="min-w-0 flex-1 text-fg-secondary">{tr('channels.preset.switchAsk')}</span>
              <button
                type="button"
                className="press text-accent-fg hover:underline"
                onClick={() => setPending(undefined)}
              >
                {tr('channels.preset.switchNo')}
              </button>
              <button type="button" className="press text-danger hover:underline" onClick={() => applySource(pending)}>
                {tr('channels.preset.switchYes')}
              </button>
            </div>
          )}
          <Field label={tr('channels.dialog.name')}>
            <input value={name} maxLength={40} onChange={e => setName(e.target.value)} className={INPUT} />
          </Field>
          <Field label={tr('channels.dialog.topic')}>
            <input value={topic} maxLength={200} onChange={e => setTopic(e.target.value)} className={INPUT} />
          </Field>
          {copying && (
            <CopyFromChannel
              channels={copyable}
              members={agents}
              onCancel={() => setCopying(false)}
              onPick={c =>
                pickSource({
                  id: COPY_SOURCE,
                  name: `#${c.name}`,
                  preset: presetFromChannel(c, agents, { id: COPY_SOURCE, name: c.name, updatedAt: 0 }, COPY_PARTS),
                })
              }
            />
          )}
          {source && expanded && (
            <div className="flex items-baseline justify-between gap-3 text-meta text-fg-muted">
              <span>{tr('channels.preset.formHint')}</span>
              <span className="flex shrink-0 gap-3">
                <button
                  type="button"
                  disabled={!changed}
                  className="press text-accent-fg hover:underline disabled:text-fg-faint disabled:no-underline"
                  onClick={() => applySource(source)}
                >
                  {tr('channels.preset.reset')}
                </button>
                <button
                  type="button"
                  className="press text-accent-fg hover:underline"
                  onClick={() => setExpanded(false)}
                >
                  {tr('channels.preset.collapse')}
                </button>
              </span>
            </div>
          )}
          {!inTeam && showForm && (
            <Field label={tr('channels.dialog.notes')}>
              <textarea
                value={notes}
                maxLength={2000}
                rows={3}
                placeholder={tr('channels.dialog.notesHint')}
                onChange={e => setNotes(e.target.value)}
                className={cn(INPUT, 'resize-none')}
              />
            </Field>
          )}
          {!inTeam && showForm && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                data-channel-relay
                className="mt-0.5"
                checked={relay}
                onChange={e => setRelay(e.target.checked)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-list text-fg">{tr('channels.dialog.relay')}</span>
                <span className="text-meta text-fg-muted">{tr('channels.dialog.relayHint')}</span>
              </span>
            </label>
          )}
          {!inTeam && showForm && relay && <RelayRulesEditor value={rules} onChange={setRules} />}
          {!inTeam && (channel || (source && expanded)) && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                data-channel-plan-first
                className="mt-0.5"
                checked={planFirst}
                onChange={e => setPlanFirst(e.target.checked)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-list text-fg">{tr('channels.dialog.planFirst')}</span>
                <span className="text-meta text-fg-muted">{tr('channels.dialog.planFirstHint')}</span>
              </span>
            </label>
          )}
          {!inTeam && (channel || (source && expanded)) && (
            <Field
              label={tr('channels.dialog.lead')}
              hint={<span className="text-meta text-fg-muted">{tr('channels.dialog.leadHint')}</span>}
            >
              <Select
                label={tr('channels.dialog.lead')}
                value={leadShown}
                options={[
                  { value: '', label: tr('channels.dialog.leadNone') },
                  ...leadOptions.map(m => ({ value: m.id, label: m.name })),
                ]}
                onChange={setLead}
              />
              {leadShown && (
                <label className="mt-1.5 flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-channel-lead-route
                    className="mt-0.5"
                    checked={leadRoute}
                    onChange={e => setLeadRoute(e.target.checked)}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-list text-fg">{tr('channels.dialog.leadRoute')}</span>
                    <span className="text-meta text-fg-muted">{tr('channels.dialog.leadRouteHint')}</span>
                  </span>
                </label>
              )}
            </Field>
          )}
          {!inTeam && channel && <ScheduleList channelId={channel.id} />}
          {!inTeam && showForm && (
            <AlertRulesEditor
              value={alerts}
              digestHour={digestHour}
              onChange={setAlerts}
              onDigestHour={setDigestHour}
            />
          )}
          {inTeam ? (
            teamName && <p className="text-meta text-fg-faint">{tr('team.channel.inTeam', { name: teamName })}</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-fg-muted">{tr('channels.dialog.project')}</span>
              <Select
                label={tr('channels.dialog.project')}
                value={projectId}
                options={[{ value: '', label: tr('channels.dialog.noProject') }, ...projectOptions]}
                onChange={setProjectId}
                className="w-full"
              />
            </div>
          )}
          {creating && showForm && agents.length > 0 && (
            <fieldset aria-label={tr('channels.dialog.members')} className="flex flex-col gap-1.5">
              {/* 成员多时不把弹窗撑开：列表在框里滚动（约 6 行），超过 8 个可以搜（docs/ui/channel-dialog-overflow-mockup.html） */}
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-meta font-medium text-fg-muted">
                  {tr('channels.dialog.members')}
                  {members.length > 0 && (
                    <span className="ml-1.5 font-normal text-fg-faint">
                      {tr('channels.dialog.membersPicked', { n: members.length })}
                    </span>
                  )}
                </span>
                {members.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setMembers([])}
                    className="press text-meta text-accent-fg hover:underline"
                  >
                    {tr('channels.dialog.membersClear')}
                  </button>
                )}
              </div>
              {agents.length > MEMBER_SEARCH_MIN && (
                <input
                  value={memberQuery}
                  onChange={e => setMemberQuery(e.target.value)}
                  // 在搜索框里回车不提交表单（不然一回车就建好了频道）
                  onKeyDown={e => {
                    if (e.key === 'Enter') e.preventDefault()
                  }}
                  placeholder={tr('channels.dialog.membersSearch')}
                  aria-label={tr('channels.dialog.membersSearch')}
                  spellCheck={false}
                  className="h-8 rounded-md border border-line bg-subtle px-2.5 text-meta text-fg outline-none placeholder:text-fg-faint focus:border-line-strong focus:bg-surface"
                />
              )}
              <div className="flex max-h-[212px] flex-col gap-0.5 overflow-y-auto rounded-lg border border-line-card p-1 [scrollbar-width:thin]">
                {matchAgents(agents, memberQuery).length === 0 && (
                  <p className="px-1.5 py-1.5 text-meta text-fg-faint">{tr('channels.dialog.membersNoMatch')}</p>
                )}
                {matchAgents(agents, memberQuery).map(a => (
                  <label key={a.id} className="flex h-8 shrink-0 items-center gap-2 rounded-md px-1.5 hover:bg-hover">
                    <input
                      type="checkbox"
                      checked={members.includes(a.id)}
                      onChange={e =>
                        setMembers(list => (e.target.checked ? [...list, a.id] : list.filter(id => id !== a.id)))
                      }
                    />
                    <EngineIcon engine={a.engine} size={14} />
                    <span className="min-w-0 truncate text-list text-fg">{a.name}</span>
                    {a.project && <span className="ml-auto shrink-0 text-meta text-fg-faint">{a.project}</span>}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {source && !expanded && !copying && (
            <PresetSummary
              source={source.name}
              form={form}
              agents={agents}
              deleted={deletedMembers}
              elsewhere={membersElsewhere(members, agents, projectId)}
              onExpand={() => setExpanded(true)}
            />
          )}
          <button type="submit" hidden />
        </form>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// AI 成员
// ---------------------------------------------------------------------------

const TEMPLATES = [
  ['channels.agent.template.frontend', 'channels.agent.template.frontendText'],
  ['channels.agent.template.review', 'channels.agent.template.reviewText'],
  ['channels.agent.template.docs', 'channels.agent.template.docsText'],
  ['channels.agent.template.release', 'channels.agent.template.releaseText'],
] as const

/** Git 副本列表（主工作树 + 副本） */
function useCopies(projectId: string): WorkspaceChoice[] {
  const [copies, setCopies] = useState<WorkspaceChoice[]>([])
  useEffect(() => {
    setCopies([])
    if (!projectId || !window.pixelsky?.machines) return
    let alive = true
    window.pixelsky.machines
      .workspaces(projectId)
      .then(list => {
        if (alive) setCopies(list.filter(w => w.projectId === projectId))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [projectId])
  return copies
}

/**
 * 添加 AI 成员（docs/ui/channels-phase-b.md §3）：从已有成员添加，或新建一个；
 * editing 不为空时编辑这个成员（改了只影响以后派的活）。
 */
export function AgentDialog({
  channel,
  editing,
  others,
  onClose,
}: {
  channel: Channel
  editing: AgentConfig | null
  /** 还不在这个频道里的已有成员 */
  others: readonly AgentMember[]
  onClose: () => void
}) {
  useI18n()
  const engines = useEngineState(s => s.engines)
  const currentProject = useEngineState(s => s.currentProjectId)
  const projectOptions = useProjectOptions()
  const ready = engines.filter(e => e.status === 'ready' && (e.id === 'claude' || e.id === 'codex' || e.id === 'pixel'))
  const [name, setName] = useState(editing?.name ?? '')
  const [engine, setEngine] = useState<EngineId>(editing?.engine ?? ready[0]?.id ?? 'claude')
  const firstProject = channel.projectId ?? currentProject ?? projectOptions.find(o => !o.disabled)?.value ?? ''
  const [projectId, setProjectId] = useState(editing?.projectId ?? firstProject)
  const [copyId, setCopyId] = useState<string>(editing?.copyId ?? '')
  const [model, setModel] = useState<string>(editing?.settings.model ?? '')
  const [source, setSource] = useState<SourceKey>(sourceKeyOf(editing?.settings))
  // 平台线路：记的是用户选的那条，实际用哪条按模型对齐（resolveRoute）；swap 是换线路时顺手换掉的模型，可以撤销
  const [groupId, setGroupId] = useState<string | null>(editing?.settings.platform?.groupId ?? null)
  const [swap, setSwap] = useState<{ groupId: string | null; model: string; to: string } | null>(null)
  const [permission, setPermission] = useState<PermissionMode | ''>(editing?.settings.permissionMode ?? '')
  // 推理强度那几项（docs/ui/channels-pipeline.md 第 19 项）：'' / follow = 跟随引擎设置里的默认
  const [effort, setEffort] = useState<Effort | ''>(editing?.settings.effort ?? '')
  const [fast, setFast] = useState<Toggle>(toggleOf(editing?.settings.fast))
  const [ultracode, setUltracode] = useState<Toggle>(toggleOf(editing?.settings.ultracode))
  const engineConfig = useEngineState(s => s.config)
  const engineDefaults = useEngineState(s => s.defaults)
  const [instructions, setInstructions] = useState(editing?.instructions ?? '')
  const [mode, setMode] = useState<AgentConfig['mode']>(editing?.mode ?? 'per-task')
  const [tools, setTools] = useState<AgentConfig['tools']>(editing?.tools ?? null)
  // 一句话建成员（docs/ui/channels-member-quickstart-memory.md §A）：AI 填过的字段 → 为什么；用户改了这个字段就去掉
  const [ai, setAi] = useState<Partial<Record<MemberDraftField, string>>>({})
  const [drafted, setDrafted] = useState(false)
  const [quick, setQuick] = useState({ typed: false, running: false })
  const unmark = (...keys: MemberDraftField[]) =>
    setAi(a => {
      if (!keys.some(k => k in a)) return a
      const next = { ...a }
      for (const k of keys) delete next[k]
      return next
    })
  const allMembers = useChannels(s => s.members)
  // 名字和职责说明（最长 2000 字）是自己打的字、AI 填过表：改过就先问再关
  const dirty =
    drafted || quick.typed || name !== (editing?.name ?? '') || instructions !== (editing?.instructions ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copies = useCopies(projectId)
  const catalog = useEngineCatalog(engine)
  const platform = usePlatformCatalog()
  const { providers } = useProviders()
  const sourceCtx: SourceContext = { email: platform.email, groups: platform.groups, providers }
  const ownModels = (catalog?.models ?? []).map(m => ({ id: m.id, label: m.label }))
  // 额度来源（docs/ui/channels-local-ai.md §3.1 #1）：自有账号 / 像素星空平台 / 这个引擎能用的自定义接口
  const selfHint =
    engine === 'claude' ? channelLabel('claude') : engine === 'codex' ? channelLabel('chatgpt') : undefined
  const sourceSelect: SelectOption<SourceKey>[] = sourceOptions(engine, sourceCtx).map(o =>
    o.kind === 'self'
      ? { value: o.value, label: tr('channels.agent.source.self'), hint: selfHint }
      : o.kind === 'platform'
        ? {
            value: o.value,
            label: tr('channels.agent.source.platform'),
            disabled: !!o.disabled && source !== 'platform',
            description: o.disabled
              ? tr(o.disabled === 'signin' ? 'channels.agent.source.signin' : 'channels.agent.source.noRoute')
              : undefined,
          }
        : { value: o.value, label: o.name ?? o.value, hint: channelLabel('custom') },
  )
  // 编辑时原来的接口已经删了：留一项，保存时提示
  if (source.startsWith('custom:') && !sourceSelect.some(o => o.value === source))
    sourceSelect.push({ value: source, label: tr('channels.agent.source.providerGone'), disabled: true })
  const choices = modelChoices(engine, source, sourceCtx, ownModels)
  const modelOptions: SelectOption<string>[] =
    source === 'self'
      ? [
          { value: '', label: tr('channels.agent.default') },
          ...ownModels.map(m => ({ value: m.id, label: m.label, hint: m.id !== m.label ? m.id : undefined })),
          ...(model && !ownModels.some(m => m.id === model) ? [{ value: model, label: model }] : []),
        ]
      : [
          ...choices.map(m => ({ value: m.id, label: m.label })),
          ...(model && !choices.some(m => m.id === model) ? [{ value: model, label: model }] : []),
        ]
  const pickSource = (key: SourceKey): void => {
    unmark('source', 'model')
    setSource(key)
    setModel(modelForSource(engine, key, model, sourceCtx, ownModels))
  }
  // 线路（只有额度来源是像素星空平台时显示）：列出这个引擎能用的全部线路，没有当前模型的写明会换成哪个
  const routeId = source === 'platform' ? resolveRoute(engine, platform.groups, groupId, model).groupId : null
  const route = platform.groups.find(g => g.id === routeId)
  const routeOptions: SelectOption<string>[] = platformRoutesFor(engine, platform.groups).map(g => {
    const models = routeModelsFor(engine, g)
    return {
      value: g.id,
      label: g.name,
      hint: formatMultiplier(g.rate_multiplier),
      disabled: models.length === 0,
      description: !models.length
        ? (groupProblem(g, null) ?? tr('channels.agent.route.noModels'))
        : model && !models.includes(model)
          ? tr('channels.agent.route.swap', { model, next: models[0] })
          : g.description || undefined,
    }
  })
  const pickGroup = (id: string): void => {
    const next = pickRoute(engine, platform.groups, id, model)
    if (!next) return
    if (next.model !== model) unmark('model')
    setSwap(next.model !== model ? { groupId: routeId, model, to: next.model } : null)
    setGroupId(next.groupId)
    setModel(next.model)
  }
  const swapped = swap && route && swap.to === model ? swap : null
  const permissionOptions: SelectOption<PermissionMode | ''>[] = [
    { value: '', label: tr('channels.agent.default') },
    ...PERMISSION_MODES.filter(
      m => engines.find(e => e.id === engine)?.caps.permissionModes.includes(m) ?? m !== 'auto',
    ).map(m => ({ value: m, label: PERMISSION_INFO[m].label, hint: PERMISSION_INFO[m].hint })),
  ]
  // 推理强度那几项按执行者能力显示（和会话里的菜单同一套：模型目录里的档位优先，没有就用引擎能力表）
  const caps = engines.find(e => e.id === engine)?.caps
  const efforts = (model && catalog?.models?.find(m => m.id === model)?.efforts) || caps?.efforts || []
  // 换了执行者或模型、原来的档位不在了：退回跟随默认；引擎还没加载出能力表时原样保留
  const effortValue: Effort | '' = effort && (!caps || efforts.includes(effort)) ? effort : ''
  const hasFast = caps ? caps.fast : true
  const hasUltracode = caps ? caps.ultracode : true
  const panelDefaults = effortDefaultsFor(engineConfig, engineDefaults, engine)
  const onOff = (v: boolean) => tr(v ? 'channels.agent.on' : 'channels.agent.off')
  const followLabel = (value: string) => tr('channels.agent.follow', { value })
  const effortOptions: SelectOption<Effort | ''>[] = [
    { value: '', label: followLabel(effortLabel(panelDefaults.effort)) },
    ...efforts.map(e => ({ value: e, label: effortLabel(e) })),
  ]
  const toggleOptions = (dflt: boolean): SelectOption<Toggle>[] => [
    { value: 'follow', label: followLabel(onOff(dflt)) },
    { value: 'on', label: tr('channels.agent.on') },
    { value: 'off', label: tr('channels.agent.off') },
  ]
  const draftCtx = (): DraftContext => ({
    ready: ready.map(e => ({ id: e.id, name: e.name, caps: e.caps })),
    engine,
    source,
    model,
    groupId,
    ownModels,
    sourceCtx,
    names: allMembers.filter(m => m.kind === 'agent' && m.mine !== false && !m.teamAgentId).map(m => m.name),
  })
  const applyAi = (draft: AiMemberDraft): number => {
    const { values: v, fields } = applyDraft(draft, draftCtx())
    if (!Object.keys(fields).length) return 0
    if (v.name !== undefined) setName(v.name)
    if (v.engine) setEngine(v.engine)
    if (v.source) {
      setSource(v.source)
      setModel(v.model ?? '')
      setGroupId(v.groupId ?? null)
      setSwap(null)
    }
    if (v.permission) setPermission(v.permission)
    if (v.effort) setEffort(v.effort)
    if (v.fast !== undefined) setFast(v.fast ? 'on' : 'off')
    if (v.ultracode !== undefined) setUltracode(v.ultracode ? 'on' : 'off')
    if (v.instructions) setInstructions(v.instructions)
    if (v.mode) setMode(v.mode)
    const count = Object.keys(fields).length
    // 合进原来的标记：这次没碰的字段还是上次 AI 填的；来源、模型被换掉但这次没标的，旧标记去掉
    setAi(a => {
      const next = { ...a, ...fields }
      if (v.source && !('source' in fields)) delete next.source
      if (v.source && !('model' in fields)) delete next.model
      return next
    })
    setDrafted(true)
    return count
  }
  const canSave =
    !!name.trim() && !!projectId && (ready.some(e => e.id === engine) || !!editing) && (source === 'self' || !!model)

  const run = (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    fn().then(onClose, e => {
      setError(errorText(e))
      setBusy(false)
    })
  }
  const submit = () => {
    if (!canSave) return
    // async：来源不能用时 settingsForSource 抛的错也走 run 的错误提示
    run(async () =>
      channelActions.saveMember(editing ? null : channel.id, {
        ...(editing ? { id: editing.id } : {}),
        name,
        engine,
        projectId,
        copyId: copyId || null,
        settings: {
          ...settingsForSource(engine, source, model, sourceCtx, routeId),
          ...(effortValue ? { effort: effortValue } : {}),
          ...(hasFast && toggleValue(fast) !== undefined ? { fast: toggleValue(fast) } : {}),
          ...(hasUltracode && toggleValue(ultracode) !== undefined ? { ultracode: toggleValue(ultracode) } : {}),
          ...(permission ? { permissionMode: permission } : {}),
        },
        instructions,
        mode,
        tools,
      }),
    )
  }

  return (
    <ConfirmDialog
      title={editing ? tr('channels.agent.editTitle', { name: editing.name }) : tr('channels.agent.addTitle')}
      confirmLabel={tr(editing ? 'channels.dialog.save' : 'channels.agent.add')}
      cancelLabel={tr('channels.dialog.cancel')}
      busy={busy}
      error={error}
      focusInput={!!editing || others.length === 0}
      confirmDisabled={!canSave || quick.running}
      dirty={dirty}
      onConfirm={submit}
      onCancel={onClose}
      description={
        <div className="-mx-1 flex max-h-[min(60vh,560px)] flex-col gap-4 overflow-y-auto px-1 [scrollbar-width:thin]">
          {!editing && others.length > 0 && (
            <section className="flex flex-col gap-1">
              <h4 className="text-meta font-medium text-fg-muted">{tr('channels.agent.existing')}</h4>
              {others.map(a => (
                <div key={a.id} className="flex h-9 items-center gap-2 rounded-md px-1 hover:bg-hover">
                  <EngineIcon engine={a.engine} size={14} />
                  <span className="min-w-0 truncate text-list text-fg">{a.name}</span>
                  <span className="min-w-0 flex-1 truncate text-meta text-fg-faint">{a.project}</span>
                  <Button
                    className="h-7 shrink-0 px-2.5 text-meta"
                    disabled={busy}
                    onClick={() => run(() => channelActions.addMember(channel.id, a.id))}
                  >
                    {tr('channels.agent.add')}
                  </Button>
                </div>
              ))}
              <h4 className="mt-3 border-t border-line-subtle pt-3 text-meta font-medium text-fg-muted">
                {tr('channels.agent.new')}
              </h4>
            </section>
          )}
          {!editing && (
            <MemberQuickFill
              context={() => memberDraftContext(draftCtx(), PROMPT_CONTEXT_LIMIT)}
              apply={applyAi}
              onState={setQuick}
            />
          )}
          <form
            inert={quick.running}
            className={cn('flex flex-col gap-3', quick.running && 'opacity-60')}
            onSubmit={e => {
              e.preventDefault()
              submit()
            }}
          >
            <Field label={tr('channels.agent.name')}>
              <input
                value={name}
                maxLength={40}
                onChange={e => {
                  setName(e.target.value)
                  unmark('name')
                }}
                className={INPUT}
              />
            </Field>
            <AiFilled field={tr('channels.agent.name')} reason={ai.name} />
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.engine')}</span>
              {ready.length ? (
                <Segmented
                  label={tr('channels.agent.engine')}
                  value={engine}
                  options={ready.map(e => ({ value: e.id, label: e.version ? `${e.name} ${e.version}` : e.name }))}
                  onChange={v => {
                    unmark('engine', 'source', 'model')
                    setEngine(v)
                    // 自动审核只有部分引擎有：换到没有的引擎就退回跟随默认，不留一个选择框里没有的值
                    if (permission && !engines.find(e => e.id === v)?.caps.permissionModes.includes(permission))
                      setPermission('')
                    // 换了引擎：来源这个引擎用不了（接口协议不对、平台没线路）就回到自有账号
                    const keep = sourceOptions(v, sourceCtx).some(o => o.value === source && !o.disabled)
                    setSource(keep ? source : 'self')
                    setModel(keep && source !== 'self' ? modelForSource(v, source, model, sourceCtx, []) : '')
                  }}
                />
              ) : (
                <p className="text-meta text-warn">{tr('channels.agent.noEngine')}</p>
              )}
              <AiFilled field={tr('channels.agent.engine')} reason={ai.engine} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.project')}</span>
              {projectOptions.length ? (
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                  <Select
                    label={tr('channels.agent.project')}
                    value={projectId}
                    options={projectOptions}
                    onChange={v => {
                      setProjectId(v)
                      setCopyId('')
                    }}
                  />
                  <Select
                    label={tr('channels.agent.mainTree')}
                    value={copyId}
                    options={[
                      { value: '', label: tr('channels.agent.mainTree') },
                      ...copies
                        .filter(c => c.copyId)
                        .map(c => ({ value: c.copyId!, label: c.name, hint: c.branch ?? undefined })),
                    ]}
                    onChange={setCopyId}
                  />
                </div>
              ) : (
                <p className="text-meta text-warn">{tr('channels.agent.noProjects')}</p>
              )}
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.source')}</span>
                <Select
                  label={tr('channels.agent.source')}
                  value={source}
                  options={sourceSelect}
                  onChange={pickSource}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.model')}</span>
                {modelOptions.length ? (
                  <Select
                    label={tr('channels.agent.model')}
                    value={model}
                    options={modelOptions}
                    onChange={v => {
                      setModel(v)
                      unmark('model')
                    }}
                    mono
                  />
                ) : (
                  <p className="flex h-8 items-center text-meta text-warn">{tr('channels.agent.source.noModels')}</p>
                )}
              </div>
            </div>
            <AiFilled field={tr('channels.agent.source')} reason={ai.source} />
            <AiFilled field={tr('channels.agent.model')} reason={ai.model} />
            {source === 'platform' && routeOptions.length > 0 && (
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.route')}</span>
                <Select
                  label={tr('channels.agent.route')}
                  value={routeId ?? ''}
                  options={routeOptions}
                  onChange={pickGroup}
                />
                {swapped ? (
                  <p className="flex items-center gap-2 text-meta text-warn">
                    <span className="min-w-0 flex-1">
                      {tr('channels.agent.route.swapped', { model: swapped.model, next: swapped.to })}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 font-medium text-accent-fg hover:underline"
                      onClick={() => {
                        setGroupId(swapped.groupId)
                        setModel(swapped.model)
                        setSwap(null)
                      }}
                    >
                      {tr('channels.agent.route.undo')}
                    </button>
                  </p>
                ) : (
                  route && (
                    <p className="text-meta text-fg-faint">
                      {tr('channels.agent.route.facts', {
                        rate: Number(route.rate_multiplier.toFixed(3)),
                        count: routeModelsFor(engine, route).length,
                      })}
                    </p>
                  )
                )}
              </div>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.permission')}</span>
                <Select
                  label={tr('channels.agent.permission')}
                  value={permission}
                  options={permissionOptions}
                  onChange={v => {
                    setPermission(v)
                    unmark('permission')
                  }}
                />
              </div>
              {efforts.length > 0 && (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.effort')}</span>
                  <Select
                    label={tr('channels.agent.effort')}
                    value={effortValue}
                    options={effortOptions}
                    onChange={v => {
                      setEffort(v)
                      unmark('effort')
                    }}
                  />
                </div>
              )}
            </div>
            {(caps?.fast || caps?.ultracode) && (
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                {caps.fast && (
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.fast')}</span>
                    <Select
                      label={tr('channels.agent.fast')}
                      value={fast}
                      options={toggleOptions(panelDefaults.fast)}
                      onChange={v => {
                        setFast(v)
                        unmark('fast')
                      }}
                    />
                  </div>
                )}
                {caps.ultracode && (
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-meta font-medium text-ultracode">{tr('channels.agent.ultracode')}</span>
                    <Select
                      label={tr('channels.agent.ultracode')}
                      value={ultracode}
                      options={toggleOptions(panelDefaults.ultracode)}
                      onChange={v => {
                        setUltracode(v)
                        unmark('ultracode')
                      }}
                    />
                  </div>
                )}
              </div>
            )}
            <AiFilled field={tr('channels.agent.permission')} reason={ai.permission} />
            {effortValue && <AiFilled field={tr('channels.agent.effort')} reason={ai.effort} />}
            {hasFast && caps?.fast && <AiFilled field={tr('channels.agent.fast')} reason={ai.fast} />}
            {hasUltracode && caps?.ultracode && (
              <AiFilled field={tr('channels.agent.ultracode')} reason={ai.ultracode} />
            )}
            {permission === 'full' && <p className="-mt-1 text-meta text-warn">{tr('channels.agent.fullWarning')}</p>}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.instructions')}</span>
                <Select
                  label={tr('channels.agent.template')}
                  value={'' as string}
                  placeholder={tr('channels.agent.template')}
                  options={TEMPLATES.map(([label, text]) => ({ value: text, label: tr(label) }))}
                  onChange={key => {
                    setInstructions(tr(key as (typeof TEMPLATES)[number][1]))
                    unmark('instructions')
                  }}
                  className="h-7 w-auto"
                  fitContent
                />
              </div>
              <textarea
                value={instructions}
                maxLength={2000}
                rows={3}
                onChange={e => {
                  setInstructions(e.target.value)
                  unmark('instructions')
                }}
                className={cn(INPUT, 'resize-none')}
              />
              <AiFilled field={tr('channels.agent.instructions')} reason={ai.instructions} />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.mode')}</span>
              <Segmented
                label={tr('channels.agent.mode')}
                value={mode}
                options={[
                  { value: 'per-task', label: tr('channels.agent.mode.perTask') },
                  { value: 'shared', label: tr('channels.agent.mode.shared') },
                ]}
                onChange={v => {
                  setMode(v)
                  unmark('mode')
                }}
              />
              <AiFilled field={tr('channels.agent.mode')} reason={ai.mode} />
            </div>
            {!editing?.bound && (
              <MemberTools engine={engine} projectId={projectId} value={tools ?? null} onChange={setTools} />
            )}
            <button type="submit" hidden />
          </form>
        </div>
      }
    />
  )
}
