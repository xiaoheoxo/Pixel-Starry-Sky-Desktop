import '@xterm/xterm/css/xterm.css'
import { Terminal, type ILink, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { useEffect, useRef, useState } from 'react'
import type { TerminalRecord } from '../../../../shared/types/terminal'
import { consumeTerminal, demoWrite, noteTerminalEnter, setTerminalShown, terminalError, terminalState } from './store'
import { rowsText } from './history'
import { noteTuiInput } from './tuiActivity'
import { screens } from './screens'
import { isDemo } from '@/data'
import { openFile } from '@/features/files/store'
import { findPathMatches } from '@/features/files/pathMatch'
import { terminalFilePath } from './fileLinks'
import { COMMAND_PALETTE, NEW_TERMINAL, TOGGLE_TERMINAL, TOGGLE_TUI_MODE } from '@/features/layout/shortcuts'
import { isMac } from '@/features/layout/keybindings'
import { isCopyKey, isPasteKey, zoomKey } from './copyKey'
import { setTerminalFontSize, terminalPrefs, useTerminalPrefs, zoomedFontSize } from './prefs'
import { quotePath } from './dropPath'
import { FILE_DRAG_TYPE, hasFileDrag, type DragSource } from '@/features/files/treeDrag'
import { splitExtra } from '@/features/files/extraFolderPaths'
import { projectOf } from './projectOf'
import { machineOf } from '@/features/machines/store'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { useToast } from '@/ui'
import { ActionMenu } from '@/ui/ActionMenu'
import { QUOTE_MAX_CHARS, QUOTE_MAX_LINES } from '@/features/session/quote'
import {
  errorQuote,
  failedTail,
  isErrorLine,
  promptCommand,
  quoteCard,
  selectionQuote,
  type LatestEnd,
  type Rows,
} from './errorLines'
import { FixButton, SelectionBar, sendTerminalQuote } from './AskAi'

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

/** 「复制全部输出」最多这么多字（主进程剪贴板通道的上限），超过只留最后这么多 */
const COPY_ALL_MAX = 2_000_000

/** xterm 当前缓冲区按行读（报错行识别用） */
function bufferRows(term: Terminal): Rows {
  const buffer = term.buffer.active
  return {
    length: buffer.length,
    text: row => buffer.getLine(row)?.translateToString(true) ?? '',
    wrapped: row => !!buffer.getLine(row)?.isWrapped,
  }
}
/** 光标所在的提示符行写的命令（折行的接起来）；不从输出流读：PSReadLine 打字时会重画这一行 */
function commandAtCursor(term: Terminal): string | null {
  const rows = bufferRows(term),
    buffer = term.buffer.active,
    cursor = buffer.baseY + buffer.cursorY
  let top = cursor
  while (top > 0 && rows.wrapped(top)) top--
  let text = ''
  for (let row = top; row <= cursor; row++) text += rows.text(row)
  return promptCommand(text.trimEnd()) || null
}
/** 最近结束的那条命令：进程退出了用它的退出码；shell 集成报过、光标已回到提示符行上时用最后一次的退出码 */
function lastEnd(term: Terminal, record: TerminalRecord, rows: Rows): LatestEnd | null {
  const buffer = term.buffer.active,
    cursor = buffer.baseY + buffer.cursorY
  if (record.status === 'exited' && record.exitCode !== undefined) return { row: cursor + 1, code: record.exitCode }
  const marks = terminalState().marks[record.id]
  const code = marks?.generation === record.generation ? (marks.codes.at(-1) ?? null) : null
  return code !== null && promptCommand(rows.text(cursor)) !== null ? { row: cursor, code } : null
}
/** 字符格大小，和屏幕相对外层容器的位置（浮条定位用）；还没画出来时为 null */
function geometry(term: Terminal, el: HTMLElement) {
  const screen = el.querySelector('.xterm-screen'),
    wrap = el.parentElement
  if (!screen || !wrap || !term.cols || !term.rows) return null
  const s = screen.getBoundingClientRect(),
    w = wrap.getBoundingClientRect()
  return {
    screen: s,
    left: s.left - w.left,
    top: s.top - w.top,
    cellW: s.width / term.cols,
    cellH: s.height / term.rows,
  }
}

export function TerminalView({
  record,
  visible,
  onPaste,
  onFind,
  onCycle,
  onAltArrow,
}: {
  record: TerminalRecord
  visible: boolean
  onPaste: (id: string, text: string) => void
  onFind: () => void
  onCycle: (delta: number) => void
  /** Alt+方向键（分屏间切焦点）：处理了返回 true，按键就不发给 Shell */
  onAltArrow?: (key: string) => boolean
}) {
  const { t } = useI18n()
  const toast = useToast()
  const host = useRef<HTMLDivElement>(null),
    instance = useRef<Terminal | null>(null),
    refit = useRef<() => void>(() => {}),
    restyle = useRef<() => void>(() => {})
  const latest = useRef({ record, visible, onPaste, onFind, onCycle, onAltArrow })
  latest.current = { record, visible, onPaste, onFind, onCycle, onAltArrow }
  const [away, setAway] = useState(false),
    [menu, setMenu] = useState<{ x: number; y: number; selection: boolean } | null>(null),
    [bar, setBar] = useState<{ x: number; y: number } | null>(null),
    [fix, setFix] = useState<{ x: number; y: number; row: number } | null>(null)
  /** 鼠标停在缓冲区的哪一行（同一行不重复识别） */
  const hoverRow = useRef(-1)
  useEffect(() => {
    const el = host.current!
    // 回滚行数、读屏支持是本机设置（prefs.ts），下面的 effect 改了马上换
    const prefs = terminalPrefs()
    const term = new Terminal({
      cursorBlink: true,
      scrollback: Number(prefs.scrollback),
      allowProposedApi: false,
      screenReaderMode: prefs.screenReader,
    })
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
      // 用 Ctrl+= / Ctrl+- 调过就用调过的，没调过跟随界面字号
      term.options.fontSize = terminalPrefs().fontSize ?? (parseFloat(style.fontSize) || 13)
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
    restyle.current = applyStyle
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
      else {
        // 括号粘贴（多行粘贴）里的换行只进输入行，不执行
        if (data.includes('\r') && !data.startsWith('\x1b[200~'))
          noteTerminalEnter(now.id, now.generation, commandAtCursor(term))
        if (now.sessionId) noteTuiInput(now.id)
        void window.pixelsky!.terminal.write(now.id, now.generation, data).catch(terminalError)
      }
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
    // 选中文字后选区上方（顶上放不下就放下方）浮出「问 AI · 引用到对话 · 复制」
    const placeBar = (): void => {
      const pos = term.getSelectionPosition(),
        g = geometry(term, el)
      if (!pos || !g || !term.getSelection().trim()) return setBar(null)
      const viewport = term.buffer.active.viewportY,
        above = g.top + (pos.start.y - viewport) * g.cellH - 30
      const y = above >= 0 ? above : g.top + (pos.end.y - viewport + 1) * g.cellH + 4
      setBar({
        x: Math.max(0, Math.min(g.left + pos.start.x * g.cellW, g.left + g.screen.width - 230)),
        y: Math.max(0, Math.min(y, el.clientHeight - 30)),
      })
    }
    // 滚动、改大小后行的位置变了：「交给 AI 修」收起，浮条跟着选区重新放。
    // 屏幕满了以后每来一行输出都会触发 onScroll，所以浮条不能直接收起
    const moved = (): void => {
      hoverRow.current = -1
      setFix(null)
      placeBar()
    }
    const scroll = term.onScroll(() => {
      setAway(term.buffer.active.viewportY < term.buffer.active.baseY)
      moved()
    })
    const resize = term.onResize(moved)
    const selection = term.onSelectionChange(placeBar)
    const paste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text/plain')
      if (text === undefined) return
      event.preventDefault()
      event.stopImmediatePropagation()
      latest.current.onPaste(record.id, text)
    }
    el.addEventListener('paste', paste, true)
    // 把文件拖进来粘贴路径（docs/ui/terminal-small-polish.md §1）：系统里拖来的是绝对路径，文件树拖来的是相对项目的路径
    const dragOver = (event: DragEvent): void => {
      const data = event.dataTransfer
      if (!data || !(hasFileDrag(data) || data.types.includes('Files'))) return
      event.preventDefault()
      event.stopPropagation()
      // 文件树拖动只允许 move，系统文件用 copy
      data.dropEffect = hasFileDrag(data) ? 'move' : 'copy'
    }
    const drop = (event: DragEvent): void => {
      const data = event.dataTransfer
      if (!data || !(hasFileDrag(data) || data.files.length)) return
      event.preventDefault()
      event.stopPropagation()
      const now = latest.current.record
      let paths: string[]
      if (hasFileDrag(data)) {
        const source = JSON.parse(data.getData(FILE_DRAG_TYPE)) as DragSource
        // 别的项目的文件可能在别的机器上，不接；文件树开在会话上时 ref 是会话，按它所属的项目比。
        // 附加文件夹里的（::N/…）不在项目目录下，相对路径对不上，也不接
        if (projectOf(source.ref) !== now.projectId || splitExtra(source.path).index !== null) return
        paths = [source.path]
      } else if (machineOf(now.projectId) !== 'local') {
        terminalError(tr('terminal.dropRemote'))
        return
      } else paths = [...data.files].map(file => window.pixelsky?.pathForFile(file) ?? '').filter(Boolean)
      if (!paths.length) return
      const windows = window.pixelsky?.platform === 'win32'
      latest.current.onPaste(now.id, paths.map(path => quotePath(path, now.profileId, windows)).join(' '))
      term.focus()
    }
    el.addEventListener('dragover', dragOver)
    el.addEventListener('drop', drop)
    const copy = async (): Promise<void> => {
      if (term.hasSelection()) {
        if (isDemo) await navigator.clipboard.writeText(term.getSelection())
        else await window.pixelsky!.terminal.clipboardWrite(term.getSelection())
      }
    }
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true
      // 命令面板、终端的快捷键（可以自定义）交给应用处理，不发给终端
      if (
        COMMAND_PALETTE.match(event) ||
        TOGGLE_TERMINAL.match(event) ||
        NEW_TERMINAL.match(event) ||
        TOGGLE_TUI_MODE.match(event)
      )
        return false
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
      // 分屏时 Alt+方向键在两格之间切（docs/ui/terminal-toolbar-status.md §6）；带 Ctrl / Shift / ⌘ 的、不是分屏方向的照常给 Shell
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.key.startsWith('Arrow') &&
        latest.current.onAltArrow?.(event.key)
      ) {
        event.preventDefault()
        event.stopPropagation()
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
      const zoom = zoomKey(event, isMac)
      if (zoom !== null) {
        event.preventDefault()
        setTerminalFontSize(zoom === 0 ? null : zoomedFontSize(term.options.fontSize ?? 13, zoom))
        return false
      }
      if (isPasteKey(event, isMac)) {
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
        term.clearSelection()
        moved()
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
      setMenu({ x: event.clientX, y: event.clientY, selection: term.hasSelection() })
    }
    el.addEventListener('contextmenu', contextMenu)
    return () => {
      disposed = true
      stop()
      observer.disconnect()
      mutation.disconnect()
      input.dispose()
      scroll.dispose()
      resize.dispose()
      selection.dispose()
      links.dispose()
      el.removeEventListener('paste', paste, true)
      el.removeEventListener('dragover', dragOver)
      el.removeEventListener('drop', drop)
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
    if (!visible) return
    setTerminalShown(record.id, true)
    return () => setTerminalShown(record.id, false)
  }, [visible, record.id])
  const prefs = useTerminalPrefs()
  useEffect(() => {
    const term = instance.current
    if (!term) return
    term.options.scrollback = Number(prefs.scrollback)
    term.options.screenReaderMode = prefs.screenReader
  }, [prefs])
  useEffect(() => {
    if (instance.current) restyle.current()
  }, [prefs.fontSize])
  // 报错行：鼠标停上去时行尾出现「交给 AI 修」
  const hover = (event: React.MouseEvent): void => {
    const term = instance.current,
      el = host.current
    if (!term || !el || (event.target as Element).closest('[data-terminal-float]')) return
    const g = geometry(term, el)
    const view = g ? Math.floor((event.clientY - g.screen.top) / g.cellH) : -1,
      row = term.buffer.active.viewportY + view
    if (row === hoverRow.current) return
    hoverRow.current = row
    if (!g || view < 0 || view >= term.rows) return setFix(null)
    const rows = bufferRows(term),
      text = rows.text(row)
    if (!isErrorLine(text) && failedTail(rows, lastEnd(term, latest.current.record, rows)) !== row) return setFix(null)
    // shortcut: 按字符数算行尾，中文这类双宽字符多的行会偏左；要准再按单元格宽度算
    setFix({
      x: Math.min(g.left + (text.length + 1) * g.cellW, g.left + g.screen.width - 110),
      y: g.top + (view + 0.5) * g.cellH,
      row,
    })
  }
  /** 会话 TUI 终端（这时右栏没有输入框）直接粘进 TUI 自己的输入框，走粘贴那套（多行先确认）；别的放进右栏输入框 */
  const deliver = (card: string, prompt: string | null): string | null => {
    const now = latest.current.record
    if (!now.sessionId) return sendTerminalQuote(card, prompt)
    latest.current.onPaste(now.id, prompt ? `${card}\n${prompt}` : card)
    instance.current?.focus()
    return null
  }
  const fixError = (row: number): void => {
    const term = instance.current
    setFix(null)
    if (!term) return
    const rows = bufferRows(term),
      quote = errorQuote(rows, row, lastEnd(term, latest.current.record, rows))
    const failed = deliver(quoteCard(quote), tr('terminal.ask.fixPrompt'))
    if (failed) toast(failed)
  }
  /** 选中的文字引用到对话；prompt 是「问 AI」顺手填的那句 */
  const quoteSelected = (prompt: string | null): void => {
    const term = instance.current,
      pos = term?.getSelectionPosition()
    if (!term || !pos) return
    const text = term.getSelection()
    // 拖到下一行行首时那一行不算
    const end = pos.end.x === 0 && pos.end.y > pos.start.y ? pos.end.y - 1 : pos.end.y,
      lines = end - pos.start.y + 1
    if (lines > QUOTE_MAX_LINES || text.length > QUOTE_MAX_CHARS) {
      toast(
        tr('terminal.ask.tooLong', { lines, chars: text.length, maxLines: QUOTE_MAX_LINES, maxChars: QUOTE_MAX_CHARS }),
      )
      return
    }
    const rows = bufferRows(term),
      quote = selectionQuote(rows, pos.start.y, end, text, lastEnd(term, latest.current.record, rows))
    const failed = deliver(quoteCard(quote), prompt)
    if (failed) toast(failed)
    else term.clearSelection()
  }
  /** 缓冲区里现在能翻到的全部文字 */
  const allText = (): string => (instance.current ? rowsText(bufferRows(instance.current)) : '')
  const copyAll = async (): Promise<void> => {
    const text = allText(),
      cut = text.length > COPY_ALL_MAX,
      value = cut ? text.slice(-COPY_ALL_MAX) : text
    if (isDemo) await navigator.clipboard.writeText(value)
    else await window.pixelsky!.terminal.clipboardWrite(value)
    toast(cut ? tr('terminal.copiedAllCut', { n: COPY_ALL_MAX }) : t('terminal.copiedAll'))
  }
  const saveOutput = async (): Promise<void> => {
    const saved = await window.pixelsky!.conversationExport.save({ name: record.title, ext: 'txt', content: allText() })
    if (!saved) return
    toast(`${t('terminal.savedOutput')} · ${saved.split(/[\\/]/).pop()}`, {
      duration: 8000,
      action: {
        label: t('export.openFolder'),
        run: () => void window.pixelsky?.editor.revealOutside(saved).catch(() => {}),
      },
    })
  }
  const remote = machineOf(record.projectId) !== 'local'
  return (
    <div
      className={visible ? 'relative flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}
      inert={!visible}
      onMouseMove={hover}
      onMouseLeave={() => {
        hoverRow.current = -1
        setFix(null)
      }}
    >
      <div
        ref={host}
        data-terminal-input={record.id}
        onFocus={() => window.pixelsky?.terminal.focused(true)}
        onBlur={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) window.pixelsky?.terminal.focused(false)
        }}
        className="terminal-xterm min-h-0 flex-1 font-mono text-list"
      />
      {bar && (
        <SelectionBar
          x={bar.x}
          y={bar.y}
          onAsk={() => quoteSelected(tr('terminal.ask.aiPrompt'))}
          onQuote={() => quoteSelected(null)}
          onCopy={() => void screens.get(record.id)?.copy().catch(terminalError)}
        />
      )}
      {fix && <FixButton x={fix.x} y={fix.y} onClick={() => fixError(fix.row)} />}
      {away && (
        <button
          onClick={() => screens.get(record.id)?.bottom()}
          className="absolute right-5 bottom-4 rounded-md border border-line bg-popover px-3 py-1 text-meta text-fg shadow-sm"
        >
          {t('terminal.bottom')}
        </button>
      )}
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          label={t('terminal.more')}
          onClose={() => setMenu(null)}
          actions={[
            {
              label: t('terminal.copy'),
              disabled: !menu.selection,
              run: () => void screens.get(record.id)?.copy().catch(terminalError),
            },
            {
              label: t('terminal.paste'),
              run: () =>
                void (isDemo ? navigator.clipboard.readText() : window.pixelsky!.terminal.clipboardRead())
                  .then(text => onPaste(record.id, text))
                  .catch(terminalError),
            },
            { label: t('terminal.selectAll'), run: () => instance.current?.selectAll() },
            { label: t('terminal.search'), separator: true, run: onFind },
            { label: t('terminal.clear'), run: () => screens.get(record.id)?.clear() },
            { label: t('terminal.copyAll'), separator: true, run: () => void copyAll().catch(terminalError) },
            {
              label: t('terminal.saveOutput'),
              disabled: isDemo,
              title: isDemo ? t('files.store.demoModeCannotSave') : undefined,
              run: () => void saveOutput().catch(terminalError),
            },
            {
              // 只知道启动时的目录（cd 之后的读不到）；远程机器上的目录本机打不开
              label: t('terminal.revealCwd'),
              separator: true,
              disabled: isDemo || remote,
              title: isDemo ? t('path.revealDemo') : remote ? t('path.revealRemote') : record.cwd,
              run: () =>
                void window
                  .pixelsky!.editor.revealOutside(record.cwd)
                  .catch((e: Error) => toast(tr('path.revealFailed', { reason: translateMessage(e.message) }))),
            },
          ]}
        />
      )}
    </div>
  )
}
