// 设置云同步的对账规则（docs/ui/settings-sync.md §4）：纯函数，输入上次同步的状态、本机现在的值、云端的映射，
// 输出「要写到本机的」和「要上传的」。调度、读写本机在 engine.ts。
import type { CloudSettings } from '../../../../../shared/types/settings-sync'

/** 一个键上次同步后的样子：当时云端的 updatedAt、当时本机的值（JSON 文本，null 表示本机没有 = 默认值） */
export interface KeyState {
  cloudAt: number | null
  local: string | null
}
/** 按账号保存在本机的同步状态；没有就是这台电脑第一次给这个账号同步 */
export interface SyncState {
  v: 1
  keys: Record<string, KeyState>
}

export interface MergeInput {
  state: SyncState | null
  /** 要同步的键（关掉的分类不在里面） */
  keys: readonly string[]
  /** 本机现在的值；undefined 表示没有（默认值） */
  local: Record<string, unknown>
  cloud: CloudSettings
  /** 两边都改了时怎么合并（默认：本机覆盖云端）。整份覆盖会丢用户做的东西的键才用 */
  conflict?: Record<string, (mine: unknown, theirs: unknown) => unknown>
}

export interface MergeResult {
  /** 写到本机：null 表示云端删了这个键，本机恢复默认 */
  apply: Record<string, unknown>
  /** 上传：null 表示删掉云端的这个键 */
  push: Record<string, unknown>
  /** 第一次同步时用云端的覆盖了本机（要提示「已从云端恢复设置」并能撤销） */
  restored: boolean
}

export const json = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value)

export function merge({ state, keys, local, cloud, conflict }: MergeInput): MergeResult {
  const apply: Record<string, unknown> = {}
  const push: Record<string, unknown> = {}
  let restored = false

  if (!state) {
    // 第一次：云端什么都没有就上传本机改过的；云端有就用云端的覆盖本机，云端没有的键上传本机的
    const cloudHasAny = keys.some(k => cloud[k])
    for (const k of keys) {
      const mine = json(local[k])
      const theirs = cloud[k]
      if (theirs && cloudHasAny) {
        const value = conflict?.[k] && mine !== null ? conflict[k](local[k], theirs.value) : theirs.value
        if (json(value) !== mine) {
          apply[k] = value
          restored = true
        }
        if (json(value) !== json(theirs.value)) push[k] = value
      } else if (mine !== null) push[k] = local[k]
    }
    return { apply, push, restored }
  }

  for (const k of keys) {
    const before = state.keys[k] ?? { cloudAt: null, local: null }
    const mine = json(local[k])
    const theirs = cloud[k]
    const localChanged = mine !== before.local
    const cloudChanged = (theirs?.updatedAt ?? null) !== before.cloudAt
    if (localChanged && cloudChanged && theirs && mine !== null && conflict?.[k]) {
      const value = conflict[k](local[k], theirs.value)
      if (json(value) !== mine) apply[k] = value
      if (json(value) !== json(theirs.value)) push[k] = value
    } else if (localChanged) {
      // 本机改了：上传，最后一个到达服务端的为准（两边都改了也一样，偏好设置不做合并界面）
      if (mine !== null) push[k] = local[k]
      else if (theirs) push[k] = null
    } else if (cloudChanged) {
      if (theirs) {
        if (json(theirs.value) !== mine) apply[k] = theirs.value
      } else if (mine !== null) apply[k] = null
    }
  }
  return { apply, push, restored }
}

/**
 * 同步完以后的状态：上传了的键记上传的值（不重新读，免得把上传途中用户的新改动当成已同步），
 * 写回本机的键记写完后重新读到的值（被设置模块的校验改过也以它为准），其余记这一轮读到的值。
 */
export function nextState(
  prev: SyncState | null,
  keys: readonly string[],
  local: Record<string, unknown>,
  after: Record<string, unknown>,
  result: Pick<MergeResult, 'apply' | 'push'>,
  cloud: CloudSettings,
): SyncState {
  const out: SyncState = { v: 1, keys: { ...(prev?.keys ?? {}) } }
  for (const k of keys) {
    const local_ = k in result.push ? json(result.push[k]) : k in result.apply ? json(after[k]) : json(local[k])
    out.keys[k] = { cloudAt: cloud[k]?.updatedAt ?? null, local: local_ }
  }
  return out
}

export function parseSyncState(raw: unknown): SyncState | null {
  const v = raw as SyncState | null
  if (!v || v.v !== 1 || !v.keys || typeof v.keys !== 'object') return null
  const keys: Record<string, KeyState> = {}
  for (const [k, s] of Object.entries(v.keys)) {
    if (!s || typeof s !== 'object') continue
    keys[k] = {
      cloudAt: typeof s.cloudAt === 'number' ? s.cloudAt : null,
      local: typeof s.local === 'string' ? s.local : null,
    }
  }
  return { v: 1, keys }
}
