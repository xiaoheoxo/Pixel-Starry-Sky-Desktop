// 循环动画对齐同一个时钟（docs/ui/motion-proposal.html ①③）：几个会话同时在跑时，转圈和闪烁的点原来各自从
// 挂载那一刻开始，节奏各不相同；列表里的行换位置时 DOM 节点被移动，CSS 动画也会从头开始。
// 这里每个 spin / pulse 动画一开始就把起点对齐到文档时间轴的 0，周期相同的就同相；
// 窗口回到前台（暂停过的动画接着动，起点已经偏了）时再整体对齐一次。
// 改 startTime 不影响 animation-play-state 的暂停和 animation: none（Chromium 实测）。

/** 要对齐的 @keyframes：Tailwind 的 animate-spin / animate-pulse */
export const SYNCED_LOOPS: ReadonlySet<string> = new Set(['spin', 'pulse'])

const loopName = (animation: Animation): string | null =>
  'animationName' in animation && typeof animation.animationName === 'string' ? animation.animationName : null

/** 把一个动画的起点对齐到时间轴 0；暂停中的不动（恢复时整体再对齐）。返回是否改了 */
export function alignLoop(animation: Animation): boolean {
  const name = loopName(animation)
  if (!name || !SYNCED_LOOPS.has(name)) return false
  if (animation.playState !== 'running' || animation.startTime === 0) return false
  animation.startTime = 0
  return true
}

/** 页面上所有要对齐的动画一起对齐 */
export function alignAllLoops(doc: Pick<Document, 'getAnimations'> = document): void {
  for (const animation of doc.getAnimations()) alignLoop(animation)
}

export function startLoopClock(doc: Document = document): void {
  // 新出现的、移动后重新开始的、关闭动画后又打开的，都会发 animationstart
  doc.addEventListener(
    'animationstart',
    event => {
      if (!SYNCED_LOOPS.has(event.animationName) || !(event.target instanceof Element)) return
      for (const animation of event.target.getAnimations()) alignLoop(animation)
    },
    true,
  )
  // 窗口回到前台：windowActivity 去掉 data-window-idle，暂停过的动画接着动
  const root = doc.documentElement
  new MutationObserver(() => {
    if (!('windowIdle' in root.dataset)) alignAllLoops(doc)
  }).observe(root, { attributes: true, attributeFilter: ['data-window-idle'] })
}
