import { useEffect, useLayoutEffect, useState } from 'react'
import { useI18n } from '@/i18n/I18nProvider'
import { tr } from '@/i18n/core'
import { CollapsibleSlot, ResizeHandle, cn } from '@/ui'
import { MachineStatus } from '@/features/machines/MachineStatus'
import { usePage } from '@/features/layout/page'
import { UpdateNotice } from '@/features/update/UpdateNotice'
import { useEnterCodingMode } from './enter'
import { useCodingRouting } from './routing'
import { PANEL_LIMITS, STRIPE_WIDTH, fitCoding } from './layoutModel'
import { codingLayout, reportCodingFit, useCodingLayout, useKeepLeft } from './layoutStore'
import { CodingTopBar } from './shell/CodingTopBar'
import { ToolStripe } from './shell/ToolStripe'
import { LeftArea } from './shell/LeftArea'
import { CenterArea } from './shell/CenterArea'
import { PageOverlay } from './shell/PageOverlay'
import { StatusBar } from './shell/StatusBar'
import { RightArea } from './right'
import { resolveRightView } from './right/viewModel'

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = (): void => {
      setSize(prev =>
        prev.width === window.innerWidth && prev.height === window.innerHeight
          ? prev
          : { width: window.innerWidth, height: window.innerHeight },
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

/** 代码模式的整窗布局：顶栏 / 两条工具条夹着三栏 / 状态栏（docs/ui/coding-mode-impl.md §5 W1-A） */
export function CodingLayout() {
  useI18n()
  useEnterCodingMode()
  useCodingRouting()
  const prefs = useCodingLayout()
  const viewport = useViewport()
  const onWorkbench = usePage() === 'workbench'
  const keepLeft = useKeepLeft()
  const fit = fitCoding(prefs, viewport, { keepLeft })
  useLayoutEffect(() => {
    reportCodingFit(fit)
  })
  return (
    <div data-coding-layout className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-app text-fg">
      {/* 胶囊右边对齐左栏（活动栏 + 左栏）右边减 8，和对话模式侧栏里一样 */}
      <CodingTopBar leftEdge={fit.left.shown ? STRIPE_WIDTH + fit.left.size : 0} />
      <MachineStatus />
      <div className="relative flex min-h-0 flex-1">
        <ToolStripe side="left" />
        {/* 看板 / 频道盖住时三栏保持挂载，只加 inert（D14） */}
        <div className="flex min-h-0 min-w-0 flex-1" inert={!onWorkbench}>
          <div data-vt-code-left className="relative flex min-h-0 shrink-0">
            <CollapsibleSlot open={fit.left.shown} width={fit.left.size} side="left">
              <div className="flex h-full min-w-0 flex-1 border-r border-line-layout">
                <LeftArea view={prefs.left.view} visible={fit.left.shown} />
              </div>
            </CollapsibleSlot>
            {fit.left.shown && (
              <ResizeHandle
                label={tr('coding.shell.resizeLeft')}
                axis="x"
                className="top-0 bottom-0 -right-1"
                value={fit.left.size}
                min={PANEL_LIMITS.left.min}
                max={PANEL_LIMITS.left.max}
                onChange={v => codingLayout.setSize('left', v)}
                onCommit={v => codingLayout.setSize('left', v, true)}
                onReset={() => codingLayout.resetSize('left')}
              />
            )}
          </div>
          <CenterArea fit={fit} viewportHeight={viewport.height} />
          <div className="relative flex min-h-0 shrink-0">
            {fit.right.shown && (
              <ResizeHandle
                label={tr('coding.shell.resizeRight')}
                axis="x"
                scale={-1}
                className="top-0 bottom-0 -left-1"
                value={fit.right.size}
                min={PANEL_LIMITS.right.min}
                max={PANEL_LIMITS.right.max}
                onChange={v => codingLayout.setSize('right', v)}
                onCommit={v => codingLayout.setSize('right', v, true)}
                onReset={() => codingLayout.resetSize('right')}
              />
            )}
            <CollapsibleSlot open={fit.right.shown} width={fit.right.size} side="right">
              <div
                data-coding-right
                className={cn(
                  'flex h-full min-w-0 flex-1 border-l bg-sidebar',
                  // 对话和编辑器之间用实线分开，别看成编辑器的延伸
                  resolveRightView(prefs.right.view) === 'chat' ? 'border-line' : 'border-line-layout',
                )}
              >
                <RightArea visible={fit.right.shown} view={prefs.right.view} />
              </div>
            </CollapsibleSlot>
          </div>
        </div>
        <ToolStripe side="right" />
        <PageOverlay />
        <UpdateNotice placement="floating" />
      </div>
      <StatusBar />
    </div>
  )
}
