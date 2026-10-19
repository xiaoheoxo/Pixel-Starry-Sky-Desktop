import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, RefreshCw } from 'lucide-react'
import { IconButton } from '@/ui'
import { EmptyState, PanelCard } from './PanelSurface'
import { tr, translateMessage } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'
import { onStoredChange, readStoredJson } from '@/features/settings/storedValue'
export const FIELD =
  'h-8 w-full min-w-0 rounded-md border border-line bg-surface px-2.5 text-list text-fg outline-none focus-visible:border-accent'
export const CARD = 'shrink-0 rounded-lg border border-line-card bg-surface p-3 shadow-sm'
export function NoProject() {
  useI18n()
  return (
    <div className="flex min-h-0 flex-1 p-3">
      <PanelCard>
        <EmptyState icon={Box} title={tr('projectTools.noProject')} hint={tr('projectTools.noProjectHint')} />
      </PanelCard>
    </div>
  )
}
export function ToolsHeader({
  title,
  subtitle,
  busy,
  refresh,
}: {
  title: string
  subtitle?: string
  busy?: boolean
  refresh?: () => void
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <div className="min-w-0">
        <h2 className="text-ui font-medium text-fg">{title}</h2>
        {subtitle && (
          <p title={subtitle} className="truncate text-meta text-fg-muted">
            {subtitle}
          </p>
        )}
      </div>
      {refresh && <IconButton disabled={busy} icon={RefreshCw} label={tr('projectTools.refresh')} onClick={refresh} />}
    </div>
  )
}
export function ToolError({ error }: { error: string }) {
  useI18n()
  return error ? (
    <p role="alert" className="shrink-0 break-words rounded-md bg-subtle p-2 text-meta text-danger">
      {translateMessage(error)}
    </p>
  ) : null
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-meta text-fg-muted">
      {label}
      {children}
    </label>
  )
}
export function useOperation() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const active = useRef(false),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = async (fn: () => Promise<void>): Promise<boolean> => {
    if (active.current) return false
    active.current = true
    setBusy(true)
    setError('')
    try {
      await fn()
      return true
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      active.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return { busy, error, setError, run }
}
export function useRemember<T>(key: string, initial: T): [T, (next: T) => void] {
  const [state, setState] = useState<T>(() => readStoredJson(key, initial))
  // 另一个窗口或云同步改了这个键：重新读（storedValue.ts）
  const initialRef = useRef(initial)
  useEffect(() => onStoredChange(key, () => setState(readStoredJson(key, initialRef.current))), [key])
  return [
    state,
    next => {
      setState(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {}
    },
  ]
}
