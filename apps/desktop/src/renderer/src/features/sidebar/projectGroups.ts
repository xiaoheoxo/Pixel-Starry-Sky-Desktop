// 侧栏分区（docs/ui/sidebar-groups.md）：几个独立项目归成一组，只是收纳，项目和对话都不动。
// 分区存在侧栏偏好里（appearance/sidebar.ts 的 groups）；这里是排列和增删改的纯函数，不依赖 window。
import type { ProjectGroup } from '@/features/appearance/sidebar'

export type TreeEntry<P> =
  | { kind: 'group'; group: ProjectGroup; projects: P[] }
  | { kind: 'project'; project: P; pinned?: true }

/** 新分区的 ID：时间 + 随机几位，同一台电脑上不会撞 */
export const newGroupId = (): string => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** 收起状态和项目共用一个列表，分区的键加前缀，和项目 ID 分开 */
export const groupKey = (id: string): string => `group:${id}`

/** 按拖出来的顺序排：排过的按记下的先后，没排过的（新加的）接在后面、保持原来的顺序 */
export function sortByOrder<P extends { id: string }>(projects: readonly P[], order: readonly string[]): P[] {
  if (!order.length) return [...projects]
  const rank = new Map(order.map((id, i) => [id, i]))
  const listed = projects.filter(p => rank.has(p.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  return [...listed, ...projects.filter(p => !rank.has(p.id))]
}

/**
 * 置顶的项目最前（按 pinned 的先后，docs/ui/project-pin.md），再是分区（按分区的先后），不在分区里的项目在后。
 * 项目（分区里的和外面的）按拖出来的顺序（order），没排过就按项目列表的顺序；
 * 当前列表里一个都没有（别的机器的、筛掉了的）的分区不显示。置顶的项目不算进分区
 */
export function arrangeProjects<P extends { id: string }>(
  unsorted: readonly P[],
  groups: readonly ProjectGroup[],
  order: readonly string[] = [],
  pinned: readonly string[] = [],
): TreeEntry<P>[] {
  const top = new Set(pinned)
  const entries: TreeEntry<P>[] = []
  for (const id of pinned) {
    const project = unsorted.find(p => p.id === id)
    if (project) entries.push({ kind: 'project', project, pinned: true })
  }
  const projects = sortByOrder(
    unsorted.filter(p => !top.has(p.id)),
    order,
  )
  const owner = new Map<string, string>()
  for (const g of groups) for (const id of g.projects) if (!owner.has(id) && !top.has(id)) owner.set(id, g.id)
  for (const group of groups) {
    const members = projects.filter(p => owner.get(p.id) === group.id)
    if (members.length) entries.push({ kind: 'group', group, projects: members })
  }
  for (const project of projects) if (!owner.has(project.id)) entries.push({ kind: 'project', project })
  return entries
}

/** 项目在哪个分区；不在分区里为 undefined */
export const groupOf = (groups: readonly ProjectGroup[], projectId: string): ProjectGroup | undefined =>
  groups.find(g => g.projects.includes(projectId))

const prune = (groups: ProjectGroup[]): ProjectGroup[] => groups.filter(g => g.projects.length > 0)
const without = (groups: readonly ProjectGroup[], ids: readonly string[]): ProjectGroup[] =>
  groups.map(g => ({ ...g, projects: g.projects.filter(p => !ids.includes(p)) }))

/** 新建分区放在最后；这些项目先从原来的分区里移出 */
export function createGroup(
  groups: readonly ProjectGroup[],
  group: { id: string; name: string },
  ids: readonly string[],
): ProjectGroup[] {
  const members = [...new Set(ids)]
  return prune([...without(groups, members), { ...group, projects: members }])
}

/** 加入已有分区（接在后面）；从别的分区移过来 */
export function addToGroup(groups: readonly ProjectGroup[], groupId: string, ids: readonly string[]): ProjectGroup[] {
  if (!groups.some(g => g.id === groupId)) return [...groups]
  const members = [...new Set(ids)]
  return prune(
    without(groups, members).map(g => (g.id === groupId ? { ...g, projects: [...g.projects, ...members] } : g)),
  )
}

/** 移出分区；分区空了就去掉 */
export const removeFromGroups = (groups: readonly ProjectGroup[], ids: readonly string[]): ProjectGroup[] =>
  prune(without(groups, ids))

export const renameGroup = (groups: readonly ProjectGroup[], groupId: string, name: string): ProjectGroup[] =>
  groups.map(g => (g.id === groupId ? { ...g, name } : g))

/** 解散：分区去掉，里面的项目回到平铺 */
export const dissolveGroup = (groups: readonly ProjectGroup[], groupId: string): ProjectGroup[] =>
  groups.filter(g => g.id !== groupId)

export type DropPlace = 'before' | 'after'

/** 落点在目标的上半还是下半 */
export const dropPlace = (rect: { top: number; height: number }, y: number): DropPlace =>
  y < rect.top + rect.height / 2 ? 'before' : 'after'

/**
 * 把几个项目拖到 target 的前面 / 后面（docs/ui/sidebar-groups.md §2「拖动」）。
 * shown 是侧栏里现在看到的先后；记下的顺序里看不到的（别的机器的）接在后面，相对先后不变。
 * 拖的几个保持原来的先后；target 是拖的之一时不变
 */
export function moveProjects(
  order: readonly string[],
  shown: readonly string[],
  ids: readonly string[],
  target: string,
  place: DropPlace,
): string[] {
  const base = [...new Set([...shown, ...order])]
  if (ids.includes(target) || !base.includes(target)) return base
  const moving = base.filter(id => ids.includes(id))
  const rest = base.filter(id => !ids.includes(id))
  const at = rest.indexOf(target) + (place === 'after' ? 1 : 0)
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)]
}

/**
 * 项目放到另一个项目的前面 / 后面：target 在分区里就跟着进这个分区，不在就移出分区，再排到它旁边
 */
export function dropProjects(
  state: { groups: readonly ProjectGroup[]; order: readonly string[] },
  shown: readonly string[],
  ids: readonly string[],
  target: string,
  place: DropPlace,
): { groups: ProjectGroup[]; order: string[] } {
  if (ids.includes(target)) return { groups: [...state.groups], order: [...state.order] }
  const home = groupOf(state.groups, target)
  return {
    groups: home ? addToGroup(state.groups, home.id, ids) : removeFromGroups(state.groups, ids),
    order: moveProjects(state.order, shown, ids, target, place),
  }
}

/** 分区拖到另一个分区的前面 / 后面 */
export function moveGroup(
  groups: readonly ProjectGroup[],
  id: string,
  target: string,
  place: DropPlace,
): ProjectGroup[] {
  const moving = groups.find(g => g.id === id)
  if (!moving || id === target || !groups.some(g => g.id === target)) return [...groups]
  const rest = groups.filter(g => g.id !== id)
  const at = rest.findIndex(g => g.id === target) + (place === 'after' ? 1 : 0)
  return [...rest.slice(0, at), moving, ...rest.slice(at)]
}

/** Shift 连选：从上次点的项目到这次点的项目（按侧栏里看到的先后），两头都算 */
export function rangeBetween(order: readonly string[], from: string | null, to: string): string[] {
  const end = order.indexOf(to)
  const start = from ? order.indexOf(from) : -1
  if (end < 0) return []
  if (start < 0) return [to]
  return order.slice(Math.min(start, end), Math.max(start, end) + 1)
}
