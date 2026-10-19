// 「关于」页的数据：版本、运行环境、数据目录等。规格见 docs/ui/settings.md §5
import { release } from 'node:os'
import { app, shell } from 'electron'
import type { AppInfo, AppLink } from '../../shared/types/app-info'
import { baseUrl } from '../account/account'
import * as ipc from '../ipc/guard'
import { WhatsNewStore } from './whats-new'

export const REPO_URL = 'https://github.com/xiaoheoxo/Pixel-Starry-Sky-Desktop'

const OS_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

export function channel(): AppInfo['channel'] {
  if (!app.isPackaged) return 'dev'
  // electron-builder 的便携版启动时会带上这个环境变量（解压后的真实 exe 位置）
  return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installed'
}

export function appInfo(): AppInfo {
  return {
    name: '像素星空',
    englishName: 'Pixel Starry Sky',
    version: app.getVersion(),
    channel: channel(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    os: `${OS_NAMES[process.platform] ?? process.platform} ${release()}`,
    arch: process.arch,
    authUrl: baseUrl(),
    dataDir: app.getPath('userData'),
    repoUrl: REPO_URL,
  }
}

async function open(link: AppLink): Promise<void> {
  switch (link) {
    case 'data-dir': {
      const err = await shell.openPath(app.getPath('userData'))
      if (err) throw new Error(`打不开数据目录：${err}`)
      return
    }
    case 'repo':
      return shell.openExternal(REPO_URL)
    case 'auth':
      return shell.openExternal(baseUrl())
    case 'register':
      return shell.openExternal(`${baseUrl()}/register`)
    case 'releases':
      return shell.openExternal(`${REPO_URL}/releases`)
    case 'issues':
      return shell.openExternal(`${REPO_URL}/issues/new/choose`)
  }
}

export function initAppInfo(): void {
  const deny = { deny: '不允许的调用方' }
  ipc.handle('app:info', () => appInfo(), deny)
  ipc.handle(
    'app:open',
    (_event, link: unknown) => {
      if (
        link !== 'data-dir' &&
        link !== 'repo' &&
        link !== 'auth' &&
        link !== 'register' &&
        link !== 'releases' &&
        link !== 'issues'
      )
        throw new Error('未知的链接')
      return open(link)
    },
    deny,
  )
  // 更新后的「更新内容」（GitHub #13）：开发模式下不弹
  const whatsNew = new WhatsNewStore(app.getPath('userData'), app.getVersion())
  ipc.handle(
    'app:whatsNew',
    () => ({ pending: channel() === 'dev' ? null : whatsNew.pending, muted: whatsNew.muted }),
    deny,
  )
  ipc.handle(
    'app:whatsNewSet',
    (_event, raw: unknown) => {
      const patch = (raw ?? {}) as { seen?: unknown; muted?: unknown }
      if (typeof patch.muted === 'boolean') whatsNew.setMuted(patch.muted)
      if (patch.seen === true) whatsNew.done()
    },
    deny,
  )
}
