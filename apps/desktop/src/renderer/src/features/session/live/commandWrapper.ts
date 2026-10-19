import type { CommandWrapper } from '@pixelsky/protocol'

/** 外壳名的显示写法：powershell → PowerShell，其他照原样（pwsh、bash、cmd…） */
export function shellDisplayName(shell: string): string {
  return shell === 'powershell' ? 'PowerShell' : shell
}

/** 外层带了引出脚本的开关以外的参数时才需要提醒 */
export const hasWrapperExtra = (w: CommandWrapper | undefined): w is CommandWrapper => !!w && w.extra.length > 0
