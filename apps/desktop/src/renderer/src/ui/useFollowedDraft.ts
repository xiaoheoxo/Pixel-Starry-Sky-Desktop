import { useState } from 'react'

/** 草稿还没被改过（等于上一次的原值）时跟着新原值走；改过了就留着用户写的 */
export function followDraft<T>(draft: T, previous: T, next: T): T {
  return Object.is(draft, previous) ? next : draft
}

/**
 * 表单输入框的草稿：原值后来才加载出来、或在别处被改了，用户没动过这一项就跟着显示新值，
 * 不会一直停在打开那一刻的旧值（保存时把旧值写回去）
 */
export function useFollowedDraft<T>(source: T): [T, (value: T) => void] {
  const [draft, setDraft] = useState(source)
  const [seen, setSeen] = useState(source)
  if (!Object.is(seen, source)) {
    setSeen(source)
    setDraft(followDraft(draft, seen, source))
  }
  return [draft, setDraft]
}
