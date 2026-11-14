import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { useEffect, useState } from 'react'
import type { EngineId, ExtensionEntry } from '@pixelsky/protocol'
import { Segmented } from '@/ui'
import { machineOf } from '@/features/machines/store'
import type { AgentTools } from '../../../../shared/types/channels'

type Kind = 'mcp' | 'skill' | 'plugin'
const KINDS = new Set<string>(['mcp', 'skill', 'plugin'])

/** 设置 › 扩展里像素星空管理的、这个引擎能用、开着的 MCP / 技能 / 插件 */
export function memberToolChoices(entries: readonly ExtensionEntry[], engine: EngineId): ExtensionEntry[] {
  return entries.filter(
    e =>
      e.origin === 'managed' &&
      e.enabled &&
      KINDS.has(e.kind) &&
      (e.engines ?? (['claude'] as readonly string[])).includes(engine),
  )
}

/**
 * 添加 / 编辑成员里的「工具」（docs/ui/channels-collab-v2.md §5）：跟随全局，或只用勾选的扩展。
 * 频道工具不在列表里，总是有；SSH 机器上的成员用那台机器的扩展，这里只说明一句
 */
export function MemberTools({
  engine,
  projectId,
  value,
  onChange,
}: {
  engine: EngineId
  projectId: string
  value: AgentTools | null
  onChange: (next: AgentTools | null) => void
}) {
  useI18n()
  const local = !!projectId && machineOf(projectId) === 'local'
  const [entries, setEntries] = useState<ExtensionEntry[] | null>(null)
  useEffect(() => {
    if (!local || !window.pixelsky) return
    let alive = true
    window.pixelsky.extensions
      .state({ projectId })
      .then(state => alive && setEntries(state.entries))
      .catch(() => alive && setEntries([]))
    return () => {
      alive = false
    }
  }, [local, projectId])
  const choices = memberToolChoices(entries ?? [], engine)
  const picked = new Set(value?.ids ?? [])
  const toggle = (id: string) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange({ mode: 'only', ids: [...next] })
  }
  return (
    <div data-member-tools="" className="flex flex-col gap-1.5">
      <span className="text-meta font-medium text-fg-muted">{tr('channels.dialog.tools')}</span>
      {!local ? (
        <p className="text-meta text-fg-faint">{tr('channels.dialog.toolsRemote')}</p>
      ) : (
        <>
          <Segmented
            label={tr('channels.dialog.tools')}
            value={value ? 'only' : 'follow'}
            options={[
              { value: 'follow', label: tr('channels.dialog.toolsFollow') },
              { value: 'only', label: tr('channels.dialog.toolsOnly') },
            ]}
            onChange={v => onChange(v === 'only' ? { mode: 'only', ids: value?.ids ?? [] } : null)}
          />
          {value ? (
            entries && choices.length === 0 ? (
              <p className="text-meta text-fg-faint">{tr('channels.dialog.toolsNone')}</p>
            ) : (
              <div className="max-h-[180px] overflow-y-auto rounded-lg border border-line-card p-1 [scrollbar-width:thin]">
                {choices.map(e => (
                  <label
                    key={e.id}
                    className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-list hover:bg-hover"
                  >
                    <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} />
                    <span className="min-w-0 flex-1 truncate text-fg">{e.name}</span>
                    <span className="shrink-0 text-meta text-fg-faint">
                      {tr(`channels.dialog.toolsKind.${e.kind as Kind}`)}
                    </span>
                  </label>
                ))}
              </div>
            )
          ) : (
            <p className="text-meta text-fg-faint">{tr('channels.dialog.toolsFollowHint')}</p>
          )}
          <p className="text-meta text-fg-faint">{tr('channels.dialog.toolsHint')}</p>
        </>
      )}
    </div>
  )
}
