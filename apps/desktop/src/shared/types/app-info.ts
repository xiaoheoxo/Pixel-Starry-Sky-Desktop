// 「关于」页用的应用信息：主进程提供，规格见 docs/ui/settings.md §5

// 「关于」页用的应用信息：主进程提供，规格见 docs/ui/settings.md §5

export interface AppInfo {
  /** 显示名：像素星空 */
  name: string
  /** 英文名：Pixel Starry Sky */
  englishName: string
  version: string
  /** 运行方式：开发模式 / 便携版 / 安装版 */
  channel: 'dev' | 'portable' | 'installed'
  electron: string
  chrome: string
  node: string
  v8: string
  /** 例如「Windows 10.0.28000」 */
  os: string
  arch: string
  /** 账号认证服务地址 */
  authUrl: string
  /** 本地数据目录（设置、登录信息） */
  dataDir: string
  /** 代码仓库地址 */
  repoUrl: string
}
/** 只能打开主进程认可的几个位置，不接受任意路径或网址；releases 是 GitHub 上的完整更新日志 */
export type AppLink = 'data-dir' | 'repo' | 'auth' | 'register' | 'releases' | 'issues'

/** 更新后要弹的「更新内容」（GitHub #13）：previous 是上次运行的版本，从还没有这个功能的旧版本升上来时不知道，为 null */
export interface WhatsNew {
  version: string
  previous: string | null
}

export interface WhatsNewState {
  /** 这次启动要弹；不用弹时为 null */
  pending: WhatsNew | null
  /** 「不再提示」 */
  muted: boolean
}
