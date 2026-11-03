import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal, flushSync } from 'react-dom'
import { Search } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { Kbd, cn } from '@/ui'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { OPEN_SEARCH } from '@/features/layout/shortcuts'
import { useCommandPalette } from '@/features/commands/CommandPaletteProvider'
import { useOpenSearch } from '@/features/search/SearchProvider'
import { setSearchShortcutOverride } from '@/features/search/shortcutOverride'
import { demoFileHits, searchFiles, type FileHit } from '@/features/search/fileSearch'
import { openFile } from '@/features/files/store'
import { FileIcon as FileTypeIcon } from '@/features/files/icons/FileIcon'
import { isIgnoredPath, partitionIgnored, useIgnoredSet } from '@/features/files/ignored'
import { useActiveCodeTab } from '../editor'
import { useCodingWorkspace } from '../workspace'
import { SYMBOLS_NOTE, fileSymbols } from '../left/outline/outlineModel'
import { matchSymbols, parseQuery } from './commandCenterModel'

/** 顶栏命令中心：输入框在入口原位展开；挂载时接管 Ctrl+P。 */
export function CommandCenterButton({ compact = false }: { compact?: boolean }) {
  useI18n()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const show = (): void => setOpen(true)
    setSearchShortcutOverride(show)
    return () => setSearchShortcutOverride(null)
  }, [])
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-command-center-button
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-hidden={open || undefined}
        tabIndex={open ? -1 : undefined}
        aria-label={tr('coding.top.cc.open')}
        onClick={() => setOpen(true)}
        className={cn(
          'flex h-7 w-full items-center gap-2 rounded-md border border-line-card bg-subtle px-2 text-list text-fg-muted hover:bg-hover',
          compact && 'justify-center px-0',
          open && 'invisible',
        )}
      >
        <Search size={14} strokeWidth={1.5} className="shrink-0" />
        {!compact && <span className="min-w-0 flex-1 truncate text-left">{tr('coding.top.cc.placeholder')}</span>}
        {!compact && <Kbd>{OPEN_SEARCH.label}</Kbd>}
      </button>
      {open && <CommandCenter anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  )
}

interface FileState {
  hits: FileHit[]
  loading: boolean
  error: boolean
}

function CommandCenter({ anchor, onClose }: { anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  useI18n()
  const [text, setText] = useState('')
  const [selected, setSelected] = useState(0)
  const [files, setFiles] = useState<FileState>({ hits: [], loading: false, error: false })
  const { ref } = useCodingWorkspace()
  const codeTab = useActiveCodeTab()
  // 被 .gitignore 忽略的文件排在后面、变暗
  const ignored = useIgnoredSet(ref)
  const hits = useMemo(() => partitionIgnored(files.hits, h => h.path, ignored), [files.hits, ignored])
  const palette = useCommandPalette()
  const openSearch = useOpenSearch()
  const input = useRef<HTMLInputElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 480 })
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const q = parseQuery(text)
  const term = q.kind === 'file' ? q.term : ''
  // @ 符号：只搜当前编辑器文件
  const symbols = useMemo(() => (q.kind === 'symbol' ? fileSymbols(codeTab) : null), [q.kind, codeTab])
  const symbolHits = useMemo(
    () => (symbols?.kind === 'ready' ? matchSymbols(symbols.items, q.term) : []),
    [symbols, q.term],
  )
  const count = q.kind === 'file' ? hits.length : q.kind === 'symbol' ? symbolHits.length : 0

  useLayoutEffect(() => {
    const button = anchor.current
    if (!button) return
    const place = (): void => {
      const rect = button.getBoundingClientRect()
      // 窄窗口的图标入口展开为可输入的面板，仍以窗口中心对齐。
      const width = rect.width > 32 ? rect.width : Math.min(480, window.innerWidth - 32)
      setPosition({ top: rect.top, left: (window.innerWidth - width) / 2, width })
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(button)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [anchor])

  useEffect(() => {
    input.current?.focus()
    const back = returnFocus.current
    return () => {
      if (back?.isConnected) back.focus({ preventScroll: true })
    }
  }, [])

  // 文件：输入停顿 150ms 后再搜
  useEffect(() => {
    setSelected(0)
    if (!term || !ref) {
      setFiles({ hits: [], loading: false, error: false })
      return
    }
    let gone = false
    setFiles(f => ({ ...f, loading: true, error: false }))
    const timer = window.setTimeout(() => {
      const run = isDemo
        ? Promise.resolve(demoFileHits(ref, demo().files.contents, term, 'brief'))
        : searchFiles(ref, term, 'brief')
      run
        .then(r => {
          if (!gone) setFiles({ hits: r.hits.filter(h => h.line === null), loading: false, error: false })
        })
        .catch(() => {
          if (!gone) setFiles({ hits: [], loading: false, error: true })
        })
    }, 150)
    return () => {
      gone = true
      window.clearTimeout(timer)
    }
  }, [term, ref])

  // 方向键移出可视区时跟着滚（@ 列表不限条数）
  useEffect(() => {
    document.getElementById(`command-center-result-${selected}`)?.scrollIntoView({ block: 'nearest' })
  }, [selected, count])

  const pick = useCallback(
    (hit: FileHit): void => {
      onClose()
      void openFile(hit.ref, hit.path)
    },
    [onClose],
  )
  const jumpTo = (line: number): void => {
    if (!codeTab) return
    onClose()
    void openFile(codeTab.ref, codeTab.path, line)
  }
  const submit = (): void => {
    if (q.kind === 'file') {
      const hit = hits[selected]
      if (hit) pick(hit)
    } else if (q.kind === 'command') {
      // 输入的文字带不过去，命令面板自己从头输入
      flushSync(onClose)
      palette.open()
    } else if (q.kind === 'chat') {
      // openSearch 看到别的 aria-modal 会直接返回，所以先关掉自己，等下一帧再开
      onClose()
      requestAnimationFrame(() => openSearch())
    } else if (q.kind === 'line' && q.line !== null && codeTab) {
      onClose()
      void openFile(codeTab.ref, codeTab.path, q.line)
    } else if (q.kind === 'symbol') {
      const hit = symbolHits[selected]
      if (hit) jumpTo(hit.item.line)
    }
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (count) setSelected(s => (s + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      input.current?.focus()
    }
  }

  let body: ReactNode
  if (q.kind === 'file') {
    if (!term) body = <Note>{tr('coding.top.cc.hint')}</Note>
    else if (!ref) body = <Note>{tr('coding.top.cc.noProject')}</Note>
    else if (files.error) body = <Note>{tr('coding.top.cc.failed')}</Note>
    else if (hits.length === 0)
      body = <Note>{tr(files.loading ? 'coding.top.cc.searching' : 'coding.top.cc.noFiles')}</Note>
    else
      body = (
        <ul id="command-center-results" role="listbox" className="max-h-80 overflow-auto p-1">
          {hits.map((hit, i) => {
            const slash = hit.path.lastIndexOf('/')
            const dim = isIgnoredPath(hit.path, ignored)
            return (
              <li
                key={hit.key}
                id={`command-center-result-${i}`}
                role="option"
                aria-selected={i === selected}
                onMouseEnter={() => setSelected(i)}
                onClick={() => pick(hit)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-list text-fg',
                  i === selected && 'bg-accent-soft',
                )}
              >
                <FileTypeIcon name={hit.path.slice(slash + 1)} kind="file" size={14} dim={dim} />
                <span title={hit.path} className={cn('max-w-[70%] min-w-0 shrink-0 truncate', dim && 'text-fg-faint')}>
                  {hit.path.slice(slash + 1)}
                </span>
                {slash > 0 && (
                  <span className="min-w-0 truncate text-meta text-fg-muted">{hit.path.slice(0, slash)}</span>
                )}
                {i === selected && (
                  <span aria-hidden className="ml-auto shrink-0 pl-2 text-meta text-fg-faint">
                    {tr('coding.top.cc.enterOpen')}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )
  } else if (q.kind === 'command') body = <Note>{tr('coding.top.cc.commandHint')}</Note>
  else if (q.kind === 'chat') body = <Note>{tr('coding.top.cc.chatHint')}</Note>
  else if (q.kind === 'symbol') {
    if (!symbols || symbols.kind === 'noFile') body = <Note>{tr('coding.top.cc.symbolNoFile')}</Note>
    else if (symbols.kind !== 'ready') body = <Note>{tr(SYMBOLS_NOTE[symbols.kind])}</Note>
    else if (!symbolHits.length) body = <Note>{tr('coding.top.cc.noSymbols')}</Note>
    else
      body = (
        <>
          <ul id="command-center-results" role="listbox" className="max-h-80 overflow-auto p-1">
            {symbolHits.map(({ item, at }, i) => (
              <li
                key={item.from}
                id={`command-center-result-${i}`}
                role="option"
                aria-selected={i === selected}
                onMouseEnter={() => setSelected(i)}
                onClick={() => jumpTo(item.line)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-list text-fg',
                  i === selected && 'bg-accent-soft',
                )}
              >
                <span aria-hidden className="w-3 shrink-0 text-center font-mono text-accent">
                  {item.kind === 'class' ? 'C' : 'ƒ'}
                </span>
                <span className="min-w-0 truncate">
                  {item.name.slice(0, at)}
                  {q.term ? (
                    <mark className="rounded-sm bg-warn/25 px-px text-inherit">
                      {item.name.slice(at, at + q.term.length)}
                    </mark>
                  ) : null}
                  {item.name.slice(at + q.term.length)}
                </span>
                <span className="ml-auto shrink-0 pl-2 text-meta text-fg-faint tabular-nums">
                  {tr('coding.top.cc.symbolLine', { p0: item.line })}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-line-subtle px-3 py-1.5 text-label text-fg-faint">
            {tr('coding.top.cc.symbolFooter')}
          </p>
        </>
      )
  } else if (q.line === null) body = <Note>{tr('coding.top.cc.lineBad')}</Note>
  else if (!codeTab) body = <Note>{tr('coding.top.cc.lineNoFile')}</Note>
  else body = <Note>{tr('coding.top.cc.lineGo', { p0: q.line })}</Note>

  return createPortal(
    <div className="no-drag fixed inset-0 z-50" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tr('coding.top.cc.open')}
        data-command-center
        onMouseDown={e => e.stopPropagation()}
        style={{
          top: position.top,
          left: position.left,
          width: position.width,
          maxHeight: `calc(100dvh - ${position.top + 16}px)`,
        }}
        className="absolute flex flex-col overflow-hidden rounded-md border border-line-card bg-popover shadow-menu"
      >
        <div
          data-command-center-field
          className="flex h-[26px] shrink-0 items-center gap-2 rounded-t-[5px] bg-subtle px-[7px] outline -outline-offset-1 outline-transparent focus-within:outline-accent-line"
        >
          <Search size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
          <input
            ref={input}
            value={text}
            onChange={e => {
              setText(e.target.value)
              setSelected(0)
            }}
            onKeyDown={onKeyDown}
            aria-label={tr('coding.top.cc.input')}
            role="combobox"
            aria-expanded={count > 0}
            aria-controls={count > 0 ? 'command-center-results' : undefined}
            aria-activedescendant={selected < count ? `command-center-result-${selected}` : undefined}
            autoComplete="off"
            placeholder={tr('coding.top.cc.placeholder')}
            className="h-full min-w-0 flex-1 bg-transparent text-list text-fg outline-none placeholder:text-fg-faint"
          />
          <Kbd>{OPEN_SEARCH.label}</Kbd>
        </div>
        <div className="min-h-0 overflow-auto border-t border-line-subtle">{body}</div>
      </div>
    </div>,
    document.body,
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-meta text-fg-muted">{children}</p>
}
