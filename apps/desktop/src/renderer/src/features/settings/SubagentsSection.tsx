// 设置 › 子智能体（docs/ui/subagent-routing.md，样式稿 docs/ui/subagent-types-mockup.html、subagent-settings-v2-mockup.html）：
// 像素星空引擎的子智能体分类型，每个类型单独选站点和模型、工具权限。宽时两栏：左边类型和「从模板新建」，
// 右边所有类型通用的设置和主会话看到的类型说明；窄时叠成一栏
import { useState } from 'react'
import { Info, Network, Plus } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Button, Segmented, Switch } from '@/ui'
import { usePlatform } from '@/features/account/platform'
import { useProviders } from '@/features/account/providers'
import { setSubagentSettings, useSubagentSettings } from './subagents'
import { SubagentTypeCard, TYPE_ICONS, minutesLabel, typeName, type SiteContext } from './SubagentTypeCard'
import {
  SUBAGENT_TEMPLATES,
  TASK_TYPES_HEADER,
  fromTemplate,
  taskTypeLines,
  templateName,
  type SubagentTemplate,
} from './subagentTemplates'
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
  const startNew = (from?: SubagentType, template?: SubagentTemplate) => {
    if (full) return setError(tr('subagentRoute.error.tooMany', { n: MAX_SUBAGENT_TYPES }))
    setDraft(
      template
        ? fromTemplate(template, freeId(template.id, ids))
        : from
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

  const lines = taskTypeLines(settings.types)

  return (
    <div className="@container">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent-fg">
          <Network size={18} strokeWidth={1.6} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-section font-semibold text-fg">{tr('subagentRoute.title')}</h3>
          <p className="text-meta text-fg-muted">{tr('subagentRoute.intro')}</p>
        </div>
        <span
          title={tr('subagentRoute.scope')}
          className="hidden shrink-0 items-center gap-1.5 self-start rounded-full bg-subtle py-0.5 pr-2.5 pl-2 text-meta whitespace-nowrap text-fg-secondary @3xl:inline-flex"
        >
          <Info size={13} strokeWidth={1.75} className="shrink-0 text-fg-muted" />
          {tr('subagentRoute.scopeShort')}
        </span>
      </div>
      <p className="mt-2 text-meta text-fg-faint @3xl:hidden">{tr('subagentRoute.scope')}</p>

      <div className="mt-6 grid items-start gap-6 @4xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0">
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <h4
                data-setting-title={tr('subagentRoute.types')}
                className="flex items-center gap-2 text-ui font-semibold text-fg"
              >
                {tr('subagentRoute.types')}
                <span className="rounded bg-subtle px-1.5 text-label font-normal text-fg-muted tabular-nums">
                  {tr('subagentRoute.count', { n: settings.types.length, max: MAX_SUBAGENT_TYPES })}
                </span>
              </h4>
              <p className="mt-0.5 text-meta text-fg-muted">{tr('subagentRoute.typesHint')}</p>
            </div>
            <Button icon={Plus} variant="primary" disabled={!!draft} onClick={() => startNew()}>
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

          <div className="mt-5 mb-2 flex items-baseline gap-2">
            <h4 data-setting-title={tr('subagentRoute.templates')} className="text-ui font-semibold text-fg">
              {tr('subagentRoute.templates')}
            </h4>
            <span className="text-meta text-fg-muted">{tr('subagentRoute.templatesHint')}</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))] gap-2">
            {SUBAGENT_TEMPLATES.map(t => {
              const Icon = TYPE_ICONS[t.id]!
              const used = ids.includes(t.id)
              return (
                <button
                  key={t.id}
                  type="button"
                  data-subagent-template={t.id}
                  disabled={used || !!draft}
                  title={used ? tr('subagentRoute.templateUsed') : undefined}
                  onClick={() => startNew(undefined, t)}
                  className="flex items-start gap-2.5 rounded-lg border border-dashed border-line-card px-3 py-2.5 text-left hover:border-solid hover:bg-surface disabled:pointer-events-none disabled:opacity-45"
                >
                  <span className="grid size-[26px] shrink-0 place-items-center rounded-md bg-subtle text-fg-secondary">
                    <Icon size={14} strokeWidth={1.7} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-meta font-semibold text-fg">{templateName(t)}</span>
                    <span className="block text-label text-fg-muted">
                      {tr('subagentRoute.templateMeta', {
                        tools: tr(t.tools === 'read' ? 'subagentRoute.toolsRead' : 'subagentRoute.toolsAll'),
                        time: minutesLabel(t.maxMinutes),
                      })}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <aside className="flex min-w-0 flex-col gap-4 @4xl:sticky @4xl:top-0">
          <div className="rounded-xl border border-line-card bg-surface">
            <h4 data-setting-title={tr('subagentRoute.shared')} className="px-4 pt-3 text-ui font-semibold text-fg">
              {tr('subagentRoute.shared')}
            </h4>
            <div className="divide-y divide-line-subtle">
              <div
                data-setting-title={tr('subagentRoute.fallback')}
                className="flex items-start justify-between gap-4 px-4 py-3"
              >
                <div>
                  <div className="text-meta font-medium text-fg">{tr('subagentRoute.fallback')}</div>
                  <p className="mt-0.5 text-label text-fg-muted">{tr('subagentRoute.fallbackHint')}</p>
                </div>
                <Switch
                  label={tr('subagentRoute.fallback')}
                  checked={settings.fallback}
                  onChange={fallback => void save({ fallback })}
                />
              </div>
              <div
                data-setting-title={tr('subagentRoute.concurrency')}
                className="flex items-start justify-between gap-4 px-4 py-3"
              >
                <div>
                  <div className="text-meta font-medium text-fg">{tr('subagentRoute.concurrency')}</div>
                  <p className="mt-0.5 text-label text-fg-muted">{tr('subagentRoute.concurrencyHint')}</p>
                </div>
                <Segmented<`${SubagentConcurrency}`>
                  label={tr('subagentRoute.concurrency')}
                  value={`${settings.maxConcurrent}`}
                  onChange={v => void save({ maxConcurrent: Number(v) as SubagentConcurrency })}
                  options={SUBAGENT_CONCURRENCY.map(n => ({ value: `${n}` as const, label: String(n) }))}
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-line-card bg-surface">
            <div className="flex items-baseline justify-between gap-3 px-4 pt-3">
              <h4 className="text-ui font-semibold text-fg">{tr('subagentRoute.preview')}</h4>
              <span className="text-label text-fg-faint">{tr('subagentRoute.previewTool')}</span>
            </div>
            <div
              data-subagent-preview=""
              className="mx-4 mt-2.5 max-h-72 overflow-auto rounded-lg border border-line-subtle bg-app px-3 py-2.5 font-mono text-label leading-relaxed break-words whitespace-pre-wrap text-fg-secondary"
            >
              {lines.length ? (
                <>
                  <span className="text-fg-faint">{TASK_TYPES_HEADER}</span>
                  {lines.map(line => (
                    <span key={line} className="mt-1.5 block">
                      <span className="text-accent-fg">{line.slice(0, line.indexOf(' ('))}</span>
                      {line.slice(line.indexOf(' ('))}
                    </span>
                  ))}
                </>
              ) : (
                <span className="font-sans text-fg-muted">{tr('subagentRoute.previewSingle')}</span>
              )}
            </div>
            <p className="px-4 pt-2 pb-3 text-label text-fg-muted">{tr('subagentRoute.previewHint')}</p>
          </div>
        </aside>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
