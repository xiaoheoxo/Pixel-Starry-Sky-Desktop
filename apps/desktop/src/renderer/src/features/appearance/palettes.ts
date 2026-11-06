// 老的配色 id。除了暖灰，这些配色都改成了预装扩展（extensions/builtin），这份名单只用来读老数据：
// 「我的主题」的 base、pixelsky.palette 里存着的值。没有副作用，测试能直接导入
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
