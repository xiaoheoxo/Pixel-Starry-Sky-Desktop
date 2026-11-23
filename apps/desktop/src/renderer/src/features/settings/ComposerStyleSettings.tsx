import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '../../i18n/core'
import { ArrowUp, Check, Plus, ShieldCheck, ChevronDown, Circle } from 'lucide-react'
import { Segmented, cn } from '@/ui'
import { SettingRow } from './SettingRow'
import { setComposerStyle, useComposerStyle, type ComposerStyle } from './composerStyle'

const OPTIONS: { value: ComposerStyle; label: string }[] = [
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'claude', label: 'Claude' },
]
export function ComposerStyleSettings() {
  useI18n()
  const selected = useComposerStyle()
  return (
    <SettingRow
      title={tr('settings.ComposerStyleSettings.composerStyle')}
      description={tr('settings.ComposerStyleSettings.chatgptPlacesToolsInside')}
      control={
        <Segmented
          label={tr('settings.ComposerStyleSettings.composerStyle')}
          options={OPTIONS}
          value={selected}
          onChange={setComposerStyle}
        />
      }
    >
      <div className="grid grid-cols-2 gap-3 @max-[640px]:grid-cols-1">
        {OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            aria-label={tr('settings.ComposerStyleSettings.chooseComposerStyle', { p0: option.label })}
            aria-pressed={selected === option.value}
            onClick={() => setComposerStyle(option.value)}
            className={cn(
              'cursor-pointer rounded-lg border p-3 text-left transition-colors hover:bg-hover',
              selected === option.value ? 'border-accent-line bg-accent-soft/35' : 'border-transparent bg-subtle/65',
            )}
          >
            <div className="mb-2 flex items-center justify-between text-ui font-medium text-fg">
              <span>{option.label}</span>
              {selected === option.value && <Check size={14} className="text-accent-fg" />}
            </div>
            <div
              aria-hidden
              className={cn(
                'rounded-xl border border-line-composer bg-surface p-2',
                option.value === 'chatgpt' && 'pb-1',
              )}
            >
              <div className="flex h-9 items-center justify-between gap-2 text-meta text-fg-faint">
                <span>{tr('settings.ComposerStyleSettings.typeMessage')}</span>
                {option.value === 'claude' && <SendMark />}
              </div>
              {option.value === 'chatgpt' && <PreviewTools send />}
            </div>
            {option.value === 'claude' && (
              <div aria-hidden className="mt-1 px-1">
                <PreviewTools />
              </div>
            )}
            <p className="mt-2 text-meta text-fg-muted">
              {option.value === 'chatgpt'
                ? tr('settings.ComposerStyleSettings.toolsAndSendButton')
                : tr('settings.ComposerStyleSettings.settingsOutsideSendButton')}
            </p>
          </button>
        ))}
      </div>
    </SettingRow>
  )
}
function PreviewTools({ send = false }: { send?: boolean }) {
  useI18n()
  return (
    <div className="flex h-6 items-center gap-1 text-fg-muted">
      <Plus size={12} />
      <ShieldCheck size={12} />
      <span className="flex-1" />
      <span className="text-label">{tr('session.ModelSourceMenu.model')}</span>
      <ChevronDown size={10} />
      <span className="text-label">{tr('settings.ComposerStyleSettings.effort')}</span>
      <Circle size={10} />
      {send && <SendMark />}
    </div>
  )
}
function SendMark() {
  useI18n()
  return (
    <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-fg">
      <ArrowUp size={12} />
    </span>
  )
}
