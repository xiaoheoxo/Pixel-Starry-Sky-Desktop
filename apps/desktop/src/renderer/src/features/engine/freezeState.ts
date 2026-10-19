// 侧栏冻结的状态机（纯函数）：指针在侧栏里，或正在拖东西，都要冻结。
// 拖动时浏览器会补发 pointercancel / pointerleave，所以拖着的时候不能靠「指针在不在」判断，要等 dragend / drop。

export interface FreezeState {
  /** 指针在侧栏的 DOM 里（弹出菜单等 portal 不算） */
  inside: boolean
  /** 从侧栏里开始了拖动，还没结束 */
  dragging: boolean
}

export type FreezeEvent = 'enter' | 'leave' | 'dragstart' | 'dragend' | 'reset'

export const IDLE: FreezeState = { inside: false, dragging: false }

export function freezeReducer(state: FreezeState, event: FreezeEvent): FreezeState {
  switch (event) {
    case 'enter':
      return state.inside ? state : { ...state, inside: true }
    case 'leave':
      return state.inside ? { ...state, inside: false } : state
    case 'dragstart':
      return { inside: true, dragging: true }
    case 'dragend':
      // 拖动结束时指针多半还在侧栏里；到底在不在，由之后的 pointermove（enter）/ pointerleave 修正
      return state.dragging ? { ...state, dragging: false } : state
    case 'reset':
      return IDLE
  }
}

export const isFrozen = (state: FreezeState): boolean => state.inside || state.dragging
