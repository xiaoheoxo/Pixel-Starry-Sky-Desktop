// 扩展详情里的命令和权限（docs/ui/extension-commands-plan.md §5.2）：packKey 不传时只显示（商店里还没装）
import type { ExtCommand, ExtPackScriptStatus } from '@pixelsky/protocol'
import { extText } from '@pixelsky/protocol'
import { useI18n } from '@/i18n/I18nProvider'
import { Button } from '@/ui'
import { formatBinding, parseBinding } from '@/features/layout/keybindingModel'
import { isMac } from '@/features/layout/keybindings'
import { PERMISSION_TEXT } from './model'

export function ScriptPermissions({
  commands,
  permissions,
  status,
  packKey,
}: {
  commands: ExtCommand[] | undefined
  permissions: readonly unknown[] | undefined
  status?: ExtPackScriptStatus
  packKey?: string
}) {
  const { locale, t } = useI18n()
  if (!commands?.length) return null
  const asked = (permissions ?? []).filter((p): p is string => typeof p === 'string')
  return (
    <section data-script-permissions className="mt-5">
      <h5 className="mb-2 text-label font-medium text-fg-muted">{t('extCommands.detail.commands')}</h5>
      {status?.blocked && <p className="mb-2 text-ui text-warn">{t('extCommands.detail.blocked')}</p>}
      <ul className="space-y-1">
        {commands.map(c => {
          const binding = c.keybinding ? parseBinding(c.keybinding) : null
          return (
            <li key={c.id} className="flex items-baseline gap-2 text-ui text-fg">
              <span className="min-w-0 truncate">{extText(c.title, locale)}</span>
              {binding && <span className="text-meta text-fg-faint">{formatBinding(binding, isMac)}</span>}
            </li>
          )
        })}
      </ul>
      <h5 className="mt-4 mb-2 text-label font-medium text-fg-muted">{t('extCommands.detail.permissions')}</h5>
      {asked.length === 0 ? (
        <p className="text-ui text-fg-faint">{t('extCommands.detail.noPermissions')}</p>
      ) : (
        <ul className="space-y-1">
          {asked.map(p => {
            const granted = status?.granted.includes(p)
            return (
              <li key={p} className="flex items-center gap-2 text-ui text-fg">
                <span className="min-w-0 flex-1">{PERMISSION_TEXT[p] ? t(PERMISSION_TEXT[p]) : p}</span>
                {packKey && (
                  <span className="text-meta text-fg-faint">
                    {granted ? t('extCommands.detail.granted') : t('extCommands.detail.notGranted')}
                  </span>
                )}
                {packKey && granted && (
                  <Button variant="ghost" onClick={() => void window.pixelsky?.extCommands.revoke(packKey, p)}>
                    {t('extCommands.detail.revoke')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-2 text-meta text-fg-faint">{t('extCommands.detail.footnote')}</p>
    </section>
  )
}
