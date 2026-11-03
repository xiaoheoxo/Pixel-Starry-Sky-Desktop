import { useEffect, useMemo, useRef, useState } from 'react'
import { CaseSensitive, ChevronDown, ChevronRight, Regex, ReplaceAll, Search, WholeWord, X } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr, translateMessage } from '@/i18n/core'
import { IconButton, Segmented, Spinner, cn } from '@/ui'
import { ConfirmDialog } from '@/ui/ConfirmDialog'
import { isDemo } from '@/data'
import { demo } from '@/data/demo'
import { openFile } from '@/features/files/store'
import { FileIcon } from '@/features/files/icons/FileIcon'
import { displayPath } from '@/features/files/extraFolders'
import { demoFileHits, searchFiles, type FileHits } from '@/features/search/fileSearch'
import { NO_OPTIONS, previewLine, regexError, searchRegExp, type SearchOptions } from '@/features/search/replaceModel'
import { useCodingWorkspace } from '../../workspace'
import { PanelHeader } from '../../shell/PanelHeader'
import { filterHits, groupHits, type HitGroup, type SearchScope } from '../files/filesModel'
import { applyReplace, planReplace, type ReplacePlan } from './replace'

const TOGGLES = [
  { key: 'caseSensitive', icon: CaseSensitive, label: 'coding.files.search.caseSensitive' },
  { key: 'wholeWord', icon: WholeWord, label: 'coding.files.search.wholeWord' },
  { key: 'regex', icon: Regex, label: 'coding.files.search.regex' },
] as const

const total = (plan: ReplacePlan): number => plan.edits.reduce((n, e) => n + e.count, 0)

/** 左栏「搜索」：文件名 / 内容两种范围，防抖 200ms，结果按文件分组；内容范围可以替换（docs/ui/coding-tier1.md §3） */
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
  const [options, setOptions] = useState<SearchOptions>(NO_OPTIONS)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<ReplacePlan | null>(null)
  const [notice, setNotice] = useState<string[]>([])
  // 替换完加一，重新搜一遍
  const [rerun, setRerun] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  // 三个开关和替换只给内容范围
  const active = scope === 'content' ? options : NO_OPTIONS
  const needle = text.trim()
  const badRegex = needle && active.regex ? regexError(needle, active) : null
  useEffect(() => {
    if (visible) input.current?.focus()
  }, [visible])
  useEffect(() => {
    let cancelled = false
    setError(badRegex ? tr('coding.files.search.badRegex', { message: badRegex }) : '')
    if (!needle || !ref || badRegex) {
      setFound(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      const run = isDemo
        ? Promise.resolve(demoFileHits(ref, demo().files.contents, needle, 'full', active))
        : searchFiles(ref, needle, 'full', active)
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
    // key 是 ref 序列化后的值，只在文字、开关或项目变化时重新搜
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, key, active.caseSensitive, active.wholeWord, active.regex, rerun])
  const groups = useMemo(() => groupHits(filterHits(result?.hits ?? [], scope)), [result, scope])
  const replacing = scope === 'content' && replaceOpen
  const pattern = useMemo(
    () => (replacing && needle && !badRegex ? searchRegExp(needle, active) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [replacing, needle, badRegex, active.caseSensitive, active.wholeWord, active.regex],
  )
  const limited = scope === 'content' ? !!result?.linesTruncated : !!result?.truncated
  const report = (plan: ReplacePlan, done: number | null): string[] => [
    ...(done === null
      ? []
      : [
          done
            ? tr('coding.files.replace.done', { files: plan.edits.length, count: done })
            : tr('coding.files.replace.nothing'),
        ]),
    ...(plan.dirty.length
      ? [
          tr('coding.files.replace.dirty', {
            count: plan.dirty.length,
            paths: plan.dirty.join(tr('coding.files.replace.pathSep')),
          }),
        ]
      : []),
    ...plan.failed.map(f => tr('coding.files.replace.failed', { path: f.path, message: translateMessage(f.message) })),
  ]
  const finishReplace = async (plan: ReplacePlan): Promise<void> => {
    if (!ref) return
    setBusy(true)
    try {
      const done = await applyReplace(ref, plan)
      setNotice(report(done, done.done))
      setRerun(n => n + 1)
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }
  /** 先读好、算好；全部替换先弹确认，单个文件直接写 */
  const startReplace = async (list: HitGroup[], all: boolean): Promise<void> => {
    if (!ref || busy || !needle || badRegex) return
    if (isDemo) return setNotice([tr('coding.files.replace.demo')])
    setBusy(true)
    setNotice([])
    try {
      // 结果被截断时只换显示出来的那些行
      const targets = list.map(g => ({ path: g.path, lines: limited ? new Set(g.hits.map(h => h.line ?? 0)) : null }))
      const plan = await planReplace(ref, targets, needle, active, replacement)
      if (all && plan.edits.length) {
        setNotice(report(plan, null))
        setConfirm(plan)
      } else await finishReplace(plan)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={tr('coding.files.openSearch')} />
      <div className="mx-2 mb-2 flex shrink-0 items-start gap-1">
        {scope === 'content' ? (
          <IconButton
            icon={replaceOpen ? ChevronDown : ChevronRight}
            label={tr('coding.files.search.toggleReplace')}
            aria-expanded={replaceOpen}
            size={20}
            iconSize={14}
            className="mt-1.5"
            onClick={() => setReplaceOpen(o => !o)}
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
            <Search size={14} strokeWidth={1.5} className="shrink-0 text-fg-muted" />
            <input
              ref={input}
              value={text}
              aria-label={tr('coding.files.search.placeholder')}
              placeholder={tr('coding.files.search.placeholder')}
              onChange={e => {
                setText(e.target.value)
                setNotice([])
              }}
              onKeyDown={e => {
                if (e.key === 'Escape' && text && !e.nativeEvent.isComposing) {
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
            {scope === 'content'
              ? TOGGLES.map(t => (
                  <IconButton
                    key={t.key}
                    icon={t.icon}
                    label={tr(t.label)}
                    aria-pressed={options[t.key]}
                    active={options[t.key]}
                    size={20}
                    iconSize={14}
                    onClick={() => setOptions(o => ({ ...o, [t.key]: !o[t.key] }))}
                  />
                ))
              : null}
          </label>
          {replacing ? (
            <label className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-subtle px-2">
              <input
                value={replacement}
                aria-label={tr('coding.files.replace.placeholder')}
                placeholder={tr('coding.files.replace.placeholder')}
                onChange={e => setReplacement(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-meta text-fg outline-none"
              />
              <IconButton
                icon={ReplaceAll}
                label={tr('coding.files.replace.all')}
                size={20}
                iconSize={14}
                disabled={busy || searching || !groups.length || !!badRegex}
                onClick={() => void startReplace(groups, true)}
              />
            </label>
          ) : null}
        </div>
      </div>
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
        {searching || busy ? (
          <p className="flex items-center gap-2 px-4 py-2 text-meta text-fg-muted">
            <Spinner size={12} />
            {tr('coding.files.search.searching')}
          </p>
        ) : null}
        {notice.map(line => (
          <p key={line} role="status" className="px-4 py-1 text-meta text-fg-secondary">
            {line}
          </p>
        ))}
        {error ? (
          <p role="status" className="px-4 py-2 text-meta text-danger">
            {badRegex ? error : tr('coding.files.search.failed', { message: translateMessage(error) })}
          </p>
        ) : null}
        {!needle ? (
          <p className="px-4 py-6 text-meta text-fg-muted">{tr('coding.files.search.empty')}</p>
        ) : result && !searching && !error && groups.length === 0 ? (
          <p className="px-4 py-6 text-meta text-fg-muted">{tr('coding.files.search.noMatch')}</p>
        ) : null}
        {ref
          ? groups.map(g => (
              <section key={g.path} className="px-2 pb-1">
                <div className="flex min-w-0 items-center">
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
                  {replacing ? (
                    <IconButton
                      icon={ReplaceAll}
                      label={tr('coding.files.replace.file')}
                      size={22}
                      iconSize={13}
                      disabled={busy || searching || !!badRegex}
                      onClick={() => void startReplace([g], false)}
                    />
                  ) : null}
                </div>
                {scope === 'content'
                  ? g.hits.map(h => (
                      <button
                        key={h.key}
                        type="button"
                        onClick={() => void openFile(ref, h.path, h.line ?? undefined, h.column ?? 1)}
                        className="press flex min-h-6 w-full min-w-0 items-baseline gap-2 rounded-md py-0.5 pr-2 pl-7 text-left text-label hover:bg-hover"
                      >
                        <span className="shrink-0 text-fg-faint tabular-nums">{h.line}</span>
                        <span className="min-w-0 truncate font-mono text-fg-secondary">
                          {pattern ? (
                            <Preview line={h.text} pattern={pattern} replacement={replacement} regex={active.regex} />
                          ) : (
                            h.text.trim()
                          )}
                        </span>
                      </button>
                    ))
                  : null}
              </section>
            ))
          : null}
        {limited ? (
          <p className="px-4 py-1 text-label text-fg-muted">
            {scope === 'content'
              ? tr('coding.files.search.limited', { count: groups.reduce((n, g) => n + g.hits.length, 0) })
              : tr('coding.files.search.truncated')}
          </p>
        ) : null}
      </div>
      {confirm ? (
        <ConfirmDialog
          title={tr('coding.files.replace.confirmTitle')}
          description={tr('coding.files.replace.confirmBody', {
            files: confirm.edits.length,
            count: total(confirm),
            from: needle,
            to: replacement,
          })}
          confirmLabel={tr('coding.files.replace.confirm', { count: total(confirm) })}
          cancelLabel={tr('coding.files.replace.cancel')}
          busy={busy}
          onConfirm={() => void finishReplace(confirm)}
          onCancel={() => {
            setConfirm(null)
            setNotice([])
          }}
        />
      ) : null}
    </div>
  )
}

/** 一行命中的前后对比：删掉的红色划线，换上的绿色 */
function Preview({
  line,
  pattern,
  replacement,
  regex,
}: {
  line: string
  pattern: RegExp
  replacement: string
  regex: boolean
}) {
  return previewLine(line, pattern, replacement, regex).map((p, i) => (
    <span
      key={i}
      className={cn(
        p.kind === 'del' && 'bg-danger/10 text-danger line-through',
        p.kind === 'ins' && 'bg-success/10 text-success',
      )}
    >
      {i === 0 && p.kind === 'same' ? p.text.trimStart() : p.text}
    </span>
  ))
}
