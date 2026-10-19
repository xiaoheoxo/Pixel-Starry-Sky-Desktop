// 桌面端管理的 MCP 服务器（设置 › 插件）：适配器把这次会话生效的服务器写进一个临时文件，路径放在 PIXELSKY_MCP_FILE。
// 文件格式和 Claude Code 的 --mcp-config 一样：{ mcpServers: { 名字: { type, command, args, env, url, headers } } }，
// 值都是桌面端展开过的原文。这里用 pi.registerMcpServer() 交给 Pi 自带的 MCP 支持（Pi 文档 docs/mcp.md）；
// 用户自己的 ~/.pixelsky-cli/agent/mcp.json 照常生效，同名时以它为准（Pi 的规则）。
// 只用可擦除的 TS 语法。
import { readFileSync } from 'node:fs'
import type { ExtensionAPI, McpServerConfig } from '@earendil-works/pi-coding-agent'

export const MCP_FILE_ENV = 'PIXELSKY_MCP_FILE'

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

export function mcpExtension(pi: ExtensionAPI): void {
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
