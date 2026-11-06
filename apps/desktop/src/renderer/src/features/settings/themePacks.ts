import type { ExtPackInfo, ExtPackState } from '@pixelsky/protocol'
import { extThemeId } from '@/features/appearance/customThemeCore'
import { contributionsFrom } from '@/features/extpacks/model'

// 主题卡片要卸载时找到它所在的扩展。预装的文件在安装目录里删不掉：「卸载」是停用，能恢复（docs/ui/ui-themes-extension.md §9）

export function packOfTheme(state: ExtPackState, themeId: string): ExtPackInfo | undefined {
  return contributionsFrom(state, 'uiThemes').find(r => extThemeId(r.pack.id ?? r.pack.key, r.item.id) === themeId)
    ?.pack
}

/** 被卸载（停用）的预装主题：列在主题下面，点一下恢复 */
export const uninstalledPresets = (state: ExtPackState): ExtPackInfo[] =>
  state.packs.filter(p => p.source === 'builtin' && !p.enabled && !!p.manifest?.contributes.uiThemes?.length)
