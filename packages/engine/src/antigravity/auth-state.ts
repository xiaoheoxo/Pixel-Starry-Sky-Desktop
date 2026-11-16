// agy 记住的 ACP 登录方式（docs/antigravity-engine.md §13「平台菜单看不到 Gemini 的原因」问题 2）：
// authenticate {methodId: 'gemini-api-key'} 后 agy 把它写进 ~/.gemini/antigravity-cli/cache/acp-auth-state.json，
// 之后不带 GEMINI_API_KEY 启动也按 Key 模式走，原来的 Google 登录不再生效（报 Authentication required）。
// 平台线路的会话每次都带会话密钥按 Key 认证，所以不带 Key 启动 agy 之前把这条记录清掉，让它回到自己的登录。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ACP_AUTH_REQUIRED } from '../acp/connection'

export const agyAuthStatePath = (home: string): string =>
  join(home, '.gemini', 'antigravity-cli', 'cache', 'acp-auth-state.json')

/** agy 看到的用户目录：按启动它的 env（和 os.homedir 一样，Windows 认 USERPROFILE、其它认 HOME） */
const homeOf = (env: NodeJS.ProcessEnv): string =>
  (process.platform === 'win32' ? env.USERPROFILE : env.HOME)?.trim() || homedir()

/**
 * 不带 Key 启动后报「需要认证」时要不要再试一次：启动前清掉的记录被同时启动的平台会话（按 Key 认证）写了回去，
 * 这次 agy 按 Key 模式走了。再清一次，清到了才值得重试（别的原因的「需要认证」不重试）
 */
export function keyAuthCameBack(error: unknown, env: NodeJS.ProcessEnv, home: string = homeOf(env)): boolean {
  return (error as { code?: unknown } | null)?.code === ACP_AUTH_REQUIRED && forgetKeyAuth(env, home)
}

/**
 * 终端（agy --conversation，不走 ACP）带 Key 启动前记上「按 Key 登录」：终端里的 agy 不看 GEMINI_API_KEY，只按这条记录选
 * （2026-11-17 实测：没有记录时带假 Key 照样用 Google 登录回答，有记录时才用 Key）。ACP 会话自己 authenticate，不用这个
 */
export function rememberKeyAuth(env: NodeJS.ProcessEnv, home: string = homeOf(env)): void {
  if (!env.GEMINI_API_KEY?.trim()) return
  const file = agyAuthStatePath(home)
  try {
    if ((JSON.parse(readFileSync(file, 'utf8')) as { methodId?: unknown })?.methodId === 'gemini-api-key') return
  } catch {
    // 没有记录或内容坏了：下面重写
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{"methodId":"gemini-api-key"}')
  } catch {
    // 写不了照样启动（会按 Google 登录走）
  }
}

/** 这次启动不带 Key、而 agy 记着「按 Key 登录」时删掉那条记录；删了返回 true。读写失败不影响启动 */
export function forgetKeyAuth(env: NodeJS.ProcessEnv, home: string = homeOf(env)): boolean {
  if (env.GEMINI_API_KEY?.trim()) return false
  const file = agyAuthStatePath(home)
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as { methodId?: unknown }
    if (state?.methodId !== 'gemini-api-key') return false
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}
