// 防抖：连续调用只在最后一次之后等 ms 毫秒才真正执行，参数取最后一次的。用 setTimeout，测试可以用假时钟

export interface Debounced<A extends unknown[]> {
  (...args: A): void
  /** 丢掉还没执行的那一次（组件卸载时调） */
  cancel(): void
}

export function debounced<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const call = ((...args: A) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }) as Debounced<A>
  call.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return call
}
