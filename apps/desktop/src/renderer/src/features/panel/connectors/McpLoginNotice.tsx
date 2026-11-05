import { useEffect, useRef, useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { IconButton, useToast } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { useEngineState } from '@/features/engine'
import { usePackState } from '@/features/extpacks/store'
import { pendingLogins } from '@/features/extstore/connectors'
import { packTitle } from '@/features/settings/extensions/model'

/** 关掉过提示的会话：切到别的会话再回来输入框会重新挂载，记在组件里就又冒出来了 */
const dismissedSessions = new Set<string>()

/** 输入框上面一行：扩展里启用的连接器在这个会话还没登录（docs/ui/one-click-connectors.md）。关掉后这个会话不再提示 */
export function McpLoginNotice({ sessionId }: { sessionId: string }) {
  const { locale, t } = useI18n()
  const toast = useToast()
  const report = useEngineState(s => s.snapshots[sessionId]?.mcp)
  const packs = usePackState().packs
  const [dismissed, setDismissed] = useState(() => dismissedSessions.has(sessionId))
  const [busy, setBusy] = useState(false)
  const loginOpened = useRef(false)
  // 引擎在本机端口接授权回调，但不会主动报告状态变了：从浏览器回来时取一次，登录好了这行就消失
  useEffect(() => {
    const refresh = (): void => {
      if (loginOpened.current) void window.pixelsky?.engine.mcp(sessionId, { kind: 'refresh' }).catch(() => undefined)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [sessionId])
  const pending = pendingLogins(report, packs)
  if (dismissed || !pending.length) return null

  const login = async (name: string): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.pixelsky?.engine.mcp(sessionId, { kind: 'login', name })
      if (result?.url) {
        loginOpened.current = true
        await window.pixelsky?.projectTools.openExternal(result.url)
        toast(tr('connectors.loginOpenedNotice'))
      }
    } catch (e) {
      toast(translateMessage((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-mcp-login-notice
      className="mb-2 flex min-w-0 items-center gap-2 rounded-lg border border-line-subtle bg-surface py-1 pr-1 pl-3 text-meta text-fg-muted"
    >
      <TriangleAlert size={13} strokeWidth={1.5} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        {t('connectors.loginNotice', {
          names: pending.map(p => packTitle(p.pack, locale)).join(t('channels.composer.nameSep')),
        })}
      </span>
      {pending.map(p => (
        <button
          key={p.name}
          type="button"
          disabled={busy}
          data-mcp-login={p.name}
          onClick={() => void login(p.name)}
          className="press no-drag shrink-0 rounded-md border border-line px-2 py-0.5 text-fg-secondary hover:bg-hover disabled:opacity-50"
        >
          {pending.length > 1 ? `${t('connectors.login')} ${p.name}` : t('connectors.login')}
        </button>
      ))}
      <IconButton
        icon={X}
        label={t('channels.attach.dismissError')}
        size={22}
        iconSize={13}
        onClick={() => {
          dismissedSessions.add(sessionId)
          setDismissed(true)
        }}
      />
    </div>
  )
}
