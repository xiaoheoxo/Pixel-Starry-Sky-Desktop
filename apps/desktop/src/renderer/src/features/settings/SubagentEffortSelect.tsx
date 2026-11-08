import { useEffect, useState } from 'react'
import { SUBAGENT_EFFORTS, type Effort } from '@pixelsky/protocol'
import { useEngineCatalog } from '@/features/engine/catalog'
import { effortLabel } from '@/features/engine/labels'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Select } from '@/ui'
import { subagentModelEfforts } from './subagentEfforts'

export function SubagentEffortSelect({
  model,
  value,
  onChange,
  usePixelCatalog = true,
}: {
  model: string | null
  value: Effort | null
  onChange: (value: Effort | null) => void
  /** 外部线路没有同源能力目录时，不能拿 Pixel 自有目录按模型名猜。 */
  usePixelCatalog?: boolean
}) {
  useI18n()
  const catalog = useEngineCatalog('pixel')
  const known = subagentModelEfforts(catalog, model, usePixelCatalog)
  const efforts = known ?? SUBAGENT_EFFORTS
  const unsupported = known?.length === 0
  const invalid = !!value && !!known && !known.includes(value)
  const [reset, setReset] = useState(false)
  useEffect(() => {
    if (!invalid) return
    setReset(true)
    onChange(null)
  }, [invalid, onChange])
  return (
    <div>
      <Select<Effort | ''>
        label={tr('subagentRoute.effort.title')}
        value={invalid ? '' : (value ?? '')}
        disabled={unsupported}
        options={[
          { value: '', label: tr(unsupported ? 'subagentRoute.effort.unsupported' : 'subagentRoute.follow') },
          ...efforts.map(e => ({ value: e, label: effortLabel(e) })),
        ]}
        onChange={next => {
          setReset(false)
          onChange(next || null)
        }}
      />
      <p className="mt-1.5 text-meta text-fg-muted">
        {tr(
          unsupported
            ? 'subagentRoute.effort.unsupported'
            : reset
              ? 'subagentRoute.effort.reset'
              : known
                ? 'subagentRoute.effort.hint'
                : 'subagentRoute.effort.unknown',
        )}
      </p>
    </div>
  )
}
