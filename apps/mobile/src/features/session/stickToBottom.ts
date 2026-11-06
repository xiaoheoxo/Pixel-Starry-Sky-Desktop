// 会话页贴底的判断（桌面端 features/session/live/scrollFollow.ts 同样的规则）
export interface ScrollPos {
  top: number
  height: number
}

/** 刚点过这么久以内，内容变高不跟：多半是点开了什么，不要把它顶上去 */
export const INTERACT_MS = 500

/**
 * 滚动事件之后还跟不跟底部：回到底部附近就跟，用户往上滚了才不跟，其余不变。
 * 不能只看离底多远：刚滚到底、滚动事件还没到时内容又长高了，事件里算出来离底很远，其实用户没动
 */
export function stickAfterScroll(stick: boolean, prev: ScrollPos | null, now: ScrollPos, near: boolean): boolean {
  if (near) return true
  const up = !!prev && now.top < prev.top - 1 && now.height >= prev.height
  return stick && !up
}
