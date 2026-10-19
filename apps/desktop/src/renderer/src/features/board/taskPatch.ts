import type { ManualTask } from '../../../../shared/types/project-tools'

export type TaskForm = Pick<ManualTask, 'title' | 'note' | 'status' | 'priority' | 'due' | 'tags'>

/**
 * 编辑任务保存时只发改过的字段（和打开表单时比）：表单开着时，状态可能已在列表勾选、看板拖动、
 * 侧栏固定项或手机上单独改过，整份写回会把它冲回旧值。没改过的字段主进程沿用已存的值
 */
export function changedTaskFields(origin: TaskForm, form: TaskForm): Partial<TaskForm> {
  const patch: Partial<TaskForm> = {}
  if (form.title.trim() !== origin.title) patch.title = form.title.trim()
  if (form.note !== origin.note) patch.note = form.note
  if (form.status !== origin.status) patch.status = form.status
  if (form.priority !== origin.priority) patch.priority = form.priority
  if (form.due !== origin.due) patch.due = form.due
  const tags = form.tags.filter(Boolean)
  if (tags.join('\n') !== origin.tags.join('\n')) patch.tags = tags
  return patch
}
