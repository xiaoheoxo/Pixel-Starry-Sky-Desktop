// 设置 › 项目「完成后检查」（docs/ui/channels-collab-v2.md §8）：选项目，看自动识别的命令或自己写，开关文本检查和频道检查；
// 可以现在跑一次看结果。设置存在项目所在的机器上（按项目路由）
import { useEffect, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { Button, Segmented, Select, Switch, cn, useToast } from '@/ui'
import { useEngineState } from '@/features/engine'
import { machineOf } from '@/features/machines/store'
import { CheckSummary } from '@/features/checks/CheckSummary'
import type { CheckConfig, CheckPlan, CheckRun } from '../../../../../shared/types/checks'

const INPUT =
  'w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 font-mono text-meta text-fg outline-none focus:border-accent'

export function ProjectChecksCard() {
  useI18n()
  const toast = useToast()
  const projects = useEngineState(s => s.projects)
  const bridge = window.pixelsky?.projectTools
  const [projectId, setProjectId] = useState('')
  const [plan, setPlan] = useState<CheckPlan | null>(null)
  const [draft, setDraft] = useState<CheckConfig | null>(null)
  const [lines, setLines] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckRun | null>(null)
  const current = projects.find(p => p.id === projectId) ?? projects[0]

  useEffect(() => {
    setPlan(null)
    setDraft(null)
    setResult(null)
    if (!current || !bridge) return
    let alive = true
    void bridge
      .checkPlan({ projectId: current.id })
      .then(next => {
        if (!alive) return
        setPlan(next)
        setDraft(next.config)
        setLines((next.config.commands ?? next.detected.map(c => c.command)).join('\n'))
      })
      .catch(e => alive && toast(tr('checks.settings.failed', { error: translateMessage((e as Error).message) })))
    return () => {
      alive = false
    }
  }, [current?.id])

  const custom = draft?.commands !== null && draft?.commands !== undefined
  const commands = lines
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  const next: CheckConfig | null = draft ? { ...draft, commands: custom ? commands : null } : null
  const dirty = !!plan && !!next && JSON.stringify(next) !== JSON.stringify(plan.config)

  const save = async () => {
    if (!bridge || !current || !next) return
    setBusy(true)
    try {
      const saved = await bridge.saveCheckConfig({ projectId: current.id }, next)
      setPlan(saved)
      setDraft(saved.config)
      toast(tr('checks.settings.saved'))
    } catch (e) {
      toast(tr('checks.settings.failed', { error: translateMessage((e as Error).message) }))
    } finally {
      setBusy(false)
    }
  }
  const runNow = async () => {
    if (!bridge || !current) return
    setBusy(true)
    setResult({ id: 'pending', at: Date.now(), status: 'running', items: [] })
    try {
      // null：没有命令也没开文本检查，什么都没跑
      const run = await bridge.runChecks({ projectId: current.id })
      if (!run) toast(tr('checks.settings.nothingToRun'))
      setResult(run)
    } catch (e) {
      setResult(null)
      toast(tr('checks.settings.failed', { error: translateMessage((e as Error).message) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-project-checks="" className="mb-6 rounded-lg border border-line p-3.5">
      <div className="flex items-center gap-2 text-ui font-medium text-fg">
        <ListChecks size={15} strokeWidth={1.5} className="text-fg-muted" />
        {tr('checks.settings.title')}
      </div>
      <p className="mt-1 text-meta text-fg-muted">{tr('checks.settings.intro')}</p>
      {!current ? (
        <p className="mt-3 text-meta text-fg-faint">{tr('checks.settings.noProjects')}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-meta text-fg-muted">{tr('checks.settings.project')}</span>
            <Select
              label={tr('checks.settings.project')}
              value={current.id}
              options={projects.map(p => ({ value: p.id, label: p.name }))}
              onChange={setProjectId}
              // 跑检查、保存的结果按当时的项目写回，进行中不让换项目
              disabled={busy}
              className="h-8 w-56"
            />
          </div>
          {draft && plan && (
            <>
              <Segmented
                label={tr('checks.settings.title')}
                value={custom ? 'custom' : 'auto'}
                options={[
                  { value: 'auto', label: tr('checks.settings.auto') },
                  { value: 'custom', label: tr('checks.settings.custom') },
                ]}
                onChange={v => {
                  if (v === 'custom') setLines((draft.commands ?? plan.detected.map(c => c.command)).join('\n'))
                  setDraft({ ...draft, commands: v === 'custom' ? commands : null })
                }}
              />
              {custom ? (
                <div className="flex flex-col gap-1">
                  <textarea
                    value={lines}
                    rows={3}
                    onChange={e => setLines(e.target.value)}
                    className={cn(INPUT, 'resize-none')}
                  />
                  <span className="text-meta text-fg-faint">{tr('checks.settings.commandsHint')}</span>
                </div>
              ) : plan.detected.length ? (
                <div className="flex flex-wrap items-center gap-1.5 text-meta">
                  <span className="text-fg-muted">{tr('checks.settings.detected')}</span>
                  {plan.detected.map(c => (
                    <code key={c.command} className="rounded bg-subtle px-1.5 py-0.5 font-mono text-fg">
                      {c.command}
                    </code>
                  ))}
                </div>
              ) : (
                <p className="text-meta text-fg-faint">{tr('checks.settings.noneDetected')}</p>
              )}
              <label className="flex items-center justify-between gap-3 text-list text-fg">
                {tr('checks.settings.text')}
                <Switch
                  checked={draft.text}
                  label={tr('checks.settings.text')}
                  size="sm"
                  onChange={v => setDraft({ ...draft, text: v })}
                />
              </label>
              <label className="flex items-center justify-between gap-3 text-list text-fg">
                {tr('checks.settings.channel')}
                <Switch
                  checked={draft.channel}
                  label={tr('checks.settings.channel')}
                  size="sm"
                  onChange={v => setDraft({ ...draft, channel: v })}
                />
              </label>
              {/* 页面检查由这台电脑打开页面：远程项目不显示 */}
              {machineOf(current.id) === 'local' && (
                <label className="flex flex-col gap-1 text-list text-fg">
                  {tr('checks.settings.page')}
                  <input
                    data-check-page
                    value={draft.page}
                    placeholder="localhost:5173"
                    onChange={e => setDraft({ ...draft, page: e.target.value })}
                    className={INPUT}
                  />
                  <span className="text-meta text-fg-faint">{tr('checks.settings.pageHint')}</span>
                </label>
              )}
              <div className="flex items-center justify-end gap-2">
                <Button className="h-7 px-2.5 text-meta" disabled={busy || dirty} onClick={() => void runNow()}>
                  {tr('checks.settings.runNow')}
                </Button>
                <Button
                  variant="primary"
                  className="h-7 px-2.5 text-meta"
                  disabled={busy || !dirty}
                  onClick={() => void save()}
                >
                  {tr('checks.settings.save')}
                </Button>
              </div>
              {result && <CheckSummary run={result} />}
            </>
          )}
        </div>
      )}
    </div>
  )
}
