// 软件自带的配色只有暖灰（styles/tokens.css 的基础值），其余都是扩展主题（customTheme.ts）。
/** 老版本存选中配色的键：读到老值时迁移成扩展主题，还在同步里，所以键留着 */
export const PALETTE_KEY = 'pixelsky.palette'

/** 窗口底色（缩放窗口、启动时露出来的那一层）跟着配色走：取 tokens.css 里不受壁纸影响的 --wall-tint */
export function windowBackground(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const value = getComputedStyle(document.documentElement).getPropertyValue('--wall-tint').trim()
  return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined
}
