import { describe, expect, it } from 'vitest'
import { BUILTIN_SUBAGENT_TYPES, SUBAGENT_MAX_MINUTES } from '../../../../shared/types/subagents'
import { SUBAGENT_TEMPLATES, fromTemplate, taskTypeLines } from './subagentTemplates'

const builtins = () => BUILTIN_SUBAGENT_TYPES.map(t => ({ ...t }))

describe('子智能体模板', () => {
  it('建出来的草稿带说明、权限和时长，标识用传进来的', () => {
    const t = fromTemplate(SUBAGENT_TEMPLATES[0]!, 'review-2')
    expect(t).toMatchObject({ id: 'review-2', tools: 'read', maxMinutes: 10, target: null, enabled: true })
    expect(t.name).not.toBe('')
    expect(t.description).not.toBe('')
  })
  it('模板的时长都是可选的档位，标识不和内置类型重复', () => {
    for (const t of SUBAGENT_TEMPLATES) {
      expect(SUBAGENT_MAX_MINUTES).toContain(t.maxMinutes)
      expect(BUILTIN_SUBAGENT_TYPES.map(b => b.id)).not.toContain(t.id)
    }
  })
})

describe('主会话看到的类型说明', () => {
  it('和命令行 task 工具的写法一致：启用的各一行，只读的标出来', () => {
    expect(taskTypeLines(builtins())).toEqual([
      `- general (通用): ${BUILTIN_SUBAGENT_TYPES[0]!.description}`,
      `- explore (探索) [read-only]: ${BUILTIN_SUBAGENT_TYPES[1]!.description}`,
    ])
  })
  it('关掉的不列；只剩一个时不列类型', () => {
    const types = builtins()
    types[1]!.enabled = false
    expect(taskTypeLines(types)).toEqual([])
  })
})
