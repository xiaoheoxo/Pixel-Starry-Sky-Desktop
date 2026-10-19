// 第一次打开软件的欢迎页（docs/ui/first-launch-login-mockup.html）：什么时候出现、显示哪一步、看过没有
import type { EngineInfo } from '@pixelsky/protocol'
import type { LoginFailure } from '../../../../shared/types/account'
import type { AccountStatus } from '../account/useAccount'

const KEY = 'pixelsky.first-launch.v1'

/** 看过（登录了、跳过了，或者是从旧版本升级上来的）就不再出现；读不到存储时按看过算，不打扰 */
export function firstLaunchDone(): boolean {
  try {
    return localStorage.getItem(KEY) === 'done'
  } catch {
    return true
  }
}

export function finishFirstLaunch(): void {
  try {
    localStorage.setItem(KEY, 'done')
  } catch {
    // 存不下也只是下次再出现一次
  }
}

export type FirstLaunchDecision = 'wait' | 'show' | 'skip'

/**
 * 要不要显示欢迎页：演示模式、看过的不显示；引擎数据和账号状态都拿到之前先等；
 * 已经有项目、会话或者登录着的，是用过的（多半是从旧版本升级上来的），不再打扰
 */
export function decideFirstLaunch(input: {
  demo: boolean
  done: boolean
  engineReady: boolean
  projects: number
  sessions: number
  account: AccountStatus
}): FirstLaunchDecision {
  if (input.demo || input.done) return 'skip'
  if (!input.engineReady || input.account === 'loading') return 'wait'
  if (input.projects || input.sessions || input.account !== 'signed-out') return 'skip'
  return 'show'
}

export type FirstLaunchView = 'welcome' | 'waiting' | 'success' | 'error'

/** 右侧显示哪一步：按账号状态走；没成功的提示只在这一页点过登录之后出现 */
export function firstLaunchView(
  status: AccountStatus,
  failure: LoginFailure | null,
  attempted: boolean,
): FirstLaunchView {
  if (status === 'signed-in') return 'success'
  if (status === 'signing-in') return 'waiting'
  if (attempted && failure) return 'error'
  return 'welcome'
}

const ENGINE_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

/**
 * 这台电脑上找到的 Claude Code / Codex：checked 是检测结果已经回来了（列表里有这两个引擎）。
 * 装了但没登录、版本太旧也算找到：进去以后能在设置里处理
 */
export function foundEngines(engines: readonly EngineInfo[]): { checked: boolean; found: string[] } {
  const local = engines.filter(e => e.id in ENGINE_NAMES)
  return {
    checked: local.length > 0,
    found: local.filter(e => e.status !== 'missing' && e.status !== 'unsupported').map(e => ENGINE_NAMES[e.id]),
  }
}

/** 主进程等授权最多 5 分钟（main/account/account.ts LOGIN_TIMEOUT_MS） */
export const LOGIN_WAIT_MS = 5 * 60_000

/** 还剩多久（毫秒，不小于 0）和显示用的 m:ss */
export function loginRemaining(startedAt: number, now: number): { ms: number; text: string } {
  const ms = Math.max(0, LOGIN_WAIT_MS - (now - startedAt))
  const seconds = Math.ceil(ms / 1000)
  return { ms, text: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
}

/** 品牌区的像素星点：固定种子，每次打开位置一样（百分比坐标、边长、透明度） */
export function skyPixels(count = 30, seed = 7): Array<{ x: number; y: number; size: number; opacity: number }> {
  let s = seed
  const next = (): number => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
  return Array.from({ length: count }, () => {
    const size = next() < 0.8 ? 2 : 3
    return { x: next() * 100, y: next() * 78, size, opacity: 0.12 + next() * 0.45 }
  })
}
