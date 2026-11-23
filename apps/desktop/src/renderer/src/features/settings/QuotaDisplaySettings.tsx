import { ChevronDown } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { ContextRing, Segmented } from '@/ui'
import { quotaPreviewNear, quotaPreviewNormal } from '@/data/quotaPreview'
import { QuotaTrigger } from '@/features/session/quota/QuotaTrigger'
import { quotaButtonView } from '@/features/session/quota/quotaModel'
import { SettingRow, Toggle } from './SettingRow'
import { setQuotaDisplay, useQuotaDisplay, type QuotaDisplay } from './quotaDisplay'

/** 设置 › 外观 › 对话：输入框显示账号额度（开关 + 什么时候显示 + 按钮样式 + 预览，docs/ui/account-quota.md §6.8） */
export function QuotaDisplaySettings() {
  const display = useQuotaDisplay()
  return <QuotaDisplayRow display={display} onChange={setQuotaDisplay} />
}

/** 设置那一行本体（数据和回调从 props 进来，便于静态渲染测试） */
export function QuotaDisplayRow({
  display,
  onChange,
  now = Date.now(),
}: {
  display: QuotaDisplay
  onChange: (patch: Partial<QuotaDisplay>) => void
  now?: number
}) {
  useI18n()
  const near = display.when === 'near-limit'
  // 预览跟着两个选项变：「快用完时才显示」画出到了 80% 才会出现的橙色样子
  const view = quotaButtonView(near ? quotaPreviewNear : quotaPreviewNormal, {
    provider: 'claude',
    loading: false,
    now,
  })
  return (
    <SettingRow
      title={tr('quota.settings.title')}
      description={tr('quota.settings.desc')}
      hint={display.enabled ? undefined : tr('quota.settings.hidden')}
      control={
        <Toggle
          label={tr('quota.settings.title')}
          checked={display.enabled}
          onChange={enabled => onChange({ enabled })}
        />
      }
    >
      {display.enabled && (
        <>
          <div className="mt-1 mb-3 grid grid-cols-[110px_1fr] items-center gap-x-3.5 gap-y-2.5 text-meta text-fg-muted">
            <span>{tr('quota.settings.when')}</span>
            <div>
              <Segmented
                label={tr('quota.settings.when')}
                options={[
                  { value: 'always', label: tr('quota.settings.whenAlways') },
                  { value: 'near-limit', label: tr('quota.settings.whenNear') },
                ]}
                value={display.when}
                onChange={when => onChange({ when })}
              />
            </div>
            <span>{tr('quota.settings.style')}</span>
            <div>
              <Segmented
                label={tr('quota.settings.style')}
                options={[
                  { value: 'full', label: tr('quota.settings.styleFull') },
                  { value: 'icon', label: tr('quota.settings.styleIcon') },
                ]}
                value={display.style}
                onChange={style => onChange({ style })}
              />
            </div>
          </div>
          <div className="rounded-lg bg-subtle/75 px-3.5 py-3" aria-label={tr('quota.settings.previewLabel')}>
            <div className="mb-2 text-label text-fg-muted">{tr('quota.settings.preview')}</div>
            <div
              aria-hidden
              className="flex w-fit items-center gap-0.5 rounded-[10px] border border-line-card bg-surface px-1.5 py-0.5 text-list text-fg-secondary"
            >
              <span className="inline-flex h-8 items-center gap-1 px-2">
                {tr('quota.settings.previewEffort')}
                <ChevronDown size={14} strokeWidth={1.5} className="text-fg-muted" />
              </span>
              <QuotaTrigger view={view} style={display.style} preview />
              <span className="inline-flex h-8 items-center gap-1.5 px-2 text-meta text-fg-muted">
                <ContextRing percent={22.6} size={16} />
                <span className="tabular-nums">22.6%</span>
              </span>
            </div>
            {near && <p className="mt-2 text-meta text-fg-muted">{tr('quota.settings.previewNear')}</p>}
          </div>
        </>
      )}
    </SettingRow>
  )
}
