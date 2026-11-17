// 整页打不开 / 网页崩溃时网页区域里的错误页（docs/ui/browser-v2.md §3.1）：原因、重试、用系统浏览器打开、换对话里发现的端口
import { ExternalLink, RefreshCw, Unplug } from 'lucide-react'
import { Button } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import type { FoundPort } from '@/features/session/live/portTipsModel'
import type { BrowserPage } from '../../../../shared/types/project-browser'
import { addressParts, loadFailureReason } from './browserModel'

export function BrowserErrorPage({
  page,
  ports,
  busy,
  demo,
  onRetry,
  onOpenExternal,
  onOpenPort,
}: {
  page: BrowserPage
  ports: readonly FoundPort[]
  busy: boolean
  demo: boolean
  onRetry: () => void
  onOpenExternal: () => void
  onOpenPort: (port: number) => void
}) {
  useI18n()
  const code = page.failed ?? -2
  const url = page.remoteUrl ?? page.url
  const parts = addressParts(url)
  const crashed = code === 0
  const own = (() => {
    try {
      return Number(new URL(url).port) || null
    } catch {
      return null
    }
  })()
  const others = ports.filter(p => p.port !== own).slice(0, 6)
  return (
    <div
      data-browser-error-page
      className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-meta text-fg-muted"
    >
      <span className="mb-1 grid size-11 place-items-center rounded-xl bg-danger/10 text-danger">
        <Unplug size={20} strokeWidth={1.75} />
      </span>
      <h4 className="text-ui font-semibold text-fg">
        {crashed ? tr('projectTools.crashedTitle') : tr('projectTools.loadFailedTitle', { host: parts.host || url })}
      </h4>
      <p className="max-w-80">{tr(loadFailureReason(code))}</p>
      {page.error && <p className="max-w-80 font-mono text-label break-all text-fg-faint">{page.error}</p>}
      <div className="mt-2 flex flex-wrap justify-center gap-1.5">
        <Button variant="primary" icon={RefreshCw} disabled={busy} onClick={onRetry}>
          {tr('projectTools.retry')}
        </Button>
        {!crashed && (
          <Button icon={ExternalLink} disabled={busy || demo} onClick={onOpenExternal}>
            {tr('projectTools.openExternal')}
          </Button>
        )}
      </div>
      {others.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1 text-label text-fg-faint">
          {tr('projectTools.otherPorts')}
          {others.map(p => (
            <button
              key={p.port}
              type="button"
              disabled={busy}
              title={p.command}
              onClick={() => onOpenPort(p.port)}
              className="rounded-sm bg-subtle px-1.5 font-mono text-fg-secondary hover:bg-hover"
            >
              :{p.port}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
