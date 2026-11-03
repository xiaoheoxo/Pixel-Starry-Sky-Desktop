import { useMemo } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { cn } from '@/ui'
import { openFile } from '@/features/files/store'
import { useActiveCodeTab } from '../../editor'
import { enclosingDeclaration } from '../../editor/extras/symbolsModel'
import { PanelHeader } from '../../shell/PanelHeader'
import { SYMBOLS_NOTE, fileSymbols } from './outlineModel'

/** 左栏「大纲」：当前编辑器文件的类、函数、方法，按嵌套缩进，光标所在的那个高亮 */
export function OutlineView({ visible }: { visible: boolean }) {
  useI18n()
  const tab = useActiveCodeTab()
  const path = tab?.path ?? ''
  const doc = tab?.document ?? null
  const draft = tab?.draft ?? ''
  const loading = tab?.loading ?? false
  const has = !!tab
  // 藏起来时不扫；依赖只放这几个，光标移动不重扫
  const symbols = useMemo(
    () => (visible ? fileSymbols(has ? { path, document: doc, draft, loading } : null) : null),
    [visible, has, path, doc, draft, loading],
  )
  const items = symbols?.kind === 'ready' ? symbols.items : null
  const line = tab?.cursor.line ?? 0
  const current = useMemo(() => (items ? enclosingDeclaration(items, draft, line) : null), [items, draft, line])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title={
          <>
            {tr('coding.shell.outline')}
            {tab ? <span className="normal-case"> · {tab.name}</span> : null}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {symbols && symbols.kind !== 'ready' ? (
          <p className="px-2 py-6 text-meta text-fg-muted">{tr(SYMBOLS_NOTE[symbols.kind])}</p>
        ) : items && !items.length ? (
          <p className="px-2 py-6 text-meta text-fg-muted">{tr('coding.shell.outline.empty')}</p>
        ) : tab && items ? (
          <ul>
            {items.map(d => (
              <li key={d.from}>
                <button
                  type="button"
                  aria-current={d === current || undefined}
                  onClick={() => void openFile(tab.ref, tab.path, d.line)}
                  style={{ paddingLeft: 8 + d.depth * 14 }}
                  className={cn(
                    'press flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-meta text-fg',
                    d === current ? 'bg-selected' : 'hover:bg-hover',
                  )}
                >
                  <span aria-hidden className="w-3 shrink-0 text-center font-mono text-accent">
                    {d.kind === 'class' ? 'C' : 'ƒ'}
                  </span>
                  <span className="min-w-0 truncate">{d.name}</span>
                  <span className="ml-auto shrink-0 pl-2 text-label text-fg-faint tabular-nums">{d.line}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
