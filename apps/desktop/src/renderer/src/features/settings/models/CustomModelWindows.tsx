// 设置 › 模型通道 › 菜单里显示的模型下面：自定义 API 的模型和上下文窗口（docs/ui/context-settings-branch-switch.md §2.3.1）。
// 和「自定义 API」卡片里接口配置的窗口是同一个值，改哪边都一样（保存整个接口时只带 models，Key、请求头等不动）
import { useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { saveProvider, useProviders } from '@/features/account/providers'
import type { ProviderView } from '../../../../../shared/types/providers'
import { ContextWindowInput } from './ContextWindowInput'

/** 改一个模型的窗口：接口的其余设置原样保留 */
export function withModelWindow(p: ProviderView, model: string, value: number | null): ProviderView['models'] {
  return p.models.map(m => (m.id === model ? { ...m, contextWindow: value } : m))
}

export function CustomModelWindows() {
  useI18n()
  const { providers } = useProviders()
  const [error, setError] = useState<string | null>(null)
  const withModels = providers.filter(p => p.models.length > 0)
  if (!withModels.length) return null
  const save = (p: ProviderView, model: string, value: number | null): void => {
    setError(null)
    if ((p.models.find(m => m.id === model)?.contextWindow ?? null) === value) return
    saveProvider({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      models: withModelWindow(p, model, value),
    }).catch((e: unknown) => setError((e as Error).message))
  }
  return (
    <div data-custom-model-windows className="mt-5">
      <div className="mb-2">
        <div className="text-ui font-medium text-fg">{tr('contextWindow.customTitle')}</div>
        <p className="mt-1 text-meta text-fg-muted">{tr('contextWindow.customHint')}</p>
        {error && (
          <p role="alert" className="mt-1 text-meta text-danger">
            {translateMessage(error)}
          </p>
        )}
      </div>
      <div className="overflow-hidden rounded-xl bg-surface shadow-sm">
        {withModels.map(p => (
          <div key={p.id} className="border-t border-line-subtle first:border-t-0">
            <div className="bg-subtle px-4 py-1.5 text-meta text-fg-muted">{p.name}</div>
            {p.models.map(m => (
              <div key={m.id} className="flex items-center gap-3 border-t border-line-subtle px-4 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-meta text-fg">{m.id}</span>
                <ContextWindowInput
                  value={m.contextWindow ?? null}
                  label={tr('contextWindow.of', { model: m.id })}
                  commit="blur"
                  onChange={value => save(p, m.id, value)}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
