import '@xterm/xterm/css/xterm.css'
import { Terminal, type ILink, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { useEffect, useRef, useState } from 'react'
import type { TerminalRecord } from '../../../../shared/types/terminal'
import { consumeTerminal, demoWrite, terminalError } from './store'
import { screens } from './screens'
import { isDemo } from '@/data'
import { openFile } from '@/features/files/store'
import { findPathMatches } from '@/features/files/pathMatch'
import { terminalFilePath } from './fileLinks'
import { COMMAND_PALETTE, NEW_TERMINAL, TOGGLE_TERMINAL } from '@/features/layout/shortcuts'
import { isMac } from '@/features/layout/keybindings'
import { isCopyKey } from './copyKey'
import { useI18n } from '@/i18n/I18nProvider'

const ansi = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const
export function TerminalView({
  record,
  visible,
  onPaste,
  onFind,
  onCycle,
}: {
  record: TerminalRecord
  visible: boolean
  onPaste: (id: string, text: string) => void
  onFind: () => void
  onCycle: (delta: number) => void
}) {
  const { t } = useI18n()
  const host = useRef<HTMLDivElement>(null),
    instance = useRef<Terminal | null>(null),
    refit = useRef<() => void>(() => {})
  const latest = useRef({ record, visible, onPaste, onFind, onCycle })
  latest.current = { record, visible, onPaste, onFind, onCycle }
  const [away, setAway] = useState(false),
    [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const el = host.current!
    const term = new Terminal({ cursorBlink: true, scrollback: 10000, allowProposedApi: false, screenReaderMode: true })
    const fit = new FitAddon(),
      search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.open(el)
    instance.current = term
    let disposed = false,
      seen = 0,
      gen = record.generation
    const applyStyle = (): void => {
      const style = getComputedStyle(el),
        root = getComputedStyle(document.documentElement)
      const color = (name: string) => root.getPropertyValue(name).trim()
      const theme: ITheme = {
        background: color('--terminal-bg'),
        foreground: color('--terminal-fg'),
        cursor: color('--terminal-cursor'),
        selectionBackground: color('--terminal-selection'),
      }
      ansi.forEach((name, index) => {
        theme[name] = color('--terminal-ansi-' + index)
      })
      term.options.theme = theme
      term.options.fontFamily = style.fontFamily
      term.options.fontSize = parseFloat(style.fontSize) || 13
      fitNow()
    }
    const fitNow = (): void => {
      if (disposed || el.clientWidth < 40 || el.clientHeight < 40) return
      fit.fit()
      const now = latest.current.record
      if (!isDemo && now.status === 'running')
        void window
          .pixelsky!.terminal.resize(record.id, now.generation, Math.min(500, term.cols), Math.min(300, term.rows))
          .catch(terminalError)
    }
    refit.current = fitNow
    applyStyle()
    const observer = new ResizeObserver(fitNow)
    observer.observe(el)
    const mutation = new MutationObserver(applyStyle)
    mutation.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme', 'data-wallpaper'],
    })
    const input = term.onData(data => {
      const now = latest.current.record
      if (now.status !== 'running') return
      if (isDemo) demoWrite(now.id, data)
      else void window.pixelsky!.terminal.write(now.id, now.generation, data).catch(terminalError)
    })
    const stop = consumeTerminal(record.id, event => {
      const ack = () => {
        if (!isDemo) window.pixelsky!.terminal.ack(event.terminalId, event.generation, event.seq)
      }
      if (event.generation < gen || (event.generation === gen && event.seq <= seen && !isDemo)) {
        ack()
        return
      }
      if (event.generation !== gen) {
        gen = event.generation
        seen = 0
        term.reset()
      }
      seen = event.seq
      term.write(event.data, ack)
    })
    const scroll = term.onScroll(() => setAway(term.buffer.active.viewportY < term.buffer.active.baseY))
    const paste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text/plain')
      if (text === undefined) return
      event.preventDefault()
      event.stopImmediatePropagation()
      latest.current.onPaste(record.id, text)
    }
    el.addEventListener('paste', paste, true)
    const copy = async (): Promise<void> => {
      if (term.hasSelection()) {
        if (isDemo) await navigator.clipboard.writeText(term.getSelection())
        else await window.pixelsky!.terminal.clipboardWrite(term.getSelection())
      }
    }
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true
      // 命令面板、终端的快捷键（可以自定义）交给应用处理，不发给终端
      if (COMMAND_PALETTE.match(event) || TOGGLE_TERMINAL.match(event) || NEW_TERMINAL.match(event)) return false
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyF' && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        latest.current.onFind()
        return false
      }
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        latest.current.onCycle(event.shiftKey ? -1 : 1)
        return false
      }
      if (isCopyKey(event, term.hasSelection(), isMac)) {
        event.preventDefault()
        // Ctrl+C 复制完清掉选区，下一次 Ctrl+C 就是中断
        const plain = !event.shiftKey
        void copy()
          .then(() => plain && term.clearSelection())
          .catch(terminalError)
        return false
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'KeyV') {
        event.preventDefault()
        void (isDemo ? navigator.clipboard.readText() : window.pixelsky!.terminal.clipboardRead())
          .then(text => latest.current.onPaste(record.id, text))
          .catch(terminalError)
        return false
      }
      return true
    })
    const links = term.registerLinkProvider({
      provideLinks(line, callback) {
        const value = term.buffer.active.getLine(line - 1)?.translateToString(true) ?? ''
        const urls: ILink[] = [...value.matchAll(/https?:\/\/[^\s<>"']+/g)].map(match => ({
          text: match[0],
          range: { start: { x: match.index + 1, y: line }, end: { x: match.index + match[0].length, y: line } },
          activate: (event, text) => {
            if (event.ctrlKey && !isDemo) void window.pixelsky!.terminal.openLink(text).catch(terminalError)
          },
        }))
        // 文件路径（docs/ui/files-search-terminal-pins.md §4.2）：只标项目内实际存在的文件，Ctrl+单击在右侧打开并定位
        const candidates = isDemo ? [] : findPathMatches(value)
        if (!candidates.length) return callback(urls.length ? urls : undefined)
        const current = latest.current.record
        void Promise.all(candidates.map(m => terminalFilePath(current, m.raw).catch(() => null))).then(resolved => {
          const files: ILink[] = candidates.flatMap((m, i) => {
            const path = resolved[i]
            if (!path) return []
            return [
              {
                text: value.slice(m.start, m.end),
                range: { start: { x: m.start + 1, y: line }, end: { x: m.end, y: line } },
                activate: (event: MouseEvent) => {
                  if (event.ctrlKey || event.metaKey)
                    void openFile({ projectId: current.projectId }, path, m.line ?? undefined, m.column ?? 1).catch(
                      terminalError,
                    )
                },
              },
            ]
          })
          const all = [...urls, ...files]
          callback(all.length ? all : undefined)
        })
      },
    })
    const screen = {
      focus: () => {
        fitNow()
        term.focus()
      },
      clear: () => {
        term.clear()
      },
      find: (query: string, backwards = false) => (backwards ? search.findPrevious(query) : search.findNext(query)),
      endSearch: () => search.clearDecorations(),
      copy,
      paste: (text: string) => term.paste(text),
      bottom: () => term.scrollToBottom(),
      lines: () => term.buffer.normal.length,
    }
    screens.set(record.id, screen)
    const contextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      setMenu({ x: Math.min(innerWidth - 190, event.clientX), y: Math.min(innerHeight - 115, event.clientY) })
    }
    el.addEventListener('contextmenu', contextMenu)
    return () => {
      disposed = true
      stop()
      observer.disconnect()
      mutation.disconnect()
      input.dispose()
      scroll.dispose()
      links.dispose()
      el.removeEventListener('paste', paste, true)
      el.removeEventListener('contextmenu', contextMenu)
      screens.delete(record.id)
      term.dispose()
      instance.current = null
    }
  }, [record.id])
  useEffect(() => {
    if (visible) requestAnimationFrame(() => refit.current())
  }, [visible, record.generation, record.status])
  useEffect(() => {
    if (!menu) return
    const dismiss = () => setMenu(null)
    window.addEventListener('pointerdown', dismiss)
    return () => window.removeEventListener('pointerdown', dismiss)
  }, [menu])
  return (
    <div className={visible ? 'relative flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'} inert={!visible}>
      <div
        ref={host}
        data-terminal-input={record.id}
        onFocus={() => window.pixelsky?.terminal.focused(true)}
        onBlur={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) window.pixelsky?.terminal.focused(false)
        }}
        className="terminal-xterm min-h-0 flex-1 font-mono text-list"
      />
      {away && (
        <button
          onClick={() => screens.get(record.id)?.bottom()}
          className="absolute right-5 bottom-4 rounded-md border border-line bg-popover px-3 py-1 text-meta text-fg shadow-sm"
        >
          {t('terminal.bottom')}
        </button>
      )}
      {menu && (
        <div
          role="menu"
          className="fixed z-[95] w-44 rounded-md border border-line-card bg-popover p-1 text-list text-fg shadow-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={e => e.stopPropagation()}
        >
          <button
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left hover:bg-hover"
            onClick={() => {
              void screens.get(record.id)?.copy().catch(terminalError)
              setMenu(null)
            }}
          >
            {t('terminal.copy')}
          </button>
          <button
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left hover:bg-hover"
            onClick={() => {
              void (isDemo ? navigator.clipboard.readText() : window.pixelsky!.terminal.clipboardRead())
                .then(text => onPaste(record.id, text))
                .catch(terminalError)
              setMenu(null)
            }}
          >
            {t('terminal.paste')}
          </button>
          <button
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left hover:bg-hover"
            onClick={() => {
              onFind()
              setMenu(null)
            }}
          >
            {t('terminal.search')}
          </button>
        </div>
      )}
    </div>
  )
}
