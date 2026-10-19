// 运行中只留一处「在动」：底部状态行（LiveStatusLine）显示时它独占转圈和计时，
// 对话里还在跑的行（工具调用、改文件、思考、子智能体小框）保留文字和内容，但不再脉冲、不再闪光、不再自己计时
import { createContext, useContext } from 'react'

/** 状态行显示时为 true，由 LiveTranscript 提供；默认 false（侧边对话、手机预览等没有状态行的地方照旧） */
export const LiveOwnerContext = createContext(false)

export const useLiveOwned = (): boolean => useContext(LiveOwnerContext)

export interface RowLook {
  /** 行首的橙点脉冲 */
  pulse: boolean
  /** 动作文字上流过的光 */
  shimmer: boolean
  /** 行尾自己的用时 */
  clock: boolean
}

/** 一行还在跑时的样子；结束的行不受影响（都是 false） */
export function rowLook(running: boolean, owned: boolean): RowLook {
  const own = running && !owned
  return { pulse: own, shimmer: own, clock: own }
}
