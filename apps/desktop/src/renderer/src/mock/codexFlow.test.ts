// Codex 中间的回复直接显示的演示（docs/ui/codex-flow-slash-feedback.md A）：侧栏的对话都有快照、引擎是 Codex
import { describe, expect, it } from 'vitest'
import { CODEX_FLOW_PROJECT, CODEX_FLOW_SESSIONS, codexFlowSnapshots } from './codexFlow'
import { demo } from './demo'

describe('Codex 演示对话', () => {
  it('侧栏里的对话都有快照，引擎都是 Codex', () => {
    const project = demo.projects.find(p => p.id === CODEX_FLOW_PROJECT)!
    expect(project.sessions.map(s => s.id)).toEqual(CODEX_FLOW_SESSIONS.map(s => s.id))
    for (const { id } of CODEX_FLOW_SESSIONS) expect(codexFlowSnapshots[id].record.engine, id).toBe('codex')
  })
})
