import { useRef } from 'react'
import { Eraser, Maximize2, Minimize2, Plus, SquareSplitHorizontal, X } from 'lucide-react'
import { IconButton, cn } from '@/ui'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { useTerminalUi } from '@/features/terminal/TerminalProvider'
import { TabStripArrows } from '@/features/panes/TabStripArrows'
import { useTabStripScroll } from '@/features/panes/tabScroll'
import '@/features/panes/panes.css'
import { codingLayout } from '../layoutStore'
import { PROBLEMS_READY, useProblems } from '../problems'
import type { BottomTab } from '../types'
import { useCodingSessionId, useCodingWorkspace } from '../workspace'
import { ImageSessionContext } from '@/features/session/attachments/imageSource'
import { useAiCommands } from './aiCommands'
import { AiCommandsTab } from './AiCommandsTab'
import { OutputTab } from './OutputTab'
import { PortsTab } from './PortsTab'
import { ProblemsTab } from './ProblemsTab'
import { TerminalTab } from './TerminalTab'
import { usePorts } from './usePorts'

export { revealAiCommand } from './aiCommands'

const TABS: BottomTab[] = (['terminal', 'aiCommands', 'output', 'problems', 'ports'] as const).filter(
  id => id !== 'problems' || PROBLEMS_READY,
)

/** 底部面板：终端 | AI 命令 | 输出 | 问题 | 端口，右边是新建 / 分屏 / 清空 / 最大化 / 关闭 */
export function BottomPanel({
  visible,
  tab: savedTab,
  maximized,
  listCollapsed,
}: {
  visible: boolean
  tab: BottomTab
  maximized: boolean
  listCollapsed: boolean
}) {
  useI18n()
  const ui = useTerminalUi()
  const workspace = useCodingWorkspace()
  const sessionId = useCodingSessionId()
  const commands = useAiCommands(sessionId)
  const problems = useProblems(workspace.ref)
  const ports = usePorts(workspace)
  const counts: Partial<Record<BottomTab, number>> = {
    aiCommands: commands.length,
    problems: problems.errors + problems.warnings,
    ports: ports.length,
  }
  // 问题标签隐藏时，之前存下的 bottom.tab='problems' 兜底显示终端
  const tab: BottomTab = TABS.includes(savedTab) ? savedTab : 'terminal'
  const inTerminal = tab === 'terminal'
  // 面板窄时标签不压扁：横向滚动，当前标签滚进可视区，两头淡出加翻页箭头（和编辑器标签栏一样）
  const strip = useRef<HTMLDivElement>(null)
  useTabStripScroll(strip, tab, TABS)
  return (
    <div data-coding-bottom-panel className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div data-coding-bottom-head className="flex h-9 shrink-0 items-center gap-1 px-2">
        <div className="tab-strip-wrap h-full">
          <div
            ref={strip}
            role="tablist"
            aria-label={tr('coding.bottom.tabs')}
            className="bottom-tab-strip relative flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {TABS.map(id => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`coding-bottom-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`coding-bottom-page-${id}`}
                data-coding-bottom-tab={id}
                onClick={() => codingLayout.showBottom(id)}
                className={cn(
                  'press no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-ui whitespace-nowrap',
                  tab === id ? 'bg-selected text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
                )}
              >
                <span>{tr(`coding.bottom.tab.${id}`)}</span>
                {counts[id] ? (
                  <span className="shrink-0 rounded-full bg-hover px-1.5 text-meta text-fg-muted tabular-nums">
                    {counts[id]}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <TabStripArrows strip={strip} />
        </div>
        <div data-coding-bottom-actions className="no-drag flex shrink-0 items-center gap-0.5">
          <IconButton
            icon={Plus}
            label={tr('coding.bottom.newTerminal')}
            onClick={() => {
              codingLayout.showBottom('terminal')
              void ui.create()
            }}
          />
          {inTerminal && (
            <>
              <IconButton
                icon={SquareSplitHorizontal}
                label={tr('coding.bottom.splitTerminal')}
                disabled={!ui.activeId}
                onClick={() => void ui.splitTo('right')}
              />
              <IconButton
                icon={Eraser}
                label={tr('coding.bottom.clear')}
                disabled={!ui.activeId}
                onClick={() => void ui.request('clear')}
              />
            </>
          )}
          <IconButton
            icon={maximized ? Minimize2 : Maximize2}
            label={tr(maximized ? 'coding.bottom.restore' : 'coding.bottom.maximize')}
            onClick={() => codingLayout.setBottomMaximized(!maximized)}
          />
          <IconButton
            icon={X}
            label={tr('coding.bottom.close')}
            onClick={() => codingLayout.setOpen('bottom', false)}
          />
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <TerminalTab visible={visible && inTerminal} commands={commands} autoCollapsed={listCollapsed} />
        {/* 截过的 AI 命令输出按会话 id 取完整的（session/live/itemBody.ts） */}
        <ImageSessionContext.Provider value={sessionId}>
          {tab === 'aiCommands' && <AiCommandsTab sessionId={sessionId} commands={commands} />}
          {tab === 'output' && <OutputTab workspace={workspace} commands={commands} sessionId={sessionId} />}
        </ImageSessionContext.Provider>
        {tab === 'problems' && <ProblemsTab workspace={workspace} problems={problems} />}
        {tab === 'ports' && <PortsTab workspace={workspace} ports={ports} />}
      </div>
    </div>
  )
}
