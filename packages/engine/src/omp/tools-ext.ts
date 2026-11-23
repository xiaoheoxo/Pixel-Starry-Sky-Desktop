// 应用自己的工具（频道、对话历史、查看其他会话）挂进 oh-my-pi（docs/omp-engine.md §12.3）：它们是本机 MCP 服务。
// 放进 --plugin-dir 的话 omp 会挂成 bash 命令（名字认不出、计划档禁 bash），所以写一个扩展 -e 加载：
// 启动时列工具、注册成普通工具 mcp__<服务>__<工具>（和别的引擎同名），调用时直接请求本机服务。
// 只有这几个服务走这里；用户自己的 MCP 走插件目录（plugin-dir.ts）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** JSON：[{ name, url, token }]。扩展读到后马上从进程环境里拿掉，模型跑的命令看不到令牌 */
export const OMP_TOOLS_ENV = 'PIXELSKY_OMP_TOOLS'

/** 频道流程按会话认人：子智能体调了就算主智能体交付、提问，只留给主智能体（同 packages/cli/src/tools/subagent.ts） */
const PARENT_ONLY = ['task_done', 'member_ask', 'user_ask'].map(name => `mcp__pixelsky_channel__${name}`)

export const OMP_TOOLS_SOURCE = `// 像素星空写的文件，每次启动会覆盖。把应用自己的本机工具服务注册成 oh-my-pi 的工具
const PARENT_ONLY = new Set(${JSON.stringify(PARENT_ONLY)})
const LIST_TIMEOUT_MS = 10000

async function rpc(server, method, params, signal) {
  const res = await fetch(server.url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + server.token,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.json().catch(() => null)
  if (body && body.error) throw new Error(body.error.message || 'request failed')
  if (!res.ok || !body) throw new Error('HTTP ' + res.status)
  return body.result ?? {}
}

// 子智能体会把扩展再挂一份（同一个进程）：服务和工具表只读一次，整个进程共用
function load() {
  let servers = []
  try {
    servers = JSON.parse(process.env.${OMP_TOOLS_ENV} || '[]')
  } catch {}
  delete process.env.${OMP_TOOLS_ENV}
  const readOnly = new Set()
  const ready = Promise.all(
    servers.map(async server => {
      try {
        const { tools = [] } = await rpc(server, 'tools/list', {}, AbortSignal.timeout(LIST_TIMEOUT_MS))
        return tools.map(tool => {
          const name = 'mcp__' + server.name + '__' + tool.name
          if (tool.annotations?.readOnlyHint === true) readOnly.add(name)
          return { server, tool, name }
        })
      } catch {
        // 列不出来：这次启动没有这个服务的工具，不影响别的
        return []
      }
    }),
  ).then(lists => lists.flat())
  return { ready, readOnly }
}

export default async function pixelskyTools(pi) {
  const state = (globalThis.__pixelskyOmpTools ??= load())
  for (const { server, tool, name } of await state.ready) {
    pi.registerTool({
      name,
      label: server.name + ' · ' + tool.name,
      description: tool.description || tool.name,
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      // 只在应用里读、留记录，不碰工作区：不用每次问（同别的引擎的 allowTools）
      approval: 'read',
      loadMode: 'essential',
      async execute(_id, params, signal, _onUpdate, ctx) {
        if (PARENT_ONLY.has(name) && ctx?.agent?.kind === 'sub')
          throw new Error(name + ' can only be called by the main agent')
        const result = await rpc(server, 'tools/call', { name: tool.name, arguments: params ?? {} }, signal)
        const content = (result.content ?? []).filter(c => c.type === 'text' || c.type === 'image')
        if (result.isError) throw new Error(content.map(c => c.text ?? '').join('\\n') || 'tool failed')
        return { content, details: {} }
      },
    })
  }
}
`

/** 写到 dir 下（内容一样就不写），返回文件路径 */
export function writeOmpTools(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'pixelsky-tools.mjs')
  let current = ''
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // 还没有
  }
  if (current !== OMP_TOOLS_SOURCE) writeFileSync(file, OMP_TOOLS_SOURCE)
  return file
}
