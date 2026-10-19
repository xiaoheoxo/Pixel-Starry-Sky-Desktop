// 桌面端管理的 MCP 服务器（设置 › 插件）：适配器把这次会话生效的服务器写进一个临时文件，路径放在 PIXELSKY_MCP_FILE。
// 文件格式和 Claude Code 的 --mcp-config 一样：{ mcpServers: { 名字: { type, command, args, env, url, headers } } }，
// 值都是桌面端展开过的原文。这里用 pi.registerMcpServer() 交给 Pi 自带的 MCP 支持（见 Pi 包自带文档里的 mcp.md）；
// 用户自己的 ~/.pixelsky-cli/agent/mcp.json 照常生效，同名时以它为准（Pi 的规则）。
// 连接状态：Pi 的 MCP 扩展（我们的补丁）在状态变化时发 pixelsky:mcp-status，这里转成 setStatus('pixelsky-mcp', JSON)
// 交给桌面端右侧「连接器」；桌面端发 /pixelsky-mcp <status|reconnect|enable|disable|login> [名字] 做操作（docs/ui/connectors.md）。
// login 回的是授权链接（桌面端在浏览器里打开），本机回调端口由 Pi 等着，登录完自己重新连接。
// 只用可擦除的 TS 语法。
import { readFileSync } from 'node:fs'
import type { ExtensionAPI, ExtensionContext, McpServerConfig } from '@earendil-works/pi-coding-agent'

export const MCP_FILE_ENV = 'PIXELSKY_MCP_FILE'
/** 状态键和命令名（packages/engine/src/pixel/session.ts 的 MCP_STATUS / MCP_COMMAND） */
export const MCP_STATUS = 'pixelsky-mcp'
export const MCP_COMMAND = 'pixelsky-mcp'
/** 操作结果的状态键：{ op, name, error } */
export const MCP_RESULT_STATUS = 'pixelsky-mcp-result'
const MCP_OPS = ['status', 'reconnect', 'enable', 'disable', 'login']
const OP_TIMEOUT_MS = 90_000

type Json = Record<string, unknown>
const object = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Pi 会展开 env / headers 值里的 $VAR、${VAR}，开头是 ! 的当成命令执行。桌面端给的是原文，
 * 照 Pi 的转义写法（$$ 是 $，$! 是 !）原样保住，免得密钥里的 $ 被换掉、或者 ! 开头的值被当命令跑
 */
export function literalValue(value: string): string {
  const escaped = value.replace(/\$/g, '$$$$')
  return escaped.startsWith('!') ? '$' + escaped : escaped
}

function literalMap(raw: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(object(raw))
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k, literalValue(v as string)]),
  )
}

/** Pi 的服务器名只能有字母、数字、_、-（桌面端还允许点） */
export function piServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** 桌面端的配置 → Pi 的配置；不支持的（SSE）和不完整的放进 skipped，带上原因 */
export function piMcpServers(raw: unknown): { servers: Record<string, McpServerConfig>; skipped: string[] } {
  const servers: Record<string, McpServerConfig> = {}
  const skipped: string[] = []
  for (const [name, value] of Object.entries(object(object(raw).mcpServers))) {
    const c = object(value)
    if (c.type === 'sse') {
      skipped.push(
        `MCP 服务器 ${name} 用的是 SSE，像素星空命令行只支持 stdio 和 HTTP，已跳过 / MCP server ${name} uses SSE, which the PixelSky CLI does not support; skipped.`,
      )
      continue
    }
    const key = piServerName(name)
    if (text(c.url)) servers[key] = { url: text(c.url), headers: literalMap(c.headers) }
    else if (text(c.command))
      servers[key] = {
        command: text(c.command),
        args: (Array.isArray(c.args) ? c.args : []).filter(a => typeof a === 'string') as string[],
        env: literalMap(c.env),
      }
    else
      skipped.push(`MCP 服务器 ${name} 没有命令也没有地址，已跳过 / MCP server ${name} has no command or URL; skipped.`)
  }
  return { servers, skipped }
}

/**
 * 文件路径第一次读到后就从进程环境里拿掉：模型跑的命令继承进程环境，不该顺手看到这个（里面有密钥）。
 * 重新加载扩展（/reload，注册要重做）和子智能体（mcpChildEnv）用记下来的值
 */
let mcpFile: string | undefined

/** 子智能体子进程要带上的环境变量 */
export function mcpChildEnv(): Record<string, string> {
  return mcpFile ? { [MCP_FILE_ENV]: mcpFile } : {}
}

/** 把 Pi MCP 扩展的连接状态转给桌面端，接桌面端的操作命令 */
function statusBridge(pi: ExtensionAPI): void {
  let ui: ExtensionContext['ui'] | null = null
  let latest = '[]'
  const push = (): void => ui?.setStatus(MCP_STATUS, latest)
  pi.events.on('pixelsky:mcp-status', data => {
    latest = JSON.stringify(Array.isArray(data) ? data : [])
    push()
  })
  pi.on('session_start', async (_event, ctx) => {
    ui = ctx.ui
    push()
  })
  pi.registerCommand(MCP_COMMAND, {
    description: 'Desktop app: MCP server status and actions (status | reconnect | enable | disable | login <server>)',
    handler: async (args, ctx) => {
      ui = ctx.ui
      const [op = 'status', name] = args.trim().split(/\s+/).filter(Boolean)
      if (!MCP_OPS.includes(op)) {
        ctx.ui.notify(`未知的操作 "${op}" / Unknown action "${op}".`, 'error')
        return
      }
      // 结果走状态键交回桌面端（不进对话）；Pi 的 MCP 扩展没加载时不会回应，过一会儿当作没有连接器
      const { failure, url } = await Promise.race([
        new Promise<{ failure?: string; url?: string }>(resolve =>
          pi.events.emit('pixelsky:mcp-op', {
            op,
            name,
            done: (failure?: string, url?: string) => resolve({ failure, url }),
          }),
        ),
        new Promise<{ failure?: string; url?: string }>(resolve =>
          setTimeout(() => resolve({}), OP_TIMEOUT_MS).unref?.(),
        ),
      ])
      ctx.ui.setStatus(
        MCP_RESULT_STATUS,
        JSON.stringify({ op, name: name ?? '', error: failure ?? '', ...(url ? { url } : {}) }),
      )
    },
  })
}

export function mcpExtension(pi: ExtensionAPI): void {
  statusBridge(pi)
  mcpFile ??= process.env[MCP_FILE_ENV]?.trim() || undefined
  delete process.env[MCP_FILE_ENV]
  const file = mcpFile
  if (!file) return
  const problems: string[] = []
  try {
    const { servers, skipped } = piMcpServers(JSON.parse(readFileSync(file, 'utf8')))
    problems.push(...skipped)
    for (const [name, config] of Object.entries(servers)) {
      try {
        pi.registerMcpServer(name, config)
      } catch (error) {
        problems.push(`MCP 服务器 ${name} 没能加上 / Could not add MCP server ${name}: ${(error as Error).message}`)
      }
    }
  } catch (error) {
    problems.push(`读不到桌面端的 MCP 配置 / Could not read the MCP servers from the app: ${(error as Error).message}`)
  }
  if (!problems.length) return
  pi.on('session_start', async (_event, ctx) => {
    for (const problem of problems.splice(0)) ctx.ui.notify(problem, 'warning')
  })
}
