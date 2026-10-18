import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSavedRuns } from '../src/claude/runs'
import { makeTmp, removeTmp } from './helpers/tmp'

let root: string
beforeEach(() => {
  root = makeTmp('claude-runs')
})
afterEach(() => removeTmp(root))

const line = (row: unknown) => JSON.stringify(row)
const text = (type: 'user' | 'assistant', t: string) =>
  line({ type, message: { content: [{ type: 'text', text: t }] } })
const image = line({
  type: 'user',
  message: { content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(200_000) } }] },
})

describe('Claude 重新打开会话：loadSavedRuns 预过滤', () => {
  it('编排启动、Agent / Task 调用与带总数的结果都读得到，普通对话行和图片行不影响结果', () => {
    const dir = join(root, 'sess')
    mkdirSync(join(dir, 'workflows'), { recursive: true })
    writeFileSync(
      join(dir, 'workflows', 'w1.json'),
      JSON.stringify({ taskId: 'wf-1', workflowName: '审查', summary: '说明', startTime: 100, totalTokens: 7 }),
    )
    const rows = [
      text('user', '你好'),
      image,
      // 启动编排的 Workflow 工具调用结果
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call-wf', content: 'ok' }] },
        toolUseResult: { taskType: 'local_workflow', taskId: 'wf-1' },
      }),
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'call-a',
              name: 'Agent',
              input: { description: '查日志', subagent_type: 'general', prompt: '去查' },
            },
            {
              type: 'tool_use',
              id: 'call-t',
              name: 'Task',
              input: { description: '旧名字', subagent_type: 'old', prompt: '旧' },
            },
          ],
        },
      }),
      image,
      line({
        type: 'user',
        timestamp: '2026-10-18T10:00:10.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'done' }] },
        toolUseResult: {
          agentId: 'ag1',
          resolvedModel: 'sonnet',
          totalTokens: 123,
          totalToolUseCount: 4,
          totalDurationMs: 5000,
        },
      }),
      line({
        type: 'user',
        timestamp: '2026-10-18T10:00:20.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call-t', content: 'done' }] },
        toolUseResult: {
          agentId: 'ag2',
          status: 'completed',
          totalTokens: 9,
          totalToolUseCount: 1,
          totalDurationMs: 1000,
        },
      }),
      text('assistant', '完成'),
    ]
    writeFileSync(`${dir}.jsonl`, rows.join('\n') + '\n')
    const runs = loadSavedRuns(dir)
    expect(runs.workflows).toHaveLength(1)
    expect(runs.workflows[0]).toMatchObject({ id: 'wf-1', name: '审查', toolUseId: 'call-wf' })
    expect(runs.agents.map(a => a.id)).toEqual(['ag1', 'ag2'])
    expect(runs.agents[0]).toMatchObject({
      label: '查日志',
      type: 'general',
      prompt: '去查',
      model: 'sonnet',
      tokens: 123,
      toolCalls: 4,
      durationMs: 5000,
      state: 'completed',
      toolUseId: 'call-a',
      startedAt: Date.parse('2026-10-18T10:00:10.000Z') - 5000,
    })
    expect(runs.agents[1]).toMatchObject({ label: '旧名字', type: 'old', toolUseId: 'call-t' })

    // 去掉所有无关行，结果完全一样
    writeFileSync(`${dir}.jsonl`, rows.filter(r => !r.includes('"image"') && !r.includes('"text"')).join('\n') + '\n')
    expect(loadSavedRuns(dir)).toEqual(runs)
  })

  it('没有记录文件或文件里没有相关行时是空的', () => {
    expect(loadSavedRuns(join(root, 'none'))).toEqual({ workflows: [], agents: [] })
    writeFileSync(join(root, 'plain.jsonl'), [text('user', '只是聊天'), image].join('\n'))
    expect(loadSavedRuns(join(root, 'plain'))).toEqual({ workflows: [], agents: [] })
    rmSync(join(root, 'plain.jsonl'))
  })
})
