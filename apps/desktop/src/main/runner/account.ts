// 执行机的账号（docs/multica-learn.md §11.7、§12 第 13 问）：配对换来的 rn_ 令牌存在 account.json，权限 0600。
// 无界面的服务器通常没有密钥环，gh、Claude Code 在 Linux 上也这样存；令牌只能调团队的几条接口、可在机器页停用。
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface RunnerAccount {
  /** 云端地址，例如 https://api.pixelstarrysky.xyz */
  base: string
  runnerId: string
  name: string
  token: string
}

export const accountFile = (dir: string): string => join(dir, 'account.json')

export function readAccount(dir: string): RunnerAccount | null {
  try {
    const o = JSON.parse(readFileSync(accountFile(dir), 'utf8')) as Record<string, unknown>
    const base = typeof o.base === 'string' && /^https?:\/\/[^\s/]+/.test(o.base) ? o.base.replace(/\/+$/, '') : ''
    const runnerId = typeof o.runnerId === 'string' && o.runnerId.startsWith('rn_') ? o.runnerId : ''
    const token = typeof o.token === 'string' && o.token.startsWith('rn_') ? o.token : ''
    if (!base || !runnerId || !token) return null
    return { base, runnerId, token, name: typeof o.name === 'string' ? o.name : '' }
  } catch {
    return null
  }
}

/** 先写临时文件（0600）再改名，写到一半断电不会留下半个令牌 */
export function writeAccount(dir: string, account: RunnerAccount): void {
  const tmp = accountFile(dir) + '.tmp'
  writeFileSync(tmp, JSON.stringify(account), { mode: 0o600 })
  renameSync(tmp, accountFile(dir))
}

export function clearAccount(dir: string): void {
  rmSync(accountFile(dir), { force: true })
}
