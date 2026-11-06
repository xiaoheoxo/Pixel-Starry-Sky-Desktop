// 频道工具 MCP 服务 pixelsky_channel（docs/ui/channels-collab-v2.md §1）：只挂给频道派活的本机会话，
// 让 AI 自己翻频道记录、读讨论串、在串里回复、提议派活，频道允许互相派活时直接交接。
// 实现在 core/channels/service.ts（toolRead 等），HTTP 部分和 pixelsky_threads 一样走 engine/local-mcp.ts，令牌决定调用方是哪个会话。
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { SessionRecord } from '@pixelsky/protocol'
import type { Channels } from '../core/channels/service'
import type { AgentTools } from '../../shared/types/channels'
import { machineOf } from '../machines/identity'
import {
  READ_ONLY,
  integer,
  localMcpHttp,
  toolText as text,
  type LocalMcpEntry,
  type ToolArgs,
} from '../engine/local-mcp'

export const CHANNEL_SERVER_NAME = 'pixelsky_channel'

/** 发消息、派活的工具：不是只读，但只在频道里留记录，不用每次等用户批准 */
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
/** 流程里交付、提问的工具：只在频道里记一笔、不碰工作区，标成只读，拟计划的会话在计划模式里也能直接用 */
const RECORD = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }

const TOOLS = [
  {
    name: 'channel_read',
    description:
      '读你所在协作频道主时间线的消息（从旧到新）：真人和 AI 成员的消息、任务卡（谁交给谁、标题、状态）、提议。默认最近 20 条；给 before（某条消息的 id）往前翻。派活时只带了最近几条，要更早的背景时用。',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string', description: '只读这条消息之前的，不填时读最新的' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '读几条，默认 20' },
      },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'thread_read',
    description:
      '读某张任务卡或某条消息的讨论串：用户的追加要求和留言、别的成员的回复、结果。不给 id 时读你现在这项活的串。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务卡或消息的 id（channel_read 给出的），可不填' } },
    },
    annotations: READ_ONLY,
  },
  {
    name: 'channel_reply',
    description:
      '在你现在这项活的讨论串里写一句：进展、发现的问题、想让用户知道的事。只发在串里，不上主时间线、不派活、不 @ 人。最后的结果不用发，做完后会自动发回频道。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, description: '要写的内容，支持 Markdown' } },
      required: ['text'],
    },
    annotations: WRITE,
  },
  {
    name: 'task_propose',
    description:
      '提议把一项活交给频道里的另一个 AI 成员：频道里出现一张提议卡，用户点「派出去」才派。适合发现了别人更适合做的事。提议后不用等，接着做你自己的活。',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', minLength: 1, description: 'AI 成员的名字' },
        request: { type: 'string', minLength: 1, description: '要他做什么，写清楚需要的背景' },
      },
      required: ['member', 'request'],
    },
    annotations: WRITE,
  },
  {
    name: 'task_handover',
    description:
      '直接把一部分活交给频道里的另一个 AI 成员（只有频道打开了「允许 AI 成员互相派活」才能用，否则用 task_propose）。次数算进频道的接力规则，超了会停下等用户放行。交给他后你可以接着做自己的部分。',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', minLength: 1, description: 'AI 成员的名字' },
        request: { type: 'string', minLength: 1, description: '要他做什么，写清楚需要的背景' },
      },
      required: ['member', 'request'],
    },
    annotations: WRITE,
  },
  {
    name: 'task_done',
    description:
      '流程里的一步确实做完了：交付这一步（摘要、改了哪些文件），流程才会往下走。审查步骤要写 verdict（pass 通过 / reject 打回）、打回时 issues 列出问题；让你拆流程的活：要先问用户就只交 questions（一次问完），否则用 steps 交回拆好的步骤、brief 交回要点。只有流程里的活能用，一轮只算第一次。',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, description: '一两句话：做了什么、结论是什么' },
        title: { type: 'string', description: '拆流程时：给计划起的短名字（20 字以内），不要照抄需求原话' },
        files: { type: 'array', items: { type: 'string' }, description: '你改了哪些文件（相对路径），可不填' },
        open: {
          type: 'array',
          items: { type: 'string' },
          description: '还没做完、没验证到的，一条一项（最多 10 条），可不填；后面的步骤和汇总会看到',
        },
        verdict: { type: 'string', enum: ['pass', 'reject'], description: '审查步骤：通过或打回' },
        issues: { type: 'array', items: { type: 'string' }, description: '打回时的问题，一条一个，要具体到能照着改' },
        steps: {
          type: 'array',
          description: '拆流程时：拆好的步骤（最多 9 步）',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '这一步做什么' },
              member: { type: 'string', description: '谁做（成员名字）' },
              deps: { type: 'array', items: { type: 'integer' }, description: '要先交付的步骤序号（从 1 数）' },
              kind: { type: 'string', enum: ['work', 'review', 'summary'] },
              target: { type: 'integer', description: 'review：审第几步' },
              effort: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'xhigh'],
                description: '这一步建议的推理强度',
              },
            },
            required: ['title', 'member'],
          },
        },
        brief: {
          type: 'object',
          description: '拆流程时：要点。goal 一句话目标；facts 用户已经说定的；open 开工前还要人定的',
          properties: {
            goal: { type: 'string' },
            facts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  k: { type: 'string', description: '哪一项' },
                  v: { type: 'string', description: '定了什么' },
                  suggested: { type: 'boolean', description: '是你替用户定的' },
                },
                required: ['k', 'v'],
              },
            },
            open: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  q: { type: 'string', description: '要定什么（可以带上你建议的默认值）' },
                  required: { type: 'boolean', description: '不定就不能开工' },
                },
                required: ['q'],
              },
            },
          },
        },
        questions: {
          type: 'array',
          description: '拆流程时先问用户（不写 steps）：一次问完，最多 6 个',
          items: {
            type: 'object',
            properties: {
              q: { type: 'string', description: '要用户定什么' },
              options: { type: 'array', items: { type: 'string' }, description: '2–4 个简短选项，可不填' },
            },
            required: ['q'],
          },
        },
      },
      required: ['summary'],
    },
    annotations: RECORD,
  },
  {
    name: 'member_ask',
    description:
      '流程里需要别的成员提供东西（它做的那一步的细节、一个决定）时问它，不用用户批准。问完结束这一轮，回答来了会作为新消息发给你；对方正在做时等它这一轮做完再答。次数算进频道的接力规则。',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', minLength: 1, description: 'AI 成员的名字' },
        question: { type: 'string', minLength: 1, description: '要问什么，写清楚背景' },
      },
      required: ['member', 'question'],
    },
    annotations: RECORD,
  },
  {
    name: 'user_ask',
    description:
      '流程里的一步缺了只有用户能定的信息（影响结果、又推不出来）时问用户。问完结束这一轮；流程卡上会让用户回答，回答来了会作为新消息发给你。不依赖它的部分可以先做。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, description: '要问什么；能给选项或建议值就给' },
      },
      required: ['question'],
    },
    annotations: RECORD,
  },
  {
    name: 'attachment_read',
    description:
      '读频道里的图片和文件附件：不给 id 时读你现在这项活带的（包括你收到的要求和原始需求里的）；给 id 读那条消息或任务卡的。要看图一律用它，不要开电脑控制、截屏或打开窗口去看。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '消息或任务卡的 id（channel_read 给出的），可不填' } },
    },
    annotations: READ_ONLY,
  },
].map(tool => ({
  ...tool,
  annotations: { title: tool.name, ...tool.annotations },
  // Claude 默认把 MCP 工具藏在 ToolSearch 后面，模型会以为没有 task_done（已对 2.1.319 实测）
  _meta: { 'anthropic/alwaysLoad': true },
}))

const INSTRUCTIONS =
  '你是像素星空协作频道里的 AI 成员。channel_read / thread_read 查频道记录；channel_reply 在你这项活的串里写进展；' +
  'task_propose 提议给别的成员派活（用户决定）；频道允许时 task_handover 直接交接。' +
  '流程里的一步：做完调用 task_done 交付，需要别的成员提供东西用 member_ask，要用户拍板的用 user_ask。' +
  '要看频道里的图片和附件用 attachment_read，不要开电脑控制、截屏去看。不能删消息、改频道设置、给别的频道发消息。'

const str = (args: ToolArgs, key: string, required = false): string | undefined => {
  const value = args[key]
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`缺少参数 ${key}（字符串）`)
    return undefined
  }
  if (typeof value !== 'string') throw new Error(`参数 ${key} 必须是字符串`)
  return value
}

function mcpServer(channels: () => Channels | null, sessionId: string): Server {
  const server = new Server(
    { name: CHANNEL_SERVER_NAME, version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const c = channels()
      if (!c) return text('频道还没有就绪，稍后再试。', true)
      const args = (request.params.arguments ?? {}) as ToolArgs
      switch (request.params.name) {
        case 'channel_read':
          return text(c.toolRead(sessionId, { before: str(args, 'before'), limit: integer(args, 'limit') }))
        case 'thread_read':
          return text(c.toolThread(sessionId, str(args, 'id')))
        case 'channel_reply':
          return text(await c.toolReply(sessionId, str(args, 'text', true)!))
        case 'task_propose':
          return text(await c.toolPropose(sessionId, str(args, 'member', true)!, str(args, 'request', true)!))
        case 'task_handover':
          return text(await c.toolHandover(sessionId, str(args, 'member', true)!, str(args, 'request', true)!))
        case 'task_done':
          return text(c.toolDone(sessionId, args))
        case 'member_ask':
          return text(await c.toolAsk(sessionId, str(args, 'member', true)!, str(args, 'question', true)!))
        case 'user_ask':
          return text(await c.toolUserAsk(sessionId, str(args, 'question', true)!))
        case 'attachment_read': {
          const read = await c.toolAttachments(sessionId, str(args, 'id'))
          return {
            content: [
              { type: 'text' as const, text: read.text },
              ...read.images.map(i => ({ type: 'image' as const, data: i.dataBase64, mimeType: i.mediaType })),
            ],
          }
        }
        default:
          return text(`没有这个工具：${request.params.name}`, true)
      }
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true)
    }
  })
  return server
}

export interface ChannelToolsServer {
  /** 本机的频道会话：成员的扩展设置（跟随全局时 tools 为 null）和频道工具的地址、令牌；不是频道会话时 null */
  forSession(record: SessionRecord): Promise<{ tools: AgentTools | null; entry: LocalMcpEntry | null } | null>
  /** 频道派活的会话（任何机器上的）：会话自己的「做完自动检查」不重复跑，由频道写在任务卡上 */
  ownsSession(sessionId: string): boolean
  close(): void
}

export function channelToolsServer(channels: () => Channels | null): ChannelToolsServer {
  const http = localMcpHttp(sessionId => mcpServer(channels, sessionId))
  return {
    async forSession(record) {
      if (machineOf(record.id) !== 'local') return null
      const member = channels()?.sessionMember(record.id)
      if (!member) return null
      return { tools: member.tools, entry: await http.entry(record.id) }
    },
    ownsSession: sessionId => channels()?.ownsSession(sessionId) ?? false,
    close: () => http.close(),
  }
}
