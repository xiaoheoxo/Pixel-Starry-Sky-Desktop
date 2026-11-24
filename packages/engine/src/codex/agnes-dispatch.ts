import { createServer } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Launcher } from '../adapter'
import { run } from '../exec'
import { array, object, string } from './process'

const AGNES_PLUGIN = 'pixelsky-agnes-dispatch'
const AGNES_MARKETPLACE = 'pixelsky-agnes-builtin'
const AGNES_PLUGIN_ID = `${AGNES_PLUGIN}@${AGNES_MARKETPLACE}`
const AGNES_DISPATCH_MATCHER = '^(collaboration[.:])?(spawn_agent|Agent)$'
const pending = new Map<string, Promise<void>>()

/** Native CLI owns plugin state. PixelSky never installs third-party source or marks hooks trusted. */
export function registerBundledDispatch(
  launcher: Launcher,
  env: NodeJS.ProcessEnv,
  bundle: string,
  exec: typeof run = run,
): Promise<void> {
  let root: string
  try {
    root = realpathSync(bundle)
  } catch {
    return Promise.reject(new Error('像素星空安装中缺少 Agnes 内置组件。'))
  }
  const version = () =>
    string(object(JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8'))).version)
  const key = JSON.stringify([launcher, env.CODEX_HOME ?? join(homedir(), '.codex'), root])
  const earlier = pending.get(key)
  if (earlier) return earlier

  const command = async (...args: string[]): Promise<Record<string, unknown>> => {
    const result = await exec(launcher, ['plugin', ...args, '--json'], env, 8_000, { cwd: dirname(root) })
    if (!result.ok) throw new Error('当前 Codex 无法注册内置组件，请更新 Codex 后重试。')
    try {
      return object(JSON.parse(result.stdout))
    } catch {
      throw new Error('当前 Codex 未返回可识别的插件状态。')
    }
  }
  const register = async () => {
    const listed = (await command('marketplace', 'list')).marketplaces
    if (!Array.isArray(listed)) throw new Error('当前 Codex 未返回可识别的市场列表。')
    const existing = listed.map(object).find(m => m.name === AGNES_MARKETPLACE)
    if (!existing) {
      const added = await command('marketplace', 'add', root)
      if (added.marketplaceName !== AGNES_MARKETPLACE) throw new Error('Agnes 内置市场标识不匹配。')
    } else {
      const source = object(existing.marketplaceSource)
      let location = ''
      try {
        location = realpathSync(string(existing.root))
      } catch {
        // Refuse replacing an existing marketplace, including stale or custom registrations.
      }
      // Some Codex versions list local marketplaces with only name and root.
      const localOrUnspecified = existing.marketplaceSource === undefined || source.sourceType === 'local'
      if (!localOrUnspecified || location !== root)
        throw new Error('Codex 中的 Agnes 内置市场指向另一位置，请移除旧注册后重新打开此会话。')
    }
    const installed = (await command('list')).installed
    if (!Array.isArray(installed)) throw new Error('当前 Codex 未返回可识别的插件列表。')
    const plugin = installed.map(object).find(p => p.pluginId === AGNES_PLUGIN_ID)
    if (plugin && plugin.enabled !== true) throw new Error('Agnes 内置组件在 Codex 中已停用。')
    const expectedVersion = version()
    if (!plugin || plugin.version !== expectedVersion) {
      const added = await command('add', AGNES_PLUGIN_ID)
      if (added.pluginId !== AGNES_PLUGIN_ID || added.version !== expectedVersion)
        throw new Error('Agnes 内置组件标识或版本不匹配。')
    }
  }
  const work = register().finally(() => pending.delete(key))
  pending.set(key, work)
  return work
}
export type DispatchMode = 'suggest' | 'force'
export interface DispatchRequest {
  threadId: string
  turnId: string
  task: string
}
export type DispatchDecision = { model: string; effort?: string; marker?: string } | { reason: string }

export function trustedDispatchHook(value: unknown): boolean {
  return array(object(value).data).some(entry =>
    array(object(entry).hooks).some(raw => {
      const hook = object(raw)
      return (
        hook.source === 'plugin' &&
        hook.pluginId === AGNES_PLUGIN_ID &&
        hook.eventName === 'preToolUse' &&
        hook.enabled === true &&
        (hook.trustStatus === 'trusted' || hook.trustStatus === 'managed') &&
        hook.matcher === AGNES_DISPATCH_MATCHER
      )
    }),
  )
}

/** A per-session, loopback-only callback. No Codex credentials, transcript, or file access in the plugin. */
export async function startDispatchBridge(
  route: (input: DispatchRequest, signal: AbortSignal) => Promise<DispatchDecision>,
): Promise<{ env: NodeJS.ProcessEnv; close: () => void }> {
  const secret = Buffer.from('Bearer ' + randomUUID() + randomUUID())
  const server = createServer(async (req, res) => {
    const authorization = Buffer.from(req.headers.authorization ?? '')
    if (
      req.method !== 'POST' ||
      req.url !== '/agnes' ||
      authorization.length !== secret.length ||
      !timingSafeEqual(authorization, secret)
    ) {
      res.writeHead(403).end()
      return
    }
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    const respond = (decision: DispatchDecision) => {
      if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(decision))
    }
    try {
      let body = ''
      for await (const chunk of req) {
        body += String(chunk)
        if (body.length > 20_000) {
          respond({ reason: 'Agnes dispatch payload is too large.' })
          return
        }
      }
      const data = object(JSON.parse(body))
      const threadId = string(data.threadId),
        turnId = string(data.turnId),
        task = string(data.task)
      if (!threadId || !turnId || !task.trim()) {
        respond({ reason: 'Agnes requires the native thread, turn, and delegated task.' })
        return
      }
      respond(await route({ threadId, turnId, task: task.slice(0, 4000) }, abort.signal))
    } catch {
      respond({ reason: 'Agnes could not evaluate this dispatch.' })
    }
  })
  server.requestTimeout = 20_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Agnes could not open its local dispatch router')
  }
  server.unref()
  return {
    env: {
      PIXELSKY_AGNES_URL: `http://127.0.0.1:${address.port}/agnes`,
      PIXELSKY_AGNES_AUTH: secret.toString(),
    },
    close: () => {
      server.close()
      server.closeAllConnections()
    },
  }
}
