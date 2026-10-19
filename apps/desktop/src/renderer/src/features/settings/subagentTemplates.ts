// 设置 › 子智能体的「从模板新建」（样式稿 docs/ui/subagent-settings-v2-mockup.html）：点一下建好一个填了说明、权限和时长的草稿，
// 展开后再改；文字按当前语言取。还有 task 工具说明的预览：主会话实际看到的类型列表
import { tr } from '@/i18n/core'
import {
  GENERAL_TYPE,
  type SubagentMaxMinutes,
  type SubagentTools,
  type SubagentType,
} from '../../../../shared/types/subagents'

export interface SubagentTemplate {
  /** 也是建出来的类型的标识（被占用时加 -2） */
  id: 'review' | 'tests' | 'research' | 'batch' | 'docs'
  tools: SubagentTools
  maxMinutes: SubagentMaxMinutes
}

export const SUBAGENT_TEMPLATES: readonly SubagentTemplate[] = [
  { id: 'review', tools: 'read', maxMinutes: 10 },
  { id: 'tests', tools: 'all', maxMinutes: 30 },
  { id: 'research', tools: 'read', maxMinutes: 10 },
  { id: 'batch', tools: 'all', maxMinutes: 60 },
  { id: 'docs', tools: 'all', maxMinutes: 30 },
]

export const templateName = (t: SubagentTemplate): string => tr(`subagentTemplate.${t.id}.name`)

/** 模板建出来的草稿（还没保存） */
export function fromTemplate(t: SubagentTemplate, id: string): SubagentType {
  return {
    id,
    name: templateName(t),
    description: tr(`subagentTemplate.${t.id}.description`),
    target: null,
    tools: t.tools,
    maxMinutes: t.maxMinutes,
    instructions: tr(`subagentTemplate.${t.id}.instructions`),
    enabled: true,
  }
}

/**
 * task 工具里列出的类型（和 packages/cli/src/tools/subagent.ts 的 taskDescription 一致）：启用的类型各一行；
 * 只有一个类型时不列，主会话不用选
 */
export function taskTypeLines(types: readonly SubagentType[]): string[] {
  const on = types.filter(t => t.enabled)
  if (on.length <= 1) return []
  return on.map(
    t =>
      `- ${t.id} (${t.name || t.id})${t.tools === 'read' ? ' [read-only]' : ''}: ${t.description || 'General-purpose subagent.'}`,
  )
}

export const TASK_TYPES_HEADER = `Subagent types — pass the best match as \`type\` (default: ${GENERAL_TYPE}):`
