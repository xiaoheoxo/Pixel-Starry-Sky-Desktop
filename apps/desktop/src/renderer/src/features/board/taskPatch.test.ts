import { describe, expect, it } from 'vitest'
import { changedTaskFields, type TaskForm } from './taskPatch'

const task: TaskForm = { title: '写周报', note: '', status: 'pending', priority: 'normal', due: '', tags: ['工作'] }

describe('changedTaskFields：编辑任务只发改过的字段', () => {
  it('只改标题：不带状态（表单开着时在列表里勾成已完成，不会被冲回待处理）', () => {
    expect(changedTaskFields(task, { ...task, title: '写周报和月报' })).toEqual({ title: '写周报和月报' })
  })
  it('什么都没改：空补丁', () => {
    expect(changedTaskFields(task, { ...task })).toEqual({})
  })
  it('标题首尾空格不算改动；标签去掉空项后比较', () => {
    expect(changedTaskFields(task, { ...task, title: ' 写周报 ', tags: ['工作', ''] })).toEqual({})
    expect(changedTaskFields(task, { ...task, tags: ['工作', '紧急'] })).toEqual({ tags: ['工作', '紧急'] })
  })
  it('表单里自己改了状态：照发', () => {
    expect(changedTaskFields(task, { ...task, status: 'in_progress' })).toEqual({ status: 'in_progress' })
  })
})
