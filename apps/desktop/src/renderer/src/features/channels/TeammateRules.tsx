// 队友派来的活的限制（docs/multica-learn.md §8、§11.4）：这台电脑的设置，所有团队通用，选了就生效
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '../../i18n/core'
import { useState } from 'react'
import { Segmented, Switch, useToast } from '@/ui'
import { useEngineState } from '@/features/engine'
import { useMachines } from '@/features/machines/store'
import type { TeammateRules } from '../../../../shared/types/channels'
import { channelActions, useChannels } from './store'

type Scope = 'all' | 'some'

/** 这个项目接不接队友派来的活 */
export const teammateAllows = (rules: TeammateRules, projectId: string | null | undefined): boolean =>
  !rules.projects || (!!projectId && rules.projects.includes(projectId))

export function TeammateSection() {
  useI18n()
  const toast = useToast()
  const rules = useChannels(s => s.teammate)
  const projects = useEngineState(s => s.projects)
  const { machines } = useMachines()
  const [busy, setBusy] = useState(false)
  const save = (next: TeammateRules) => {
    if (busy) return
    setBusy(true)
    channelActions.setTeammate(next).then(
      () => {
        setBusy(false)
        toast(tr('teammate.saved'))
      },
      e => {
        setBusy(false)
        toast(translateMessage((e as Error)?.message ?? String(e)))
      },
    )
  }
  const scope: Scope = rules.projects ? 'some' : 'all'
  const picked = new Set(rules.projects ?? [])
  return (
    <section data-teammate-rules className="flex flex-col gap-2 border-t border-line-subtle pt-4">
      <h4 className="text-meta font-medium text-fg-muted">{tr('teammate.title')}</h4>
      <p className="text-meta text-fg-faint">{tr('teammate.hint')}</p>
      <div className="flex flex-col gap-1.5">
        <span className="text-meta text-fg-muted">{tr('teammate.projects')}</span>
        <Segmented<Scope>
          label={tr('teammate.projects')}
          value={scope}
          disabled={busy}
          options={[
            { value: 'all', label: tr('teammate.projects.all') },
            { value: 'some', label: tr('teammate.projects.some') },
          ]}
          // 改成「只在勾选的项目」时先一个都不勾：放开哪个由用户自己选
          onChange={v => save({ ...rules, projects: v === 'all' ? null : [] })}
        />
        {scope === 'some' &&
          (projects.length === 0 ? (
            <p className="text-meta text-fg-faint">{tr('teammate.projects.empty')}</p>
          ) : (
            <ul className="flex max-h-44 flex-col gap-px overflow-y-auto">
              {projects.map(p => {
                const machine = machines.find(m => p.id.startsWith(`${m.id}~`))
                return (
                  <li key={p.id} className="flex h-8 items-center gap-2 rounded-md px-1 hover:bg-hover">
                    <span className="min-w-0 flex-1 truncate text-list text-fg">{p.name}</span>
                    <span className="shrink-0 text-meta text-fg-faint">
                      {machine ? machine.name : tr('channels.thisComputer')}
                    </span>
                    <Switch
                      size="sm"
                      checked={picked.has(p.id)}
                      disabled={busy}
                      label={p.name}
                      onChange={on =>
                        save({
                          ...rules,
                          projects: on ? [...picked, p.id] : [...picked].filter(id => id !== p.id),
                        })
                      }
                    />
                  </li>
                )
              })}
            </ul>
          ))}
      </div>
      <Row
        label={tr('teammate.copy')}
        hint={tr('teammate.copyHint')}
        checked={rules.copy}
        disabled={busy}
        onChange={copy => save({ ...rules, copy })}
      />
      <Row
        label={tr('teammate.mcp')}
        hint={tr('teammate.mcpHint')}
        checked={rules.isolateMcp}
        disabled={busy}
        onChange={isolateMcp => save({ ...rules, isolateMcp })}
      />
    </section>
  )
}

function Row({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-ui text-fg">{label}</p>
        <p className="text-meta text-fg-faint">{hint}</p>
      </div>
      <Switch size="sm" checked={checked} disabled={disabled} label={label} onChange={onChange} />
    </div>
  )
}
