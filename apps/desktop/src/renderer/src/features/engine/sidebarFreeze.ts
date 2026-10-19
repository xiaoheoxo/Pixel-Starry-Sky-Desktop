// 侧栏排序冻结：鼠标在侧栏里（或正在拖东西）时，会话不因为「最近活动」自动换位置，免得点的时候脚下的行被换走。
// 只冻结按最近活动排的那把钥匙（captureRecency / freezeRecency，sidebarData.ts）；新建、删除、置顶、置底等用户操作照旧立即生效。
import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import { getEngineState } from './store'
import { captureRecency, type RecencyFreeze } from './sidebarData'
import { IDLE, freezeReducer, isFrozen, type FreezeEvent, type FreezeState } from './freezeState'

let frozen: RecencyFreeze | null = null
let state: FreezeState = IDLE
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach(fn => fn())

/** 喂一个事件：状态机算出该不该冻结，变了才抓快照 / 清快照 */
function dispatch(event: FreezeEvent): void {
  state = freezeReducer(state, event)
  if (isFrozen(state) === !!frozen) return
  frozen = isFrozen(state) ? captureRecency(getEngineState().sessions) : null
  emit()
}

/** 当前的冻结快照；没冻结是 null */
export function useSidebarFreeze(): RecencyFreeze | null {
  return useSyncExternalStore(
    cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => frozen,
  )
}

/**
 * 挂在侧栏根元素上，用原生 DOM 事件（不用 React 的 onPointerEnter / Leave：React 按组件树算进出，
 * 右键菜单、状态卡片这些 portal 到 body 的东西也算「在侧栏里」，菜单在指针下面被移除时收不到 leave，会一直冻着）：
 * - pointerenter / pointermove 冻结，pointerleave 解冻（pointermove 用来在窗口重新获得焦点、拖动结束后补上冻结）
 * - 从侧栏里开始的拖动（dragstart）一直冻到 dragend / drop；拖着的时候浏览器补发的 pointerleave 不解冻
 * - 窗口失焦、指针离开窗口：全部清掉，不会一直冻着
 */
export function useSidebarFreezeOn(root: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const enter = (): void => dispatch('enter')
    const leave = (): void => dispatch('leave')
    const dragStart = (): void => dispatch('dragstart')
    const dragEnd = (): void => dispatch('dragend')
    const reset = (): void => dispatch('reset')
    const html = document.documentElement
    el.addEventListener('pointerenter', enter)
    el.addEventListener('pointermove', enter)
    el.addEventListener('pointerleave', leave)
    el.addEventListener('dragstart', dragStart)
    // 拖动的源元素被移走时 dragend 到不了 document，所以 drop 也算结束；capture 免得被中途 stopPropagation
    document.addEventListener('dragend', dragEnd, true)
    document.addEventListener('drop', dragEnd, true)
    window.addEventListener('blur', reset)
    html.addEventListener('mouseleave', reset)
    return () => {
      el.removeEventListener('pointerenter', enter)
      el.removeEventListener('pointermove', enter)
      el.removeEventListener('pointerleave', leave)
      el.removeEventListener('dragstart', dragStart)
      document.removeEventListener('dragend', dragEnd, true)
      document.removeEventListener('drop', dragEnd, true)
      window.removeEventListener('blur', reset)
      html.removeEventListener('mouseleave', reset)
      reset()
    }
  }, [root])
}
