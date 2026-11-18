// 挂一条事项唤醒（docs/multica-learn.md §11.6）：条件三选一（到某个时间 / 定期检查 / 等它结束）、叫谁、要它做什么。
// 任务卡、流程卡的「唤醒…」和看板事项（挂在它派出去的那张卡上）共用
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useMemo, useState, type ReactNode } from 'react'
import { Segmented, Select, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { FIELD } from '@/features/panel/ToolsUi'
import { parseTime } from '@/features/board/scheduleModel'
import type { ChannelMember } from '@/data/types'
import type { WakeupFreq, WakeupKind } from '../../../../shared/types/channels'
import { WAKEUP_MAX_DAYS, WAKEUP_TEXT_MAX, WAKEUP_WAIT_DAYS, wakeupFirst } from '../../../../shared/channels/wakeup'
import { agentPlace } from './ChannelMessage'
import { channelActions, useChannels } from './store'
import {
  AT_PRESETS,
  WAKEUP_FREQS,
  atOf,
  buildWakeup,
  clockText,
  dayClock,
  dayInput,
  everyWhen,
  localInput,
  wakeupChoices,
  wakeupDraft,
  withKind,
  type AtPreset,
  type WaitDays,
  type WakeupDraft,
  type WakeupOn,
} from './wakeupModel'

const DAY = 86_400_000
const KINDS: readonly WakeupKind[] = ['at', 'every', 'ended']

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2 text-meta">
      <span className="pt-2 text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

const Hint = ({ children, warn = false }: { children: ReactNode; warn?: boolean }) => (
  <p className={cn('pl-[5.5rem] text-meta', warn ? 'text-warn' : 'text-fg-faint')}>{children}</p>
)

export function WakeupDialog({ target, onClose }: { target: WakeupOn; onClose(): void }) {
  useI18n()
  const channel = useChannels(s => s.channels.find(c => c.id === target.channelId) ?? null)
  const members = useChannels(s => s.members)
  // 频道里的 AI 成员，按频道成员的顺序
  const agents = useMemo(
    () =>
      (channel?.memberIds ?? []).flatMap(id => {
        const m = members.find(x => x.id === id)
        return m?.kind === 'agent' ? [m] : []
      }),
    [channel, members],
  )
  const [draft, setDraft] = useState(() => wakeupDraft(target, agents, Date.now()))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = Date.now()
  const built = buildWakeup(draft, target, now)
  const problem = 'error' in built ? built.error : null
  const choices: ChannelMember[] = wakeupChoices(draft.kind, target, agents)
  // 流程已经全部交付：只能按时间叫
  const kinds = target.ended ? KINDS.filter(k => k !== 'ended') : KINDS
  const patch = (p: Partial<WakeupDraft>) => {
    setError(null)
    setDraft(d => ({ ...d, ...p }))
  }
  const submit = () => {
    const r = buildWakeup(draft, target, Date.now())
    if ('error' in r) return
    setBusy(true)
    setError(null)
    channelActions
      .wakeup(target.channelId, r.op)
      .then(onClose)
      .catch(e => setError(tr('wakeup.dialog.failed', { error: translateMessage((e as Error).message) })))
      .finally(() => setBusy(false))
  }
  const at = draft.kind === 'at' ? atOf(draft, now) : null
  const first = draft.kind === 'every' ? wakeupFirst(everyWhen(draft), now) : null

  return (
    <ConfirmDialog
      title={tr('wakeup.dialog.title', { title: target.title })}
      wide
      busy={busy}
      error={error}
      dirty={!!draft.text.trim()}
      confirmLabel={tr('wakeup.dialog.confirm')}
      cancelLabel={tr('wakeup.dialog.cancel')}
      confirmDisabled={!!problem}
      onCancel={onClose}
      onConfirm={submit}
      description={
        <div data-wakeup-dialog className="flex flex-col gap-3 text-left">
          <p className="text-meta text-fg-muted">{tr('wakeup.dialog.intro')}</p>
          <Row label={tr('wakeup.kind.label')}>
            <Segmented<WakeupKind>
              label={tr('wakeup.kind.label')}
              value={draft.kind}
              options={kinds.map(k => ({ value: k, label: tr(`wakeup.kind.${k}`) }))}
              onChange={kind => {
                setError(null)
                setDraft(d => withKind(d, kind, target, agents))
              }}
            />
          </Row>

          {draft.kind === 'at' && (
            <>
              <Row label={tr('wakeup.at.time')}>
                <Segmented<AtPreset>
                  label={tr('wakeup.at.time')}
                  value={draft.preset}
                  options={AT_PRESETS.map(p => ({ value: p, label: tr(`wakeup.at.${p}`) }))}
                  onChange={preset => patch({ preset })}
                />
                {draft.preset === 'custom' ? (
                  <input
                    type="datetime-local"
                    aria-label={tr('wakeup.at.time')}
                    value={draft.custom}
                    min={localInput(now)}
                    max={localInput(now + WAKEUP_MAX_DAYS * DAY)}
                    onChange={e => patch({ custom: e.target.value })}
                    className={cn(FIELD, 'w-56!')}
                  />
                ) : (
                  at !== null && <span className="text-fg-faint tabular-nums">{dayClock(at, now)}</span>
                )}
              </Row>
              {problem === 'past' && <Hint warn>{tr('wakeup.at.past')}</Hint>}
              {problem === 'far' && <Hint warn>{tr('wakeup.at.far', { n: WAKEUP_MAX_DAYS })}</Hint>}
            </>
          )}

          {draft.kind === 'every' && (
            <>
              <Row label={tr('wakeup.every.freq')}>
                <Segmented<WakeupFreq>
                  label={tr('wakeup.every.freq')}
                  value={draft.freq}
                  options={WAKEUP_FREQS.map(f => ({ value: f, label: tr(`wakeup.every.${f}`) }))}
                  onChange={freq => patch({ freq })}
                />
                {draft.freq === 'hourly' ? (
                  <>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      aria-label={tr('wakeup.every.minute')}
                      value={draft.minute}
                      onChange={e =>
                        patch({ minute: Math.min(59, Math.max(0, Math.trunc(Number(e.target.value) || 0))) })
                      }
                      className={cn(FIELD, 'w-20!')}
                    />
                    <span className="text-fg-faint">{tr('wakeup.every.minute')}</span>
                  </>
                ) : (
                  <input
                    type="time"
                    aria-label={tr('wakeup.every.time')}
                    value={clockText(draft.hour, draft.minute)}
                    onChange={e => {
                      const t = parseTime(e.target.value)
                      if (t) patch(t)
                    }}
                    className={cn(FIELD, 'w-28!')}
                  />
                )}
              </Row>
              <Row label={tr('wakeup.every.until')}>
                <input
                  type="date"
                  aria-label={tr('wakeup.every.until')}
                  value={draft.untilDay}
                  min={dayInput(now)}
                  max={dayInput(now + WAKEUP_MAX_DAYS * DAY)}
                  onChange={e => patch({ untilDay: e.target.value })}
                  className={cn(FIELD, 'w-40!')}
                />
                {first !== null && !problem && (
                  <span className="text-fg-faint tabular-nums">
                    {tr('wakeup.every.first', { time: dayClock(first, now) })}
                  </span>
                )}
              </Row>
              {problem === 'until' || problem === 'never' ? (
                <Hint warn>{problem === 'never' ? tr('wakeup.every.never') : tr('wakeup.error.until')}</Hint>
              ) : (
                <Hint>{tr('wakeup.every.untilHint', { n: WAKEUP_MAX_DAYS })}</Hint>
              )}
              <Hint>{tr('wakeup.every.silent')}</Hint>
            </>
          )}

          {draft.kind === 'ended' && (
            <>
              <Row label={tr('wakeup.ended.what')}>
                {target.kind === 'flow' ? (
                  <span className="pt-2 text-list text-fg">{tr('wakeup.ended.flow')}</span>
                ) : (
                  <div className="flex flex-col gap-1 pt-2">
                    <span className="text-list text-fg">{tr('wakeup.ended.done')}</span>
                    <label className="flex items-center gap-2 text-list text-fg">
                      <input
                        type="checkbox"
                        checked={draft.failed}
                        onChange={e => patch({ failed: e.target.checked })}
                      />
                      {tr('wakeup.ended.failed')}
                    </label>
                    <label className="flex items-center gap-2 text-list text-fg">
                      <input
                        type="checkbox"
                        checked={draft.stopped}
                        onChange={e => patch({ stopped: e.target.checked })}
                      />
                      {tr('wakeup.ended.stopped')}
                    </label>
                  </div>
                )}
              </Row>
              <Row label={tr('wakeup.ended.wait')}>
                <Segmented<`${WaitDays}`>
                  label={tr('wakeup.ended.wait')}
                  value={`${draft.waitDays}`}
                  options={WAKEUP_WAIT_DAYS.map(n => ({ value: `${n}` as const, label: tr(`wakeup.ended.d${n}`) }))}
                  onChange={v => patch({ waitDays: Number(v) as WaitDays })}
                />
              </Row>
              <Hint>{tr('wakeup.ended.waitHint')}</Hint>
            </>
          )}

          <Row label={tr('wakeup.who')}>
            {choices.length ? (
              <Select<string>
                label={tr('wakeup.who')}
                value={draft.memberId}
                options={choices.map(m => ({ value: m.id, label: m.name, hint: agentPlace(m) || undefined }))}
                onChange={memberId => patch({ memberId })}
              />
            ) : (
              <span className="pt-2 text-warn">{tr('wakeup.who.none')}</span>
            )}
          </Row>
          {draft.kind === 'ended' && target.kind === 'task' && target.assigneeId && (
            <Hint>{tr('wakeup.who.notSelf')}</Hint>
          )}

          <label className="flex min-w-0 flex-col gap-1 text-meta text-fg-muted">
            {tr('wakeup.text')}
            <textarea
              value={draft.text}
              maxLength={WAKEUP_TEXT_MAX}
              placeholder={tr(`wakeup.text.${draft.kind}`)}
              onChange={e => patch({ text: e.target.value })}
              className={cn(FIELD, 'h-24 resize-none py-2')}
            />
          </label>
        </div>
      }
    />
  )
}
