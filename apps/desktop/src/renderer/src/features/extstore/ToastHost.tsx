import { useEffect } from 'react'
import { useToast } from '@/ui'
import { tr } from '@/i18n/core'
import { useSettings } from '@/features/settings/SettingsProvider'
import { openExtDetail } from './nav'
import { subscribeInstallToasts } from './store'

/** 装好 / 失败的提示：状态单例算出来，这里用现成的 Toast 弹（装好带「查看」跳详情） */
export function ExtStoreToastHost() {
  const toast = useToast()
  const settings = useSettings()
  useEffect(
    () =>
      subscribeInstallToasts(t => {
        if (t.kind === 'failed')
          return toast(tr('extstore.toast.failed', { name: t.name, reason: t.reason }), { duration: 4000 })
        const key =
          t.kind === 'rolledBack'
            ? 'extstore.toast.rolledBack'
            : t.kind === 'updated'
              ? 'extstore.toast.updated'
              : 'extstore.toast.installed'
        toast(tr(key, { name: t.name }), {
          action: {
            label: tr('extstore.toast.view'),
            run: () => {
              openExtDetail(t.id)
              settings.openSettings('extensions')
            },
          },
        })
      }),
    [toast, settings],
  )
  return null
}
