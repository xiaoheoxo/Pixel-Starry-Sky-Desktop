// 设置 › 子智能体（docs/ui/subagent-routing.md，样式稿 docs/ui/subagent-types-mockup.html）：
// 像素星空引擎的子智能体分类型，每个类型单独选站点和模型、工具权限；下面是所有类型通用的设置
import { useState } from 'react'
import { Info, Network, Plus } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, Segmented, Switch } from '@/ui'
import { usePlatform } from '@/features/account/platform'
import { useProviders } from '@/features/account/providers'
import { setSubagentSettings, useSubagentSettings } from './subagents'
import { SubagentTypeCard, typeName, type SiteContext } from './SubagentTypeCard'
import {
  MAX_SUBAGENT_TYPES,
  SUBAGENT_CONCURRENCY,
  type SubagentConcurrency,
  type SubagentSettings,
  type SubagentType,
} from '../../../../shared/types/subagents'

const NEW_ID = '__new'

/** 不和已有的重复的标识：base、base-2、base-3… */
function freeId(base: string, taken: readonly string[]): string {
  const root = base.slice(0, 28)
  if (!taken.includes(root)) return root
  for (let i = 2; ; i++) if (!taken.includes(`${root}-${i}`)) return `${root}-${i}`
}

export function SubagentsSection({ openChannels }: { openChannels: () => void }) {
  useI18n()
  const { settings } = useSubagentSettings()
  const platform = usePlatform('pixel')
  const providers = useProviders().providers.filter(p => p.models.length)
  const sites: SiteContext = {
    providers,
    groups: platform.email ? platform.groups.filter(g => g.models.length) : [],
    platform,
  }
  const [open, setOpen] = useState<string | null>(null)
  /** 新建 / 复制出来、还没保存的类型 */
  const [draft, setDraft] = useState<SubagentType | null>(null)
  const [error, setError] = useState<string | null>(null)
  const save = (patch: Partial<SubagentSettings>): Promise<boolean> => {
    setError(null)
    return setSubagentSettings(patch).then(
      () => true,
      (e: Error) => {
        setError(tr('subagentRoute.saveFailed', { error: e.message }))
        return false
      },
    )
  }
  const ids = settings.types.map(t => t.id)
  const full = settings.types.length >= MAX_SUBAGENT_TYPES
  const startNew = (from?: SubagentType) => {
    if (full) return setError(tr('subagentRoute.error.tooMany', { n: MAX_SUBAGENT_TYPES }))
    setDraft(
      from
        ? {
            ...from,
            id: freeId(`${from.id}-copy`, ids),
            name: tr('subagentRoute.copyName', { name: typeName(from) }),
            enabled: true,
          }
        : {
            id: '',
            name: '',
            description: '',
            target: null,
            tools: 'all',
            maxMinutes: 30,
            instructions: '',
            enabled: true,
          },
    )
    setOpen(NEW_ID)
  }
  const cards = [...settings.types, ...(draft ? [draft] : [])]

  return (
    <div className="max-w-[760px]">
      <div className="flex items-start gap-3.5">
        <span className="grid size-10 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent-fg">
          <Network size={20} strokeWidth={1.6} />
        </span>
        <div className="min-w-0">
          <h3 className="mb-0.5 text-section font-semibold text-fg">{tr('subagentRoute.title')}</h3>
          <p className="text-meta text-fg-muted">{tr('subagentRoute.intro')}</p>
          <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-subtle py-0.5 pr-2.5 pl-2 text-meta text-fg-secondary">
            <Info size={13} strokeWidth={1.75} className="shrink-0 text-fg-muted" />
            {tr('subagentRoute.scope')}
          </p>
        </div>
      </div>

      <section className="mt-8">
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h4 data-setting-title={tr('subagentRoute.types')} className="text-ui font-semibold text-fg">
              {tr('subagentRoute.types')}
            </h4>
            <p className="mt-0.5 text-meta text-fg-muted">{tr('subagentRoute.typesHint')}</p>
          </div>
          <Button icon={Plus} disabled={!!draft} onClick={() => startNew()}>
            {tr('subagentRoute.addType')}
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          {cards.map((type, index) => {
            const isNew = draft === type
            const key = isNew ? NEW_ID : type.id
            return (
              <SubagentTypeCard
                key={key}
                type={type}
                index={index}
                open={open === key}
                isNew={isNew}
                sites={sites}
                takenIds={isNew ? ids : ids.filter(id => id !== type.id)}
                onToggle={() => {
                  if (isNew) return
                  setDraft(null)
                  setOpen(open === key ? null : key)
                }}
                onEnable={enabled =>
                  void save({ types: settings.types.map(t => (t.id === type.id ? { ...t, enabled } : t)) })
                }
                onSave={next =>
                  void save({
                    types: isNew ? [...settings.types, next] : settings.types.map(t => (t.id === type.id ? next : t)),
                  }).then(ok => {
                    if (!ok) return
                    setDraft(null)
                    setOpen(null)
                  })
                }
                onCancel={() => {
                  setDraft(null)
                  setOpen(null)
                }}
                onDelete={() => {
                  setOpen(null)
                  void save({ types: settings.types.filter(t => t.id !== type.id) })
                }}
                onCopy={() => startNew(type)}
                openChannels={openChannels}
              />
            )
          })}
        </div>
      </section>

      <section className="mt-8">
        <h4 data-setting-title={tr('subagentRoute.shared')} className="mb-3 text-ui font-semibold text-fg">
          {tr('subagentRoute.shared')}
        </h4>
        <div className="divide-y divide-line-subtle rounded-xl border border-line-card bg-surface">
          <div
            data-setting-title={tr('subagentRoute.fallback')}
            className="flex items-center justify-between gap-6 px-4 py-3.5"
          >
            <div>
              <div className="font-medium text-fg">{tr('subagentRoute.fallback')}</div>
              <p className="mt-0.5 text-meta text-fg-muted">{tr('subagentRoute.fallbackHint')}</p>
            </div>
            <Switch
              label={tr('subagentRoute.fallback')}
              checked={settings.fallback}
              onChange={fallback => void save({ fallback })}
            />
          </div>
          <div
            data-setting-title={tr('subagentRoute.concurrency')}
            className="flex items-center justify-between gap-6 px-4 py-3.5"
          >
            <div>
              <div className="font-medium text-fg">{tr('subagentRoute.concurrency')}</div>
              <p className="mt-0.5 text-meta text-fg-muted">{tr('subagentRoute.concurrencyHint')}</p>
            </div>
            <Segmented<`${SubagentConcurrency}`>
              label={tr('subagentRoute.concurrency')}
              value={`${settings.maxConcurrent}`}
              onChange={v => void save({ maxConcurrent: Number(v) as SubagentConcurrency })}
              options={SUBAGENT_CONCURRENCY.map(n => ({ value: `${n}` as const, label: String(n) }))}
            />
          </div>
        </div>
      </section>
      {error && (
        <p role="alert" className="mt-3 text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
