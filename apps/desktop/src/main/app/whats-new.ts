// 更新后的「更新内容」弹窗（GitHub #13，docs/release-update.md §8）：记住上次运行的版本，版本变了就让界面弹一次。
// 状态存在 <userData>/whats-new.json；启动时读一次，之后的查询都按启动时的结果，弹窗关掉才记成已看过。
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WhatsNew, WhatsNewPatch } from '../../shared/types/app-info'

interface State {
  /** 看过更新内容的版本 */
  seen: string
  /** 「不再提示」 */
  muted: boolean
}

const FILE = 'whats-new.json'

function load(dir: string): State | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as Partial<State>
    if (typeof raw.seen !== 'string') return null
    return { seen: raw.seen, muted: raw.muted === true }
  } catch {
    return null
  }
}

/** 数据目录里已经有引擎数据、窗口位置、页面存储：是从还没有这个功能的旧版本升上来的，不是第一次安装（这几样都在本模块初始化之后才会第一次写） */
function usedBefore(dir: string): boolean {
  try {
    return readdirSync(dir).some(name => name === 'engine' || name === 'window.json' || name === 'Local Storage')
  } catch {
    return false
  }
}

export class WhatsNewStore {
  private state: State | null
  /** 启动时要不要弹：版本变了、没关提示 */
  readonly pending: WhatsNew | null
  /** 启动时读到的记录里看过的版本，没有记录时为 null（写进启动日志） */
  readonly seenAtStart: string | null
  /** 第一次安装：没有记录、数据目录也没用过 */
  readonly firstInstall: boolean

  constructor(
    private readonly dir: string,
    private readonly version: string,
  ) {
    this.state = load(dir)
    this.seenAtStart = this.state?.seen ?? null
    this.firstInstall = !this.state && !usedBefore(dir)
    if (!this.state) {
      // 第一次安装不弹，直接记下当前版本；从旧版本升上来的不知道原来是哪个版本，只显示这一版
      const upgraded = !this.firstInstall
      this.pending = upgraded ? { version, previous: null } : null
      if (!upgraded) this.save({ seen: version, muted: false })
    } else
      this.pending = this.state.seen !== version && !this.state.muted ? { version, previous: this.state.seen } : null
  }

  get muted(): boolean {
    return this.state?.muted ?? false
  }

  /** 弹窗关掉：这一版记成看过 */
  done(): void {
    this.save({ seen: this.version, muted: this.state?.muted ?? false })
  }

  setMuted(muted: boolean): void {
    this.save({ seen: this.state?.seen ?? this.version, muted })
  }

  private save(state: State): void {
    this.state = state
    try {
      if (existsSync(this.dir)) writeFileSync(join(this.dir, FILE), JSON.stringify(state))
    } catch {
      // 写不进去：下次启动可能再弹一次，不影响使用
    }
  }
}

const CLOSE_VIA: readonly NonNullable<WhatsNewPatch['via']>[] = ['done', 'x', 'esc', 'backdrop', 'mute', 'noNotes']
const FROM: readonly NonNullable<WhatsNewPatch['from']>[] = ['main', 'settingsWindow']
const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined => list.find(item => item === v)

/** 界面传来的改动：只留认识的字段和取值（via、from 只用来写日志） */
export function whatsNewPatch(raw: unknown): WhatsNewPatch {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const via = pick(CLOSE_VIA, p.via),
    from = pick(FROM, p.from)
  return {
    ...(p.seen === true ? { seen: true as const } : {}),
    ...(typeof p.muted === 'boolean' ? { muted: p.muted } : {}),
    ...(via ? { via } : {}),
    ...(from ? { from } : {}),
  }
}
