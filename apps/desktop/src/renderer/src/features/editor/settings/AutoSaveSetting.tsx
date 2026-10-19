import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Select } from '@/ui'
import { SettingRow } from '../../settings/SettingRow'
import {
  AUTO_SAVE_MODES,
  DELAY_MAX,
  DELAY_MIN,
  getAutoSave,
  setAutoSave,
  useAutoSave,
  type AutoSaveMode,
} from '../autoSaveModel'

const MODE_KEYS = {
  off: 'editor.autoSave.off',
  afterDelay: 'editor.autoSave.afterDelay',
  onFocusChange: 'editor.autoSave.onFocusChange',
  onWindowChange: 'editor.autoSave.onWindowChange',
} as const satisfies Record<AutoSaveMode, string>

const HINT_KEYS = {
  off: 'editor.autoSave.hint.off',
  afterDelay: 'editor.autoSave.hint.afterDelay',
  onFocusChange: 'editor.autoSave.hint.onFocusChange',
  onWindowChange: 'editor.autoSave.hint.onWindowChange',
} as const satisfies Record<AutoSaveMode, string>

/** 设置 › 编辑器 › 自动保存：四种时机（同 VS Code 的 files.autoSave），「停止输入后」可以改延迟 */
export function AutoSaveSetting() {
  const { t } = useI18n()
  const prefs = useAutoSave()
  const [draft, setDraft] = useState(String(prefs.delay))
  useEffect(() => setDraft(String(prefs.delay)), [prefs.delay])

  // 不是数字时回到原来的值；超出范围的夹到范围里，输入框显示夹过的值
  const commitDelay = (): void => {
    const n = Number(draft)
    if (draft.trim() !== '' && Number.isFinite(n)) setAutoSave({ delay: n })
    setDraft(String(getAutoSave().delay))
  }

  return (
    <SettingRow title={tr('editor.autoSave.title')} description={tr('editor.autoSave.description')}>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          label={t('editor.autoSave.title')}
          value={prefs.mode}
          options={AUTO_SAVE_MODES.map(mode => ({
            value: mode,
            label: t(MODE_KEYS[mode]),
            ...(mode === 'off' ? { hint: t('editor.autoSave.default') } : {}),
          }))}
          onChange={mode => setAutoSave({ mode })}
        />
        {prefs.mode === 'afterDelay' && (
          <label className="flex items-center gap-2 text-ui text-fg-secondary">
            {t('editor.autoSave.delay')}
            <input
              data-autosave-delay
              type="number"
              inputMode="numeric"
              min={DELAY_MIN}
              max={DELAY_MAX}
              step={100}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commitDelay}
              onKeyDown={e => {
                if (e.key === 'Enter') commitDelay()
              }}
              className="h-8 w-24 rounded-md border border-line bg-surface px-2 text-ui text-fg tabular-nums outline-none focus:border-line-strong"
            />
          </label>
        )}
      </div>
      <p className="mt-2 text-meta text-fg-muted">
        {t(HINT_KEYS[prefs.mode], { seconds: String(prefs.delay / 1000) })}
      </p>
      {prefs.mode !== 'off' && <p className="mt-1 text-meta text-fg-faint">{t('editor.autoSave.note')}</p>}
    </SettingRow>
  )
}
