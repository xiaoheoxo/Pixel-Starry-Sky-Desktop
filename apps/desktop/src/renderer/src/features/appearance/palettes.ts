// 配色主题的名单（没有副作用，主题逻辑和测试都能直接导入）
export const PALETTES = [
  'default',
  'midnight',
  'github',
  'solarized',
  'nord',
  'catppuccin',
  'gruvbox',
  'tokyonight',
  'rosepine',
] as const
export type Palette = (typeof PALETTES)[number]
export const DEFAULT_PALETTE: Palette = 'default'
