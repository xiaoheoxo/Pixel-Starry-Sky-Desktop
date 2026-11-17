// 运行中图标的帧条（docs/ui/multi-pane.md §7.2）：原来 4 个方块 + 4 个橙色领头层各跑一个透明度动画，一个图标 8 个合成层，
// 分屏过渡时每帧都要整体重排。这里照原来的关键帧把每一刻的样子预先算成两条遮罩（灰色、领头），
// 图标里两层只挪遮罩位置（globals.css .pixel-spinner），不进合成层，外观和原来一样（样稿 docs/ui/pixel-spinner-keep.html）。

/** 每圈几帧：省电档 48（每秒挪 40 次），流畅档 100 */
/** 帧与帧之间空出的透明像素：显示缩放不是整数倍（125%、150%）时，挪到半个设备像素上也不会把旁边一帧的方格边透进来 */
export const STRIP_GUTTER = 2
export const STRIP_FRAMES = { save: 48, smooth: 100 } as const

type Keyframes = readonly (readonly [offset: number, value: number])[]

/** 方块的亮度（原 @keyframes pixel-flow） */
const FLOW: Keyframes = [
  [0, 1],
  [0.1, 0.78],
  [0.25, 0.5],
  [0.4, 0.28],
  [0.55, 0.18],
  [0.85, 0.18],
  [0.92, 0.45],
  [1, 1],
]
/** 橙色领头的亮度（原 @keyframes pixel-flow-lead） */
const LEAD: Keyframes = [
  [0, 1],
  [0.12, 0.6],
  [0.22, 0.2],
  [0.3, 0],
  [0.85, 0],
  [0.93, 0.35],
  [1, 1],
]
/** 方格按 grid 顺序：左上、右上、左下、右下；相位差 1/4 圈，亮度顺时针流（左上 → 右上 → 右下 → 左下） */
const PHASE = [0, 0.75, 0.25, 0.5] as const

/** 关键帧在 p（0–1 圈）处的值；stepped：每段折线跳 3 步（原省电档的 steps(3, end)），否则线性 */
export function sample(kf: Keyframes, p: number, stepped: boolean): number {
  const t = ((p % 1) + 1) % 1
  for (let i = 0; i < kf.length - 1; i++) {
    const [a, va] = kf[i],
      [b, vb] = kf[i + 1]
    if (t >= a && t < b) {
      let u = (t - a) / (b - a)
      if (stepped) u = Math.floor(u * 3 + 1e-9) / 3
      return va + (vb - va) * u
    }
  }
  return kf[kf.length - 1][1]
}

/**
 * 原来的画法：方块透明度 a，里面盖一层领头透明度 b（领头也跟着方块一起变淡）。
 * 拆成上下两层：领头层 a·b、灰色层 a(1-b)/(1-ab)，叠出来和原来一样。返回 [灰, 领头]
 */
export function splitAlpha(a: number, b: number): [gray: number, lead: number] {
  const lead = a * b
  return [lead >= 0.9999 ? 0 : (a * (1 - b)) / (1 - lead), lead]
}

/** 动画关时停的那一拍：左上领头、左下半亮（同原来 data-motion=off 的样子） */
const STILL = [
  [1, 1],
  [0.18, 0],
  [0.55, 0],
  [0.18, 0],
].map(([a, b]) => splitAlpha(a, b))

/** 第 k 帧（共 n 帧）4 块方格的 [灰, 领头]；取这一帧时间段的中点，k === n 是动画关时停的那一拍 */
export function frame(k: number, n: number, stepped: boolean): [number, number][] {
  if (k >= n) return STILL
  const p = (k + 0.5) / n
  return PHASE.map(ph => splitAlpha(sample(FLOW, p + ph, stepped), sample(LEAD, p + ph, stepped)))
}

/**
 * 一条遮罩（SVG data URI）：n + 1 帧横排，每帧 (2c+1)px 见方、4 块 c px 的方格（间隔 1px、圆角 1px），帧距再加 STRIP_GUTTER，
 * 透明度是这一帧的灰色或领头亮度
 */
export function stripMask(cell: number, n: number, stepped: boolean, layer: 'gray' | 'lead'): string {
  const w = cell * 2 + 1,
    pitch = w + STRIP_GUTTER,
    at = [
      [0, 0],
      [cell + 1, 0],
      [0, cell + 1],
      [cell + 1, cell + 1],
    ]
  const which = layer === 'gray' ? 0 : 1
  let rects = ''
  for (let k = 0; k <= n; k++) {
    frame(k, n, stepped).forEach((alpha, i) => {
      const v = alpha[which]
      if (v > 0.002)
        rects += `<rect x="${k * pitch + at[i][0]}" y="${at[i][1]}" width="${cell}" height="${cell}" rx="1" fill-opacity="${v.toFixed(3)}"/>`
    })
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${(n + 1) * pitch}" height="${w}">${rects}</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

/** 某个方格边长的遮罩规则（两档 × 灰 / 领头）；方格边长只有几种，用到时生成一次 */
export function stripRules(cell: number): string {
  const rule = (scope: string, tier: 'save' | 'smooth') =>
    `${scope}.pixel-spinner[data-cell='${cell}']{--pixel-gray:${stripMask(cell, STRIP_FRAMES[tier], tier === 'save', 'gray')};` +
    `--pixel-lead:${stripMask(cell, STRIP_FRAMES[tier], tier === 'save', 'lead')}}`
  return rule('', 'save') + rule(":root[data-perf='smooth'] ", 'smooth')
}

const injected = new Set<number>()

/** 页面上还没有这个边长的遮罩时插一条样式 */
export function ensureStrip(cell: number): void {
  if (injected.has(cell) || typeof document === 'undefined') return
  injected.add(cell)
  const style = document.createElement('style')
  style.dataset.pixelStrip = String(cell)
  style.textContent = stripRules(cell)
  document.head.append(style)
}
