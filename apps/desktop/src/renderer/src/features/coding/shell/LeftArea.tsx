import { useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { cn } from '@/ui'
import { FilesView } from '../left/files'
import { OutlineView } from '../left/outline'
import { SearchView } from '../left/search'
import { GitView } from '../left/git'
import { TasksView } from '../left/tasks'
import { ConversationsView } from '../left/conversations'
import type { LeftView } from '../types'

const VIEWS: Record<LeftView, (props: { visible: boolean }) => React.JSX.Element> = {
  files: FilesView,
  outline: OutlineView,
  search: SearchView,
  git: GitView,
  tasks: TasksView,
  conversations: ConversationsView,
}

/** 左栏：各视图第一次打开后保持挂载，用 hidden + inert 切换（参照 RightPanel 的 visited 写法） */
export function LeftArea({ view, visible }: { view: LeftView; visible: boolean }) {
  useI18n()
  const [visited, setVisited] = useState<ReadonlySet<LeftView>>(() => new Set([view]))
  if (!visited.has(view)) setVisited(new Set([...visited, view]))
  return (
    <div data-coding-left className="flex h-full min-w-0 flex-1 flex-col bg-sidebar">
      {(Object.keys(VIEWS) as LeftView[]).map(key => {
        if (!visited.has(key) && key !== view) return null
        const View = VIEWS[key]
        const active = key === view
        return (
          <div
            key={key}
            data-coding-left-view={key}
            className={cn('min-h-0 flex-1 flex-col', active ? 'flex' : 'hidden')}
            inert={!active}
          >
            <View visible={visible && active} />
          </div>
        )
      })}
    </div>
  )
}
