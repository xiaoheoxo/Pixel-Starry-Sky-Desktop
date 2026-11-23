// 侧栏「只看运行中 / 只看等你」（docs/ui/task-board.md §2.1）：底部胶囊的两个数字点了就把置顶和项目列表筛成这些会话。
// 分类和任务看板、胶囊同一套（sessionLanes.ts）。纯函数，不依赖 window。
import { useEffect, type RefObject } from 'react'
import type { Project } from '@/data'
import { isWaiting, type SessionCard, type SessionLane } from '@/features/board/sessionLanes'

export type RunFilter = 'running' | 'waiting'

export function laneMatches(lane: SessionLane | undefined, filter: RunFilter): boolean {
  return !!lane && (filter === 'running' ? lane === 'running' : isWaiting(lane))
}

/** 会话 ID → 分类 */
export const lanesOf = (cards: readonly SessionCard[]): Map<string, SessionLane> =>
  new Map(cards.map(c => [c.id, c.lane]))

/** 会话 ID → 看板卡片（侧栏行要里面的请求、错误） */
export const cardsOf = (cards: readonly SessionCard[]): Map<string, SessionCard> => new Map(cards.map(c => [c.id, c]))

/** 项目只留符合的会话、全部展开、不带归档；没有符合会话的项目不显示 */
export function filterProjects(
  projects: readonly Project[],
  lanes: ReadonlyMap<string, SessionLane>,
  filter: RunFilter,
): Project[] {
  return projects
    .map(p => ({
      ...p,
      sessions: p.sessions.filter(s => laneMatches(lanes.get(s.id), filter)),
      archived: [],
      expanded: true,
    }))
    .filter(p => p.sessions.length > 0)
}

export function filterSessions<T extends { id: string }>(
  sessions: readonly T[],
  lanes: ReadonlyMap<string, SessionLane>,
  filter: RunFilter,
): T[] {
  return sessions.filter(s => laneMatches(lanes.get(s.id), filter))
}

/**
 * 竖向滚动区上下还有内容时两头淡出（data-fade-top / data-fade-bottom，globals.css）；
 * 滚动时临时标上 data-scrolling 让细滚动条浮现，停滚约 0.9 秒后淡出。
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let hideTimer: ReturnType<typeof setTimeout> | null = null
    const update = (): void => {
      el.toggleAttribute('data-fade-top', el.scrollTop > 1)
      el.toggleAttribute('data-fade-bottom', el.scrollTop + el.clientHeight < el.scrollHeight - 1)
    }
    const onScroll = (): void => {
      update()
      el.setAttribute('data-scrolling', '')
      if (hideTimer !== null) clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        hideTimer = null
        el.removeAttribute('data-scrolling')
      }, 900)
    }
    update()
    el.addEventListener('scroll', onScroll, { passive: true })
    const resize = new ResizeObserver(update)
    resize.observe(el)
    // 内容变了（展开项目、筛选）高度也会变
    const mutation = new MutationObserver(update)
    mutation.observe(el, { childList: true, subtree: true })
    return () => {
      if (hideTimer !== null) clearTimeout(hideTimer)
      el.removeAttribute('data-scrolling')
      el.removeEventListener('scroll', onScroll)
      resize.disconnect()
      mutation.disconnect()
    }
  }, [ref])
}
