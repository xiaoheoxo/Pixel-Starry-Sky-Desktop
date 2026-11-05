import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { ExtensionCheck, McpConfig } from '@pixelsky/protocol'
import { engineEnv } from '@pixelsky/engine'

class TrackedStdioTransport extends StdioClientTransport {
  createdPid: number | null = null
  override async start(): Promise<void> {
    await super.start()
    this.createdPid = this.pid
  }
}

export function program(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? env.Path ?? '').split(delimiter).flatMap(dir => {
        const name = join(dir.replace(/^"|"$/g, ''), command)
        return process.platform === 'win32' && !extname(command)
          ? [name + '.exe', name + '.cmd', name + '.bat', name]
          : [name]
      })
  const found = candidates.find(p => {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  })
  if (!found) throw new Error(`找不到程序：${command}`)
  return found
}
export function launcher(command: string, args: string[], env: NodeJS.ProcessEnv): { command: string; args: string[] } {
  const path = program(command, env)
  if (/\.(cmd|bat)$/i.test(path)) {
    // npm 标准垫片可直接用 Node 启动；任意批处理必须显式配置解释器。
    // 取最后一个脚本：npm 自带的 npx.cmd 前面还有 npm-prefix.js（只打印目录就退出），真正运行的 npx-cli.js 在后面
    const source = requireRead(path)
    const match = [...source.matchAll(/["']?%(?:~dp0|dp0%)[\\/]([^"'\r\n]+?\.(?:js|cjs|mjs))["']/gi)].at(-1)
    const node = program('node', env)
    const script = match ? join(dirname(path), match[1]) : null
    if (!script || !existsSync(script)) throw new Error('批处理程序请填写明确的解释器与参数，例如 node 和脚本路径')
    return { command: node, args: [script, ...args] }
  }
  return { command: path, args }
}
import { readFileSync } from 'node:fs'
const requireRead = (path: string): string => readFileSync(path, 'utf8')
export function runProgram(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeout = 20000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const launch = launcher(command, args, env)
    execFile(
      launch.command,
      launch.args,
      { cwd, env, windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(error.killed ? '检测超时' : String(stderr || error.message).slice(0, 1200)))
        else resolve(String(stdout || stderr).trim())
      },
    )
  })
}
export async function checkMcp(
  config: McpConfig,
  cwd: string,
  timeout = 12000,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<ExtensionCheck> {
  const client = new Client({ name: 'pixelsky-check', version: '0.1.0' }),
    controller = new AbortController()
  const env = { ...engineEnv(baseEnv), ...(config.env ?? {}) }
  const transport =
    config.type === 'stdio'
      ? new TrackedStdioTransport({
          ...launcher(config.command!, config.args ?? [], env),
          cwd,
          env: Object.fromEntries(Object.entries(env).filter((x): x is [string, string] => typeof x[1] === 'string')),
          stderr: 'pipe',
        })
      : config.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(config.url!), {
            requestInit: { headers: config.headers, signal: controller.signal },
          })
        : new SSEClientTransport(new URL(config.url!), {
            requestInit: { headers: config.headers, signal: controller.signal },
            eventSourceInit: {
              fetch: (url, init) =>
                fetch(url, {
                  ...init,
                  headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...config.headers },
                  signal: controller.signal,
                }),
            },
          })
  let timer: NodeJS.Timeout | undefined
  try {
    const work = async (): Promise<ExtensionCheck> => {
      await client.connect(transport, { signal: controller.signal, timeout })
      const tools: Array<{ name: string; description: string }> = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { signal: controller.signal, timeout })
        tools.push(...page.tools.map(t => ({ name: t.name, description: t.description ?? '' })))
        cursor = page.nextCursor
        if (tools.length > 2000) throw new Error('工具列表过大')
      } while (cursor)
      return { status: 'connected', message: `连接成功，${tools.length} 个工具`, tools, at: Date.now() }
    }
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('连接检测超时'))
        }, timeout)
      }),
    ])
  } catch (error) {
    let message = (error as Error).message
    for (const value of Object.values({ ...config.env, ...config.headers }))
      if (value && value.length >= 4) message = message.split(value).join('••••')
    const code = (error as { code?: number }).code
    const auth = code === 401 || code === 403 || /401|403|unauthorized|authentication|oauth/i.test(message)
    return {
      status: auth ? 'auth' : 'error',
      message: auth ? '需要授权或登录，请检查请求头或服务登录配置' : message.slice(0, 1200),
      at: Date.now(),
    }
  } finally {
    if (timer) clearTimeout(timer)
    // Abort 会触发 SDK 自行关闭。保留本次创建的 PID 并等待真实退出，避免第二次 close 提前返回。
    const pid = transport instanceof TrackedStdioTransport ? transport.createdPid : null
    controller.abort()
    await client.close().catch(() => undefined)
    await transport.close().catch(() => undefined)
    if (pid)
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0)
        } catch {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
  }
}
