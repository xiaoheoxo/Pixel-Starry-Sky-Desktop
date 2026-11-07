// 频道预设的界面（docs/ui/channel-presets.md）：新建频道时选预设和看摘要、从频道复制、存为预设、管理预设
import { useRef, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { cn, EngineIcon } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import type { AgentMember, Channel } from '@/data/types'
import { excerpt } from '../../../../shared/channels/mentions'
import { useChannels } from './store'
import { relaySummary } from './RelayRules'
import {
  DEFAULT_PRESET_PARTS,
  PRESET_MAX,
  PRESET_NAME_MAX,
  formFromPreset,
  presetFromChannel,
  presetableMembers,
  sameName,
  setPresets,
  usePresets,
  withPreset,
  withoutPreset,
  type ChannelPreset,
  type PresetForm,
  type PresetPart,
} from './presets'

const errorText = (e: unknown): string => translateMessage(e instanceof Error ? e.message : String(e))
const LINK = 'press text-meta text-accent-fg hover:underline'
const INPUT =
  'w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-ui text-fg outline-none focus:border-line-strong'

function memberCount(count: number): string {
  if (!count) return tr('channels.preset.noMembers')
  return count === 1 ? tr('channels.preset.memberOne') : tr('channels.preset.memberCount', { n: count })
}

function presetSubtitle(preset: ChannelPreset): string {
  const members = memberCount(preset.members?.length ?? 0)
  return preset.lead ? `${members} · ${tr('channels.preset.hasLead')}` : members
}

const alertSummary = (form: Pick<PresetForm, 'alerts' | 'digestHour'>): string => {
  const on = tr('channels.preset.alertsOn', { n: Object.values(form.alerts).filter(Boolean).length })
  return form.alerts.digest ? `${on} · ${tr('channels.preset.digestAt', { hour: form.digestHour })}` : on
}

/** 派活方式的一句话：先出计划、互相派活的规则 */
function dispatchSummary(form: Pick<PresetForm, 'planFirst' | 'relay' | 'rules'>): string {
  return [
    form.planFirst ? tr('channels.preset.planFirst') : tr('channels.preset.noPlanFirst'),
    form.relay ? relaySummary(form.rules) : tr('channels.preset.noRelay'),
  ].join(tr('channels.preset.sep'))
}

/** 新建弹窗顶部：选一个预设；没有预设时只留说明和「从频道复制」 */
export function PresetChooser({
  active,
  canCopy,
  onPick,
  onCopy,
  onManage,
}: {
  /** 选中的预设；null 是空白；'copy' 是从频道复制来的 */
  active: string | null
  canCopy: boolean
  onPick: (id: string | null) => void
  onCopy: () => void
  onManage: () => void
}) {
  useI18n()
  const { items, defaultId } = usePresets()
  const copy = canCopy && (
    <button type="button" data-preset-copy onClick={onCopy} className={LINK}>
      {tr('channels.preset.copy')}
    </button>
  )
  if (!items.length && !active && !canCopy) return null
  if (!items.length && !active)
    return (
      <div className="flex items-baseline justify-between gap-3 text-meta text-fg-muted">
        <span>{tr('channels.preset.emptyHint')}</span>
        {copy}
      </div>
    )
  const ordered = [...items].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId))
  const cards = [{ id: null, name: tr('channels.preset.blank'), sub: tr('channels.preset.blankHint') }].concat(
    ordered.map(p => ({ id: p.id as never, name: p.name, sub: presetSubtitle(p) })),
  ) as { id: string | null; name: string; sub: string }[]
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-meta font-medium text-fg-muted">{tr('channels.preset.choose')}</span>
        <span className="flex gap-3">
          {copy}
          <button type="button" data-preset-manage onClick={onManage} className={LINK}>
            {tr('channels.preset.manage')}
          </button>
        </span>
      </div>
      {/* 预设多时只占两行，在这里滚动 */}
      <div className="grid max-h-[116px] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5 overflow-y-auto [scrollbar-width:thin]">
        {cards.map(card => (
          <button
            key={card.id ?? 'blank'}
            type="button"
            data-preset-card={card.id ?? 'blank'}
            aria-pressed={active === card.id}
            title={`${card.name}\n${card.sub}`}
            onClick={() => onPick(card.id)}
            className={cn(
              'press flex h-[54px] min-w-0 flex-col justify-center rounded-md border px-2.5 text-left',
              active === card.id ? 'border-accent-line bg-accent-soft' : 'border-line-card bg-surface hover:bg-hover',
            )}
          >
            <span
              className={cn(
                'flex min-w-0 items-center gap-1 text-list font-medium',
                active === card.id ? 'text-accent-fg' : 'text-fg',
              )}
            >
              <span className="truncate">{card.name}</span>
              {card.id === defaultId && card.id && (
                <span className="shrink-0 text-meta text-warn" title={tr('channels.preset.isDefault')}>
                  ★
                </span>
              )}
            </span>
            <span className="truncate text-meta text-fg-muted">{card.sub}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 border-t border-line-subtle px-2.5 py-1.5 text-meta">
      <span className="text-fg-muted">{label}</span>
      <span className="min-w-0 break-words text-fg">{children}</span>
    </div>
  )
}

/** 选了预设之后的摘要：弹窗不变长，要改点「展开修改」 */
export function PresetSummary({
  source,
  form,
  agents,
  deleted,
  elsewhere,
  onExpand,
}: {
  /** 预设名或频道名 */
  source: string
  form: PresetForm
  agents: readonly AgentMember[]
  /** 预设里已经删除的成员（名字） */
  deleted: readonly string[]
  /** 勾选的成员里，工作目录不在这个项目的 */
  elsewhere: readonly AgentMember[]
  onExpand: () => void
}) {
  useI18n()
  const picked = agents.filter(a => form.members.includes(a.id))
  const lead = picked.find(a => a.id === form.lead)
  return (
    <div className="flex flex-col gap-2">
      {elsewhere.length > 0 && (
        <p data-preset-elsewhere className="rounded-md bg-subtle px-2.5 py-2 text-meta text-warn">
          {tr('channels.preset.elsewhere', {
            list: elsewhere
              .map(m => (m.project ? tr('channels.preset.memberIn', { name: m.name, project: m.project }) : m.name))
              .join(tr('channels.preset.sep')),
          })}
        </p>
      )}
      {deleted.length > 0 && (
        <p data-preset-deleted className="rounded-md bg-subtle px-2.5 py-2 text-meta text-warn">
          {tr('channels.preset.deleted', { list: deleted.join(tr('channels.preset.sep')) })}
        </p>
      )}
      <div data-preset-summary className="rounded-md border border-line-card">
        <div className="flex items-baseline justify-between gap-3 px-2.5 py-1.5 text-meta text-fg-muted">
          <span className="min-w-0 truncate">{tr('channels.preset.from', { name: source })}</span>
          <button type="button" data-preset-expand onClick={onExpand} className={cn(LINK, 'shrink-0')}>
            {tr('channels.preset.expand')}
          </button>
        </div>
        <SummaryRow label={tr('channels.preset.partMembers')}>
          {picked.length ? (
            <span className="flex flex-wrap gap-1">
              {picked.map(a => (
                <span key={a.id} className="inline-flex h-[22px] items-center gap-1 rounded-sm bg-subtle px-1.5">
                  <EngineIcon engine={a.engine} size={12} />
                  {a.name}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-fg-faint">{tr('channels.preset.noMembers')}</span>
          )}
        </SummaryRow>
        <SummaryRow label={tr('channels.dialog.lead')}>
          {lead ? lead.name : <span className="text-fg-faint">{tr('channels.dialog.leadNone')}</span>}
        </SummaryRow>
        <SummaryRow label={tr('channels.preset.partDispatch')}>{dispatchSummary(form)}</SummaryRow>
        <SummaryRow label={tr('channels.preset.partNotes')}>
          {form.notes.trim() ? (
            excerpt(form.notes)
          ) : (
            <span className="text-fg-faint">{tr('channels.preset.none')}</span>
          )}
        </SummaryRow>
        <SummaryRow label={tr('channels.preset.partAlerts')}>{alertSummary(form)}</SummaryRow>
      </div>
    </div>
  )
}

/** 选一个已有频道，照着它建；只复制设置和成员（归档的也能选，团队频道不能） */
export function CopyFromChannel({
  channels,
  members,
  onPick,
  onCancel,
}: {
  channels: readonly Channel[]
  members: readonly AgentMember[]
  onPick: (channel: Channel) => void
  onCancel: () => void
}) {
  useI18n()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-meta font-medium text-fg-muted">{tr('channels.preset.copyTitle')}</span>
        <button type="button" onClick={onCancel} className={LINK}>
          {tr('channels.preset.copyCancel')}
        </button>
      </div>
      <div className="flex max-h-[212px] flex-col gap-0.5 overflow-y-auto rounded-lg border border-line-card p-1 [scrollbar-width:thin]">
        {channels.map(c => {
          const count = presetableMembers(c, members).length
          return (
            <button
              key={c.id}
              type="button"
              data-preset-copy-from={c.id}
              onClick={() => onPick(c)}
              className="press flex min-w-0 flex-col rounded-md px-1.5 py-1 text-left hover:bg-hover"
            >
              <span className="truncate text-list text-fg"># {c.name}</span>
              <span className="truncate text-meta text-fg-muted">
                {memberCount(count)}
                {c.archivedAt ? ` · ${tr('channels.preset.archived')}` : ''}
              </span>
            </button>
          )
        })}
      </div>
      <p className="text-meta text-fg-muted">{tr('channels.preset.copyHint')}</p>
    </div>
  )
}

/** 频道菜单的「存为预设…」：勾选带哪些设置；同名时可以覆盖 */
export function SavePresetDialog({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  useI18n()
  const presets = usePresets()
  const allMembers = useChannels(s => s.members)
  const agents = allMembers.filter((m): m is AgentMember => m.kind === 'agent')
  const [name, setName] = useState(channel.name)
  const [parts, setParts] = useState<readonly PresetPart[]>(DEFAULT_PRESET_PARTS)
  const [overwrite, setOverwrite] = useState(true)
  const conflict = presets.items.find(p => sameName(p.name, name))
  const [wantDefault, setWantDefault] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const full = !conflict && presets.items.length >= PRESET_MAX
  const replacing = conflict && overwrite ? conflict.id : null
  // 没动过勾选框：第一个预设默认勾上；覆盖默认预设时它还是默认
  const makeDefault = wantDefault ?? (!presets.defaultId || presets.defaultId === replacing)
  const blocked = !name.trim() || (!!conflict && !overwrite) || full
  const form = formFromPreset(presetFromChannel(channel, agents, { id: '', name: '', updatedAt: 0 }), agents)
  const picked = presetableMembers(channel, agents)
  const lead = picked.find(m => m.id === channel.lead)
  const rows: { part: PresetPart; title: string; detail: string }[] = [
    {
      part: 'members',
      title: tr('channels.preset.partMembers'),
      detail: picked.map(m => m.name).join(tr('channels.preset.sep')) || tr('channels.preset.noMembers'),
    },
    {
      part: 'dispatch',
      title: tr('channels.preset.partDispatchLead'),
      detail: [lead && tr('channels.preset.leadIs', { name: lead.name }), dispatchSummary(form)]
        .filter(Boolean)
        .join(tr('channels.preset.sep')),
    },
    {
      part: 'notes',
      title: tr('channels.preset.partNotes'),
      detail: channel.notes?.trim() ? excerpt(channel.notes) : tr('channels.preset.none'),
    },
    { part: 'alerts', title: tr('channels.preset.partAlerts'), detail: alertSummary(form) },
    {
      part: 'project',
      title: tr('channels.dialog.project'),
      detail: tr('channels.preset.partProjectHint', { name: channel.project ?? tr('channels.dialog.noProject') }),
    },
  ]
  const submit = () => {
    if (blocked) return
    const id = conflict?.id ?? crypto.randomUUID()
    const preset = presetFromChannel(channel, agents, { id, name: name.trim(), updatedAt: Date.now() }, parts)
    try {
      const next = withPreset(presets, preset, makeDefault)
      setPresets(!makeDefault && next.defaultId === id ? { ...next, defaultId: null } : next)
      onClose()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <ConfirmDialog
      title={tr('channels.preset.saveTitle', { name: channel.name })}
      confirmLabel={tr('channels.preset.save')}
      cancelLabel={tr('channels.dialog.cancel')}
      busy={false}
      error={error ?? (full ? tr('channels.preset.full', { n: PRESET_MAX }) : null)}
      focusInput
      confirmDisabled={blocked}
      onConfirm={submit}
      onCancel={onClose}
      description={
        <form
          data-preset-save
          className="flex flex-col gap-3"
          onSubmit={e => {
            e.preventDefault()
            submit()
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-meta font-medium text-fg-muted">{tr('channels.preset.name')}</span>
            <input value={name} maxLength={PRESET_NAME_MAX} onChange={e => setName(e.target.value)} className={INPUT} />
          </label>
          {conflict && (
            <div className="flex flex-wrap gap-3 text-meta">
              <label className="flex items-center gap-1.5">
                <input type="radio" name="preset-save" checked={overwrite} onChange={() => setOverwrite(true)} />
                {tr('channels.preset.overwrite', { name: conflict.name })}
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="preset-save" checked={!overwrite} onChange={() => setOverwrite(false)} />
                {tr('channels.preset.saveNew')}
              </label>
            </div>
          )}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-meta font-medium text-fg-muted">{tr('channels.preset.parts')}</legend>
            <div className="flex flex-col rounded-lg border border-line-card">
              {rows.map((row, i) => (
                <label
                  key={row.part}
                  className={cn('flex items-start gap-2 px-2.5 py-2', i > 0 && 'border-t border-line-subtle')}
                >
                  <input
                    type="checkbox"
                    data-preset-part={row.part}
                    className="mt-0.5"
                    checked={parts.includes(row.part)}
                    onChange={e =>
                      setParts(list => (e.target.checked ? [...list, row.part] : list.filter(p => p !== row.part)))
                    }
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-list text-fg">{row.title}</span>
                    <span className="break-words text-meta text-fg-muted">{row.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex items-center gap-2 text-list text-fg">
            <input
              type="checkbox"
              data-preset-default
              checked={makeDefault}
              onChange={e => setWantDefault(e.target.checked)}
            />
            {tr('channels.preset.makeDefault')}
          </label>
          <p className="text-meta text-fg-muted">{tr('channels.preset.saveHint')}</p>
          <button type="submit" hidden />
        </form>
      }
    />
  )
}

/** 管理预设：重命名、设默认、删除；新增和修改走频道菜单的「存为预设」 */
export function ManagePresetsDialog({ onClose }: { onClose: () => void }) {
  useI18n()
  const presets = usePresets()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const renameCancelled = useRef(false)
  const write = (next: typeof presets): boolean => {
    try {
      setPresets(next)
      setError(null)
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    }
  }
  const commitRename = () => {
    if (!renaming || renameCancelled.current) return
    const name = renaming.name.trim()
    if (!name) return setRenaming(null)
    if (presets.items.some(p => p.id !== renaming.id && sameName(p.name, name)))
      return setError(tr('channels.preset.nameTaken'))
    const current = presets.items.find(p => p.id === renaming.id)
    if (current && write(withPreset(presets, { ...current, name, updatedAt: Date.now() }, false))) setRenaming(null)
  }
  return (
    <ConfirmDialog
      title={tr('channels.preset.manage')}
      confirmLabel=""
      hideConfirm
      cancelLabel={tr('channels.preset.done')}
      busy={false}
      error={error}
      onConfirm={onClose}
      onCancel={onClose}
      description={
        <div data-preset-manage-list className="flex flex-col gap-3">
          {presets.items.length === 0 ? (
            <p className="text-meta text-fg-muted">{tr('channels.preset.manageEmpty')}</p>
          ) : (
            <div className="flex flex-col rounded-lg border border-line-card">
              {presets.items.map((p, i) => (
                <div
                  key={p.id}
                  data-preset-row={p.id}
                  className={cn('flex items-center gap-3 px-2.5 py-2', i > 0 && 'border-t border-line-subtle')}
                >
                  {renaming?.id === p.id ? (
                    <input
                      autoFocus
                      data-own-escape
                      value={renaming.name}
                      maxLength={PRESET_NAME_MAX}
                      aria-label={tr('channels.preset.name')}
                      onChange={e => setRenaming({ id: p.id, name: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={e => {
                        if (e.nativeEvent.isComposing) return
                        if (e.key === 'Enter') commitRename()
                        if (e.key === 'Escape') {
                          renameCancelled.current = true
                          setRenaming(null)
                          setError(null)
                        }
                      }}
                      className={INPUT}
                    />
                  ) : (
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5 text-list text-fg">
                        <span className="truncate">{p.name}</span>
                        {presets.defaultId === p.id && (
                          <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 text-meta text-accent-fg">
                            {tr('channels.preset.isDefault')}
                          </span>
                        )}
                      </span>
                      <span className="truncate text-meta text-fg-muted">{presetSubtitle(p)}</span>
                    </span>
                  )}
                  {deleting === p.id ? (
                    <span className="flex shrink-0 gap-3">
                      <button
                        type="button"
                        data-preset-delete-confirm
                        className="press text-meta text-danger hover:underline"
                        onClick={() => {
                          write(withoutPreset(presets, p.id))
                          setDeleting(null)
                        }}
                      >
                        {tr('channels.preset.deleteConfirm')}
                      </button>
                      <button type="button" className={LINK} onClick={() => setDeleting(null)}>
                        {tr('channels.dialog.cancel')}
                      </button>
                    </span>
                  ) : (
                    renaming?.id !== p.id && (
                      <span className="flex shrink-0 gap-3">
                        <button
                          type="button"
                          data-preset-toggle-default
                          className={LINK}
                          onClick={() => write({ ...presets, defaultId: presets.defaultId === p.id ? null : p.id })}
                        >
                          {tr(
                            presets.defaultId === p.id ? 'channels.preset.unsetDefault' : 'channels.preset.setDefault',
                          )}
                        </button>
                        <button
                          type="button"
                          data-preset-rename
                          className={LINK}
                          onClick={() => {
                            renameCancelled.current = false
                            setRenaming({ id: p.id, name: p.name })
                          }}
                        >
                          {tr('channels.preset.rename')}
                        </button>
                        <button
                          type="button"
                          data-preset-delete
                          className="press text-meta text-danger hover:underline"
                          onClick={() => setDeleting(p.id)}
                        >
                          {tr('channels.preset.delete')}
                        </button>
                      </span>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="text-meta text-fg-muted">{tr('channels.preset.manageHint')}</p>
        </div>
      }
    />
  )
}
