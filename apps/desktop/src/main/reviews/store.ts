// AI 审查结果（docs/mobile-app.md §15.5、docs/ui/review-pr-actions.md §2.4）：原来存在窗口的 localStorage，
// 挪到主进程 <dataRoot>/ai-reviews.json，窗口经 IPC 读写，手机网关也能看、能标忽略和发去修。
// 按会话存每轮的结果，只留最近 SESSION_LIMIT 个会话（新写的排在最后）。不依赖 electron，测试见 store.test.ts。
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ReviewsChange, ReviewStatus, SessionReviews, TurnReview } from '../../shared/types/ai'

export const SESSION_LIMIT = 200
/** 一轮最多存几条（审查最多回 20 条，复审再加；留余量防坏数据） */
const ITEMS_LIMIT = 100

/** 像一轮审查结果的对象才收（窗口和旧 localStorage 给的都过一遍） */
export function isTurnReview(v: unknown): v is TurnReview {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.at === 'number' &&
    typeof r.model === 'string' &&
    Array.isArray(r.items) &&
    r.items.length <= ITEMS_LIMIT &&
    r.items.every(i => i && typeof i === 'object' && typeof (i as { id?: unknown }).id === 'string')
  )
}

function cleanSession(v: unknown): SessionReviews | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const out: SessionReviews = {}
  for (const [turnKey, review] of Object.entries(v)) if (isTurnReview(review)) out[turnKey] = review
  return Object.keys(out).length ? out : null
}

export class ReviewStore {
  private data: Record<string, SessionReviews> = {}
  private writing: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(change: ReviewsChange) => void>()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw))
        for (const [id, turns] of Object.entries(raw)) {
          const clean = cleanSession(turns)
          if (clean) this.data[id] = clean
        }
    } catch (e) {
      // 没有文件：从空的开始；读不了或损坏：先留一份 .bad（下次写会盖掉原文件）再从空的开始
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        await copyFile(this.file, `${this.file}.bad`).catch(() => undefined)
    }
  }

  all(): Record<string, SessionReviews> {
    return this.data
  }

  session(sessionId: string): SessionReviews {
    return this.data[sessionId] ?? {}
  }

  onChange(listener: (change: ReviewsChange) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /**
   * 窗口启动时带来 localStorage 里的旧结果（迁过来一次）：主进程已经有的会话不覆盖。
   * 返回迁移后的全部
   */
  importLegacy(legacy: unknown): Record<string, SessionReviews> {
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return this.data
    let changed = false
    for (const [id, turns] of Object.entries(legacy)) {
      if (this.data[id] || id.length > 300) continue
      const clean = cleanSession(turns)
      if (!clean) continue
      this.data[id] = clean
      changed = true
    }
    if (changed) {
      this.prune()
      this.save()
    }
    return this.data
  }

  /** 写一轮的结果；null 是删掉这一轮 */
  set(sessionId: string, turnKey: string, review: TurnReview | null): void {
    const turns = { ...this.data[sessionId] }
    if (review) turns[turnKey] = review
    else if (!(turnKey in turns)) return
    else delete turns[turnKey]
    // 新写的会话排到最后：删了再加
    delete this.data[sessionId]
    if (Object.keys(turns).length) this.data[sessionId] = turns
    this.prune()
    this.save()
    const change = { sessionId, turns: this.session(sessionId) }
    for (const l of this.listeners) l(change)
  }

  /** 改一轮里一条的状态（手机上的「忽略」「恢复」）；找不到返回 false */
  setStatus(sessionId: string, turnKey: string, itemId: string, status: ReviewStatus): boolean {
    const review = this.data[sessionId]?.[turnKey]
    if (!review?.items.some(i => i.id === itemId)) return false
    this.set(sessionId, turnKey, {
      ...review,
      items: review.items.map(i => (i.id === itemId ? { ...i, status } : i)),
    })
    return true
  }

  /** 这几条发去修了（同窗口 useReviewRunner 的 fix）：标成 sent，记下发的话，修的那一轮结束后窗口自动复审一次 */
  markSent(sessionId: string, turnKey: string, ids: readonly string[], text: string): void {
    const review = this.data[sessionId]?.[turnKey]
    if (!review) return
    const set = new Set(ids)
    this.set(sessionId, turnKey, {
      ...review,
      items: review.items.map(i => (set.has(i.id) ? { ...i, status: 'sent' as const } : i)),
      fix: review.rechecked ? null : { text, ids: [...set] },
    })
  }

  private prune(): void {
    const ids = Object.keys(this.data)
    for (const id of ids.slice(0, Math.max(0, ids.length - SESSION_LIMIT))) delete this.data[id]
  }

  /** 先写临时文件再改名，写入排队，不会写一半 */
  private save(): void {
    const text = JSON.stringify(this.data)
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        const tmp = `${this.file}.tmp`
        await writeFile(tmp, text, 'utf8')
        await rename(tmp, this.file)
      })
      .catch(() => undefined)
  }

  /** 等排队的写入都落盘（测试、退出时用） */
  flush(): Promise<void> {
    return this.writing
  }
}
