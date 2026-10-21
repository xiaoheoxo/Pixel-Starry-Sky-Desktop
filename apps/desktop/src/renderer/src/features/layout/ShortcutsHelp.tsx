// 快捷键一览（docs/ui/ui-polish-2026-10-13.md §5）：Ctrl+/（macOS ⌘/，可以改）或命令面板打开。
// 列出能改的（按当前设置）、固定的、输入框和菜单里的按键；底下「自定义快捷键…」跳到设置页。
import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, type TranslationKey } from '@/i18n/core'
import { useSettings } from '@/features/settings/SettingsProvider'
import { Kbd } from '@/ui'
import { ACTIONS, FIXED, isMac, labelOf, useKeybindings } from './keybindings'
import { SHORTCUTS_HELP } from './shortcuts'

/** 命令面板里的「快捷键一览」发这个事件 */
export const SHORTCUTS_HELP_EVENT = 'pixelsky:shortcuts-help'

interface Row {
  label: string
  keys: string
}

const fixedRow = (label: TranslationKey, keys: string): Row => ({ label: tr(label), keys })

function groups(): { title: string; rows: Row[] }[] {
  const enter = isMac ? '↩' : 'Enter'
  return [
    {
      title: tr('shortcuts.help.groupGeneral'),
      rows: ACTIONS.map(a => ({ label: tr(a.label), keys: labelOf(a.id) })),
    },
    { title: tr('shortcuts.help.groupPanes'), rows: FIXED.map(f => ({ label: tr(f.label), keys: f.keys() })) },
    {
      title: tr('shortcuts.help.groupComposer'),
      rows: [
        fixedRow('shortcuts.help.send', enter),
        fixedRow('shortcuts.help.newline', isMac ? `⇧${enter}` : `Shift+${enter}`),
        fixedRow('shortcuts.help.stop', 'Esc'),
        fixedRow('shortcuts.help.mention', '@'),
        fixedRow('shortcuts.help.command', '/'),
        fixedRow('shortcuts.help.suggestion', 'Tab'),
      ],
    },
    {
      title: tr('coding.shell.help.group'),
      rows: [
        { label: tr('coding.shell.help.ctrlP'), keys: labelOf('openSearch') },
        { label: tr('coding.shell.help.ctrlB'), keys: labelOf('toggleSidebar') },
        { label: tr('coding.shell.help.ctrlAltB'), keys: labelOf('togglePanel') },
        { label: tr('coding.shell.help.ctrlJ'), keys: labelOf('toggleBottomPanel') },
        fixedRow('coding.shell.help.hashChat', '#'),
      ],
    },
    {
      title: tr('path.groupConversation'),
      rows: [fixedRow('path.shortcutReveal', isMac ? `⇧${enter}` : `Shift+${enter}`)],
    },
    {
      title: tr('shortcuts.help.groupMenus'),
      rows: [
        fixedRow('shortcuts.help.menuMove', '↑ / ↓'),
        fixedRow('shortcuts.help.menuSub', '→ / ←'),
        fixedRow('shortcuts.help.menuPick', '1–9'),
        fixedRow('shortcuts.help.menuClose', 'Esc'),
      ],
    },
    {
      // 审批卡、提问卡上的按键（session/live/approvals/cardKeys.ts）
      title: tr('shortcuts.help.groupApprovals'),
      rows: [
        fixedRow('shortcuts.help.approvalAllow', isMac ? `⌘${enter}` : `Ctrl+${enter}`),
        fixedRow('shortcuts.help.approvalAlways', isMac ? `⇧⌘${enter}` : `Ctrl+Shift+${enter}`),
        fixedRow('shortcuts.help.approvalDeny', isMac ? '⌘⌫' : 'Ctrl+Backspace'),
        fixedRow('shortcuts.help.approvalBack', 'Esc'),
        fixedRow('shortcuts.help.questionPick', '1–9'),
        fixedRow('shortcuts.help.questionNext', enter),
        fixedRow('shortcuts.help.questionSubmit', isMac ? `⌘${enter}` : `Ctrl+${enter}`),
      ],
    },
    {
      title: tr('shortcuts.help.groupBoard'),
      rows: [fixedRow('shortcuts.help.boardNew', isMac ? '⌘N' : 'Ctrl+N'), fixedRow('shortcuts.help.boardSearch', '/')],
    },
  ]
}

export function ShortcutsHelp() {
  useI18n()
  useKeybindings()
  const settings = useSettings()
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement>(null),
    returnFocus = useRef<HTMLElement | null>(null)

  const show = (): void => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery('')
    setOpen(true)
  }
  const close = (refocus = true): void => {
    setOpen(false)
    if (refocus && returnFocus.current?.isConnected) returnFocus.current.focus()
  }
  const latest = useRef({ open, show, close })
  latest.current = { open, show, close }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 焦点不在对话框里（点了列表的空白处，焦点落到 body）时 Esc 也要能关
      if (e.key === 'Escape' && latest.current.open && !e.defaultPrevented && !e.isComposing) {
        e.preventDefault()
        latest.current.close()
        return
      }
      if (!SHORTCUTS_HELP.match(e) || e.defaultPrevented || e.isComposing) return
      if (latest.current.open) {
        e.preventDefault()
        latest.current.close()
        return
      }
      // 代码编辑器里 Ctrl+/ 是注释，终端里留给命令行；别的对话框开着时不叠上去。
      // 会话输入框也是 CodeMirror（.cm-editor），但没有注释功能，照常打开
      const active = document.activeElement
      const codeEditor = active?.closest('.cm-editor') && !active.closest('[data-composer-input]')
      if (codeEditor || active?.closest('[data-terminal-input]') || document.querySelector('[aria-modal="true"]'))
        return
      e.preventDefault()
      latest.current.show()
    }
    const onEvent = (): void => latest.current.show()
    window.addEventListener('keydown', onKey)
    window.addEventListener(SHORTCUTS_HELP_EVENT, onEvent)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(SHORTCUTS_HELP_EVENT, onEvent)
    }
  }, [])

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  if (!open) return null
  const q = query.trim().toLowerCase()
  const shown = groups()
    .map(g => ({
      ...g,
      rows: q ? g.rows.filter(r => `${r.label} ${r.keys}`.toLowerCase().includes(q)) : g.rows,
    }))
    .filter(g => g.rows.length)

  return (
    <div
      data-shortcuts-help
      role="dialog"
      aria-modal="true"
      aria-label={tr('shortcuts.help.title')}
      className="fixed inset-0 z-[75] flex items-start justify-center bg-scrim px-4 pt-[10vh]"
      onMouseDown={e => {
        if (e.target === e.currentTarget) close()
      }}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      <div className="pop-in flex max-h-[80vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-line-card bg-popover text-fg shadow-popover">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <h2 className="text-ui font-medium">{tr('shortcuts.help.title')}</h2>
          <label className="ml-auto flex h-8 w-56 items-center gap-2 rounded-md border border-line bg-subtle px-2">
            <Search size={14} className="shrink-0 text-fg-muted" />
            <input
              ref={input}
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label={tr('shortcuts.help.search')}
              placeholder={tr('shortcuts.help.search')}
              className="min-w-0 flex-1 bg-transparent text-meta outline-none placeholder:text-fg-faint"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="button" aria-label={tr('terminal.cancel')} onClick={() => close()} className="text-fg-muted">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
          {!shown.length && <p className="py-6 text-center text-meta text-fg-muted">{tr('shortcuts.help.none')}</p>}
          {shown.map(g => (
            <section key={g.title}>
              <h3 className="pt-3 pb-1 text-label font-medium text-fg-faint">{g.title}</h3>
              <ul>
                {g.rows.map(r => (
                  <li key={r.label} className="flex min-h-8 items-center gap-3 text-ui">
                    <span className="min-w-0 flex-1 truncate text-fg-secondary">{r.label}</span>
                    <Kbd className="rounded-sm border border-line bg-subtle px-1.5 py-0.5 text-fg-secondary">
                      {r.keys}
                    </Kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="flex shrink-0 justify-end border-t border-line px-4 py-2">
          <button
            type="button"
            data-shortcuts-customize
            onClick={() => {
              close(false)
              settings.openSettings('shortcuts')
            }}
            className="rounded-md px-2 py-1 text-meta text-accent-fg hover:bg-hover"
          >
            {tr('shortcuts.help.customize')}
          </button>
        </div>
      </div>
    </div>
  )
}
