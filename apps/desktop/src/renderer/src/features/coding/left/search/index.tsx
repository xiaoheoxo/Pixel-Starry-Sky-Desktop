import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { Segmented, Spinner, cn } from '@/ui'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { openFile } from '@/features/files/store'
import { FileIcon } from '@/features/files/icons/FileIcon'
import { displayPath } from '@/features/files/extraFolders'
import { demoFileHits, searchFiles, type FileHits } from '@/features/search/fileSearch'
import { useCodingWorkspace } from '../../workspace'
import { PanelHeader } from '../../shell/PanelHeader'
import { filterHits, groupHits, type SearchScope } from '../files/filesModel'

/** 左栏「搜索」：文件名 / 内容两种范围，防抖 200ms，结果按文件分组 */
export function SearchView({ visible }: { visible: boolean }) {
  useI18n()
  const { ref, key } = useCodingWorkspace()
  const [text, setText] = useState('')
  const [scope, setScope] = useState<SearchScope>('name')
  // 结果记下是哪个项目搜的：换项目后旧结果不再显示（点开会拿新项目去开旧项目的路径）
  const [found, setFound] = useState<{ key: string; hits: FileHits } | null>(null)
  const result = found && found.key === key ? found.hits : null
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (visible) input.current?.focus()
  }, [visible])
  useEffect(() => {
    let cancelled = false
    setError('')
    const needle = text.trim()
    if (!needle || !ref) {
      setFound(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      const run = isDemo
        ? Promise.resolve(demoFileHits(ref, demo().files.contents, needle, 'full'))
        : searchFiles(ref, needle, 'full')
      void run.then(
        r => {
          if (cancelled) return
          setFound({ key, hits: r })
          setSearching(false)
        },
        (e: Error) => {
          if (cancelled) return
          setFound(null)
          setError(e.message)
          setSearching(false)
        },
      )
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // key 是 ref 序列化后的值，只在文字或项目变化时重新搜
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, key])
  const groups = useMemo(() => groupHits(filterHits(result?.hits ?? [], scope)), [result, scope])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={tr('coding.files.openSearch')} />
      <label className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
        <Search size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
        <input
          ref={input}
          value={text}
          aria-label={tr('coding.files.search.placeholder')}
          placeholder={tr('coding.files.search.placeholder')}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && text) {
              e.preventDefault()
              setText('')
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-meta text-fg outline-none"
        />
        {text ? (
          <button
            type="button"
            aria-label={tr('coding.files.search.clear')}
            onClick={() => {
              setText('')
              input.current?.focus()
            }}
            className="press flex shrink-0 text-fg-muted hover:text-fg"
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        ) : null}
      </label>
      <div className="mx-2 mb-2 shrink-0">
        <Segmented<SearchScope>
          label={tr('coding.files.search.scope')}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'name', label: tr('coding.files.search.scopeName') },
            { value: 'content', label: tr('coding.files.search.scopeContent') },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {searching ? (
          <p className="flex items-center gap-2 px-4 py-2 text-meta text-fg-muted">
            <Spinner size={12} />
            {tr('coding.files.search.searching')}
          </p>
        ) : null}
        {error ? (
          <p role="status" className="px-4 py-2 text-meta text-danger">
            {tr('coding.files.search.failed', { message: translateMessage(error) })}
          </p>
        ) : null}
        {!text.trim() ? (
          <p className="px-4 py-6 text-meta text-fg-muted">{tr('coding.files.search.empty')}</p>
        ) : result && !searching && !error && groups.length === 0 ? (
          <p className="px-4 py-6 text-meta text-fg-muted">{tr('coding.files.search.noMatch')}</p>
        ) : null}
        {ref
          ? groups.map(g => (
              <section key={g.path} className="px-2 pb-1">
                <button
                  type="button"
                  title={displayPath(ref, g.path)}
                  onClick={scope === 'name' ? () => void openFile(ref, g.path) : undefined}
                  className={cn(
                    'flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-meta text-fg-secondary',
                    scope === 'name' ? 'press hover:bg-hover' : 'cursor-default',
                  )}
                >
                  <FileIcon name={g.name} kind="file" size={14} />
                  <span className="min-w-0 truncate text-fg">{g.name}</span>
                  {g.dir ? (
                    <span className="min-w-0 truncate text-label text-fg-faint">{displayPath(ref, g.dir)}</span>
                  ) : null}
                </button>
                {scope === 'content'
                  ? g.hits.map(h => (
                      <button
                        key={h.key}
                        type="button"
                        onClick={() => void openFile(ref, h.path, h.line ?? undefined, h.column ?? 1)}
                        className="press flex min-h-6 w-full min-w-0 items-baseline gap-2 rounded-md py-0.5 pr-2 pl-7 text-left text-label hover:bg-hover"
                      >
                        <span className="shrink-0 text-fg-faint tabular-nums">{h.line}</span>
                        <span className="min-w-0 truncate font-mono text-fg-secondary">{h.text.trim()}</span>
                      </button>
                    ))
                  : null}
              </section>
            ))
          : null}
        {result?.truncated ? (
          <p className="px-4 py-1 text-label text-fg-muted">{tr('coding.files.search.truncated')}</p>
        ) : null}
      </div>
    </div>
  )
}
