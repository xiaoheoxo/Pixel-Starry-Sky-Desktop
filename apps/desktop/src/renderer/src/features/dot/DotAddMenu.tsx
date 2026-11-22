import { useEffect, useState } from 'react'
import { ExternalLink, Link, Monitor, Paperclip, Puzzle, Settings } from 'lucide-react'
import { ActionMenu, type MenuAction } from '@/ui/ActionMenu'
import { tr } from '@/i18n/core'
import { useI18n } from '@/i18n/I18nProvider'

type Plugin = { id: string; name: string; description: string; enabled: boolean }
type Catalog = Plugin[] | 'loading' | 'error'

/** References are draft text, not a capability grant or a silent share. */
export function chatGptReference(input: string): string | null {
  try {
    const url = new URL(input.trim())
    if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.pathname === '/') return null
    return url.href
  } catch {
    return null
  }
}

export function DotAddMenu({
  x,
  y,
  web,
  onClose,
  onFiles,
  onComputer,
  onReference,
  onPlugin,
  onSettings,
}: {
  x: number
  y: number
  web: string
  onClose(): void
  onFiles(): void
  onComputer(): void
  onReference(): void
  onPlugin(text: string): void
  onSettings(): void
}) {
  useI18n()
  const [codex, setCodex] = useState<Catalog>('loading')
  const [claude, setClaude] = useState<Catalog>('loading')
  useEffect(() => {
    let active = true
    const bridge = window.pixelsky?.extensions
    const load = async (work: () => Promise<Plugin[] | undefined>, set: (next: Catalog) => void) => {
      try {
        const items = await work()
        if (active) set(items ?? 'error')
      } catch {
        if (active) set('error')
      }
    }
    void load(async () => bridge?.codexPlugins(), setCodex)
    void load(
      async () =>
        (await bridge?.state())?.entries
          .filter(p => p.kind === 'plugin' && p.scope.kind === 'global' && (p.engines ?? ['claude']).includes('claude'))
          .map(p => ({ id: p.name, name: p.name, description: p.description, enabled: p.enabled })),
      setClaude,
    )
    return () => {
      active = false
    }
  }, [])
  const children = (list: Catalog, engine: string): MenuAction[] => {
    if (!Array.isArray(list))
      return [{ label: tr(list === 'loading' ? 'dot.add.pluginLoading' : 'dot.add.pluginUnavailable'), disabled: true }]
    if (!list.length) return [{ label: tr('dot.add.noPlugins'), disabled: true }]
    return [...new Map(list.map(p => [p.id, p])).values()].map(p => ({
      label: p.name,
      title: [p.description, tr('dot.add.pluginRef')].filter(Boolean).join('\n'),
      hint: p.enabled ? undefined : tr('dot.add.pluginDisabled'),
      disabled: !p.enabled,
      run: () => onPlugin(tr('dot.add.pluginDraft', { engine, id: p.id })),
    }))
  }
  return (
    <ActionMenu
      x={x}
      y={y}
      label={tr('dot.add')}
      onClose={onClose}
      actions={[
        { label: tr('dot.addFiles'), section: tr('dot.add'), icon: Paperclip, run: onFiles },
        { label: tr('dot.add.reference'), icon: Link, run: onReference },
        { label: tr('dot.computer'), icon: Monitor, run: onComputer },
        { label: 'Codex', section: tr('dot.add.plugins'), icon: Puzzle, children: children(codex, 'Codex') },
        { label: 'Claude Code', icon: Puzzle, children: children(claude, 'Claude Code') },
        { label: tr('dot.add.pluginSettings'), icon: Settings, run: onSettings },
        {
          label: tr('dot.add.native'),
          icon: ExternalLink,
          separator: true,
          run: () => window.open(web, '_blank', 'noopener,noreferrer'),
        },
      ]}
    />
  )
}
