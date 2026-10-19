import type {
  MainWindowAction,
  SettingsHints,
  SettingsTarget,
  SettingsWindowState,
  SettingsWorkspace,
} from '../shared/types/settings-window'

/** 设置独立窗口（docs/ui/settings-window.md）：开 / 收回 / 置顶都在主进程，两种窗口都能用 */
export interface SettingsWindowBridge {
  /** 打开设置窗口（已开着就提到前面）；section 是分区，row 是要高亮的那一行（当前界面语言的标题），hints 是主窗口里先记下、设置页要取走的请求。同时记住「下次用窗口打开」 */
  open(section?: string, row?: string, hints?: SettingsHints): Promise<void>
  /** 收回：关掉设置窗口，主窗口打开浮层，并记住「下次用浮层打开」。只有设置窗口能调 */
  dock(section?: string): Promise<void>
  /** 置顶开关（作为主窗口的子窗口）。只有设置窗口能调 */
  setPinned(on: boolean): Promise<void>
  state(): Promise<SettingsWindowState>
  /** 主窗口报告当前工作区，转给设置窗口（插件页要用） */
  reportWorkspace(workspace: SettingsWorkspace | null): void
  /** 请主窗口做事（并把它提到前面）。只有设置窗口能调 */
  runInMain(action: MainWindowAction): Promise<void>
  /** 状态变了（开 / 关、置顶、记住的打开方式、主窗口工作区） */
  onChange(callback: (state: SettingsWindowState) => void): () => void
  /** 设置窗口：别处又要打开设置了，跳到这个分区和行 */
  onNavigate(callback: (target: SettingsTarget) => void): () => void
  /** 主窗口：设置窗口点了「收回」，打开浮层 */
  onOpenDialog(callback: (target: SettingsTarget) => void): () => void
  /** 主窗口：设置窗口请你做的事 */
  onMainAction(callback: (action: MainWindowAction) => void): () => void
}
