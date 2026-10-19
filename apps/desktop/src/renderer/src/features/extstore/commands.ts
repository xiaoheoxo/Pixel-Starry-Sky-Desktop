import type { TranslationKey } from '@/i18n/core'
import { openExtSearch, openExtTab } from './nav'

// 命令面板里的两条扩展命令（方案 §2.5）。登记在 CommandPaletteProvider，这里只管 id、文案键和动作，方便不挂界面就测。

export interface ExtStoreCommand {
  id: string
  key: TranslationKey
  run(): void
}

export function extStoreCommands(deps: {
  openSettings(section: 'extensions'): void
  checkUpdates(): unknown
}): ExtStoreCommand[] {
  return [
    {
      id: 'extstore.checkUpdates',
      key: 'extstore.command.checkUpdates',
      run: () => {
        openExtTab('installed')
        deps.openSettings('extensions')
        void deps.checkUpdates()
      },
    },
    {
      id: 'extstore.search',
      key: 'extstore.command.search',
      run: () => {
        openExtSearch()
        deps.openSettings('extensions')
      },
    },
  ]
}
