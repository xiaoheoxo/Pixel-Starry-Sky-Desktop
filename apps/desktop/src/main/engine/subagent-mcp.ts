import type { EngineHost } from '@pixelsky/engine'
import { machineOf } from '../machines/identity'
import { sessionMcpServer, type HistoryServer } from './history-mcp'

export const SUBAGENT_SERVER_NAME = 'pixelsky_subagents'

export function subagentServer(ctx: { engine: Pick<EngineHost, 'delegate'> | null }): HistoryServer {
  return sessionMcpServer({
    name: SUBAGENT_SERVER_NAME,
    enabled: record => machineOf(record.id) === 'local' && !record.subagentParentId,
    instructions:
      'Use this server task tool for all delegation. PixelSky applies the user-selected subagent site and model. Native subagent tools are disabled. Include all context needed by the independent worker; it does not inherit conversation history. Do not include credentials or choose another provider in the prompt.',
    tools: [
      {
        name: 'task',
        description:
          'Delegate a self-contained task to an independent coding agent with local tools. PixelSky uses the subagent site/model selected by the user and forwards approvals and progress to the parent session. Wait for the final report and use it to continue. Several calls can run in parallel; the child cannot delegate further.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string', minLength: 1, maxLength: 200 },
            prompt: { type: 'string', minLength: 1, maxLength: 100000 },
          },
          required: ['description', 'prompt'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
    ],
    async call(id, name, args, signal) {
      if (name !== 'task') throw new Error('没有这个子代理工具')
      if (!ctx.engine) throw new Error('引擎还没有就绪')
      if (typeof args.description !== 'string' || typeof args.prompt !== 'string') throw new Error('子任务说明无效')
      return ctx.engine.delegate(id, { description: args.description, prompt: args.prompt }, signal)
    },
  })
}
