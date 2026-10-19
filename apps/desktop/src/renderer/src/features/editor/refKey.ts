// 工作区的 key（不带别的依赖，Git 对比标签的 store 也要用；editor/target.ts 原样转出）
import type { WorkspaceRef } from '../../../../shared/types/workspace'

export const refKey = (ref: WorkspaceRef): string =>
  (ref.sessionId ? `s:${ref.sessionId}` : `p:${ref.projectId}`) + (ref.folder ? `#${ref.folder}` : '')
/** refKey 反过来：按 key 写依赖的 effect 里拿回工作区（每次渲染的 ref 都是新对象）；「#N」是附加文件夹 */
export function keyRef(key: string): WorkspaceRef {
  const [id, folder] = key.slice(2).split('#')
  const extra = folder ? { folder: Number(folder) } : {}
  return key.startsWith('s:') ? { sessionId: id, ...extra } : { projectId: id, ...extra }
}
