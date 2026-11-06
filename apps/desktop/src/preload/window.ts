import type { WindowState, WindowSnapLayout } from '../shared/types/window'

/** 仅操作发起调用的应用窗口。 */
export interface WindowBridge {
  getState: () => Promise<WindowState>
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  snap: (layout: WindowSnapLayout, zone: number) => Promise<void>
  snapOptions: () => Promise<Record<WindowSnapLayout, boolean[]>>
  restoreSnap: () => Promise<void>
  close: () => Promise<void>
  onState: (cb: (state: WindowState) => void) => () => void
  /** 这台电脑能透桌面的系统材质，空数组表示不能（docs/ui/glass-effect.md） */
  glassMaterials: () => Promise<string[]>
  /** 打开或关掉系统材质；base 是关掉后恢复的窗口底色 */
  setGlass: (material: string | null, base?: string) => Promise<void>
}
