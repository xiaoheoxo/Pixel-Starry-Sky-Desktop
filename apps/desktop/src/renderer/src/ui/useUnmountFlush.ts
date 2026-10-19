import { useEffect, useRef } from 'react'

/**
 * 失焦才保存的输入框：改了还没失焦就被卸载（关掉设置、切走分区、换页）时补一次保存。
 * 元素被移除时 Chromium 不一定发 blur，React 也收不到。返回的标记在改动时设 true、失焦保存后设 false；
 * 卸载时还是 true 才补存，不会和失焦那次重复
 */
export function useUnmountFlush(flush: () => void): { current: boolean } {
  const latest = useRef(flush)
  latest.current = flush
  const pending = useRef(false)
  useEffect(
    () => () => {
      if (!pending.current) return
      pending.current = false
      latest.current()
    },
    [],
  )
  return pending
}
