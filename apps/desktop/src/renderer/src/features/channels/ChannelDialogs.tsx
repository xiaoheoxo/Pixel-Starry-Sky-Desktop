// 新建 / 编辑频道、添加 / 编辑 AI 成员的对话框（docs/ui/channels-phase-b.md §3、§9）。只在正式模式用。
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { PERMISSION_MODES, type EngineId, type PermissionMode } from '@pixelsky/protocol'
import { Button, cn, EngineIcon, Segmented, Select, useToast, type SelectOption } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { useEngineState, PERMISSION_INFO } from '@/features/engine'
import { useEngineCatalog } from '@/features/engine/catalog'
import { useMachines } from '@/features/machines/store'
import type { AgentMember, Channel } from '@/data/types'
import type { AgentConfig } from '../../../../shared/types/channels'
import type { WorkspaceChoice } from '../../../../shared/types/machines'
import { channelActions, useChannels } from './store'
import { usePlatformCatalog } from '@/features/account/platform'
import { useProviders } from '@/features/account/providers'
import { channelLabel } from '@/features/model-channels/channelLabels'
import {
  modelChoices,
  modelForSource,
  settingsForSource,
  sourceKeyOf,
  sourceOptions,
  type SourceContext,
  type SourceKey,
} from './agentSource'

const INPUT =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-composer-ring'

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
  const [name, setName] = useState(channel?.name ?? '')
  const [topic, setTopic] = useState(channel?.topic ?? '')
  const [notes, setNotes] = useState(channel?.notes ?? '')
  const [projectId, setProjectId] = useState<string>(channel ? (channel.projectId ?? '') : (currentProject ?? ''))
  const [members, setMembers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  // 名称、主题、说明是自己打的字：改过就先问再关（取消 / Esc / 点背景）
  const dirty =
    name !== (channel?.name ?? '') ||
    topic !== (channel?.topic ?? '') ||
    notes !== (channel?.notes ?? '') ||
    members.length > 0
  const submit = () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    const input = { name, topic: topic.trim() || null, projectId: inTeam ? null : projectId || null }
    // 频道说明只有本机频道有；新建时建好再存（建频道的接口不带它）。
    // 说明没存上时频道已经建好（也切过去了）：照样关掉对话框，提示一声，免得再点又建一个同名的
    const note = notes.trim() || null
    const done = channel
      ? channelActions.updateChannel(channel.id, inTeam ? { name, topic: input.topic } : { ...input, notes: note })
      : channelActions
          .createChannel(teamId ? { ...input, teamId } : { ...input, memberIds: members })
          .then(id =>
            note && !teamId
              ? channelActions
                  .updateChannel(id, { notes: note })
                  .catch(e => toast(tr('channels.dialog.notesFailed', { error: errorText(e) })))
              : undefined,
          )
    done.then(onClose, e => {
      setError(errorText(e))
      setBusy(false)
    })
  }
  return (
    <ConfirmDialog
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
          <Field label={tr('channels.dialog.name')}>
            <input value={name} maxLength={40} onChange={e => setName(e.target.value)} className={INPUT} />
          </Field>
          <Field label={tr('channels.dialog.topic')}>
            <input value={topic} maxLength={200} onChange={e => setTopic(e.target.value)} className={INPUT} />
          </Field>
          {!inTeam && (
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
          {!channel && !inTeam && agents.length > 0 && (
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1.5 text-meta font-medium text-fg-muted">{tr('channels.dialog.members')}</legend>
              {agents.map(a => (
                <label key={a.id} className="flex h-8 items-center gap-2 rounded-md px-1 hover:bg-hover">
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
            </fieldset>
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
  const [permission, setPermission] = useState<PermissionMode | ''>(editing?.settings.permissionMode ?? '')
  const [instructions, setInstructions] = useState(editing?.instructions ?? '')
  const [mode, setMode] = useState<AgentConfig['mode']>(editing?.mode ?? 'per-task')
  // 名字和职责说明（最长 2000 字）是自己打的字：改过就先问再关
  const dirty = name !== (editing?.name ?? '') || instructions !== (editing?.instructions ?? '')
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
    setSource(key)
    setModel(modelForSource(engine, key, model, sourceCtx, ownModels))
  }
  const permissionOptions: SelectOption<PermissionMode | ''>[] = [
    { value: '', label: tr('channels.agent.default') },
    ...PERMISSION_MODES.map(m => ({ value: m, label: PERMISSION_INFO[m].label, hint: PERMISSION_INFO[m].hint })),
  ]
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
          ...settingsForSource(engine, source, model, sourceCtx),
          // 界面上没有推理强度选项：编辑时沿用原来的（同一引擎才沿用，换了引擎档位不一定通用）
          ...(editing?.settings.effort !== undefined && editing.engine === engine
            ? { effort: editing.settings.effort }
            : {}),
          ...(permission ? { permissionMode: permission } : {}),
        },
        instructions,
        mode,
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
      confirmDisabled={!canSave}
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
          <form
            className="flex flex-col gap-3"
            onSubmit={e => {
              e.preventDefault()
              submit()
            }}
          >
            <Field label={tr('channels.agent.name')}>
              <input value={name} maxLength={40} onChange={e => setName(e.target.value)} className={INPUT} />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.engine')}</span>
              {ready.length ? (
                <Segmented
                  label={tr('channels.agent.engine')}
                  value={engine}
                  options={ready.map(e => ({ value: e.id, label: e.version ? `${e.name} ${e.version}` : e.name }))}
                  onChange={v => {
                    setEngine(v)
                    // 换了引擎：来源这个引擎用不了（接口协议不对、平台没线路）就回到自有账号
                    const keep = sourceOptions(v, sourceCtx).some(o => o.value === source && !o.disabled)
                    setSource(keep ? source : 'self')
                    setModel(keep && source !== 'self' ? modelForSource(v, source, model, sourceCtx, []) : '')
                  }}
                />
              ) : (
                <p className="text-meta text-warn">{tr('channels.agent.noEngine')}</p>
              )}
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
                    onChange={setModel}
                    mono
                  />
                ) : (
                  <p className="flex h-8 items-center text-meta text-warn">{tr('channels.agent.source.noModels')}</p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.permission')}</span>
                <Select
                  label={tr('channels.agent.permission')}
                  value={permission}
                  options={permissionOptions}
                  onChange={setPermission}
                />
              </div>
            </div>
            {permission === 'full' && <p className="-mt-1 text-meta text-warn">{tr('channels.agent.fullWarning')}</p>}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-meta font-medium text-fg-muted">{tr('channels.agent.instructions')}</span>
                <Select
                  label={tr('channels.agent.template')}
                  value={'' as string}
                  placeholder={tr('channels.agent.template')}
                  options={TEMPLATES.map(([label, text]) => ({ value: text, label: tr(label) }))}
                  onChange={key => setInstructions(tr(key as (typeof TEMPLATES)[number][1]))}
                  className="h-7 w-auto"
                  fitContent
                />
              </div>
              <textarea
                value={instructions}
                maxLength={2000}
                rows={3}
                onChange={e => setInstructions(e.target.value)}
                className={cn(INPUT, 'resize-none')}
              />
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
                onChange={setMode}
              />
            </div>
            <button type="submit" hidden />
          </form>
        </div>
      }
    />
  )
}
