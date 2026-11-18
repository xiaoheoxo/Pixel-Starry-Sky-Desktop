// Codex 经网关时的模型目录（docs/ui/context-settings-branch-switch.md §2.3.1，D173）：Codex 把 model_context_window
// 限制在模型资料的 max_context_window 以内，没有资料的模型（grok、glm……）上限只有 272000，还报「没有模型资料」。
// 需要时生成一份 model_catalog_json：自带目录（codex debug models --bundled）加上这个模型的一项。
// 没有资料的模型照 Codex 的默认资料，只改窗口；默认资料的提示词不在目录里，按版本实测一次（假服务记下第一条 developer 消息）
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Launcher } from '../adapter'
import { killTree, run, removeTree } from '../exec'
import { logger } from '../log'

const log = logger('engine.codex')

/** 目录里的一项：只认用到的几个字段，其余原样带上 */
export interface CatalogModel {
  slug: string
  context_window?: number | null
  max_context_window?: number | null
  [key: string]: unknown
}

/** Codex 默认资料的窗口（没有资料的模型） */
export const FALLBACK_WINDOW = 272_000

/**
 * 没有资料的模型：照 Codex 默认资料的一项（实测发出的请求和默认资料一致），只改窗口。
 * 字段是 Codex 0.163 的必填项；其余缺省值和默认资料一样
 */
export function fallbackEntry(slug: string, window: number, instructions: string): CatalogModel {
  return {
    slug,
    display_name: slug,
    context_window: window,
    max_context_window: window,
    supported_reasoning_levels: [],
    shell_type: 'default',
    visibility: 'none',
    supported_in_api: true,
    priority: 99,
    support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    experimental_supported_tools: [],
    base_instructions: instructions,
  }
}

/** 平台线路的 Ultrafast 档位（Codex 目录里 service_tiers 的一项）；Fast 一起声明，没有资料的模型原本两个都没有 */
const ULTRAFAST_TIER = { id: 'ultrafast', name: 'Ultrafast', description: 'Lowest latency; higher usage' }
const PRIORITY_TIER = { id: 'priority', name: 'Fast', description: 'Faster responses; higher usage' }

/** 给一项加上 Fast、Ultrafast 档位（已有的不重复、不改） */
export function withUltrafast(entry: CatalogModel): CatalogModel {
  const tiers = Array.isArray(entry.service_tiers) ? (entry.service_tiers as Array<{ id?: unknown }>) : []
  const has = (id: string): boolean => tiers.some(t => t && typeof t === 'object' && t.id === id)
  const speed = Array.isArray(entry.additional_speed_tiers) ? (entry.additional_speed_tiers as unknown[]) : []
  return {
    ...entry,
    service_tiers: [
      ...tiers,
      ...(has('priority') ? [] : [PRIORITY_TIER]),
      ...(has('ultrafast') ? [] : [ULTRAFAST_TIER]),
    ],
    additional_speed_tiers: speed.includes('fast') ? speed : [...speed, 'fast'],
  }
}

/**
 * 要不要生成目录、生成什么（纯函数）。window 是填的窗口，auto 是按系列自动定的：
 * - 自带目录里有这个模型：填的窗口大于它的上限才复制这一项改窗口，否则 null（只带 model_context_window 就够）；
 * - 没有：加一项默认资料，窗口取 填的 ?? 自动的 ?? 默认的 272000；没有提示词时 null（照现在用默认资料）
 * ultrafast：平台线路上这个模型能开 Ultrafast，这一项要声明 Fast、Ultrafast 档位（有资料的模型因此也要复制一份）
 */
export function catalogWith(
  bundled: readonly CatalogModel[],
  model: string,
  window: number | null,
  auto: number | null,
  instructions: string | null,
  ultrafast = false,
): { models: CatalogModel[] } | null {
  const tiers = (entry: CatalogModel): CatalogModel => (ultrafast ? withUltrafast(entry) : entry)
  const own = bundled.find(m => m.slug === model)
  if (own) {
    const max = own.max_context_window ?? own.context_window ?? FALLBACK_WINDOW
    const wider = !!window && window > max
    if (!wider && !ultrafast) return null
    const changed = tiers(wider ? { ...own, context_window: window, max_context_window: window } : own)
    return { models: bundled.map(m => (m === own ? changed : m)) }
  }
  if (!instructions) return null
  return { models: [...bundled, tiers(fallbackEntry(model, window ?? auto ?? FALLBACK_WINDOW, instructions))] }
}

/** 隔离的环境：空的临时 CODEX_HOME，不读用户的配置、不写用户的数据 */
function isolated(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, CODEX_HOME: home, PIXELSKY_CATALOG_KEY: 'x' }
  delete out.CODEX_SQLITE_HOME
  const noProxy = [out.NO_PROXY ?? out.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
  out.NO_PROXY = out.no_proxy = noProxy
  return out
}

/** 删临时目录：Codex 刚退出时 sqlite 可能还占着，失败就留给系统清理 */
function removeLater(dir: string): void {
  setTimeout(() => {
    try {
      removeTree(dir, { maxRetries: 3, retryDelay: 200 })
    } catch {
      // 临时目录，删不掉也不影响
    }
  }, 500).unref?.()
}

/** 自带目录（codex debug models --bundled）；旧版 Codex 没有这个命令、出错时 null */
export async function readBundledCatalog(launcher: Launcher, env: NodeJS.ProcessEnv): Promise<CatalogModel[] | null> {
  const home = mkdtempSync(join(tmpdir(), 'pixelsky-codex-catalog-'))
  try {
    const r = await run(launcher, ['debug', 'models', '--bundled'], isolated(env, home), 20_000)
    if (!r.ok) return null
    const parsed = JSON.parse(r.stdout) as { models?: unknown }
    if (!Array.isArray(parsed.models)) return null
    return parsed.models.filter(
      (m): m is CatalogModel => !!m && typeof m === 'object' && typeof (m as CatalogModel).slug === 'string',
    )
  } catch {
    return null
  } finally {
    removeLater(home)
  }
}

/**
 * Codex 默认资料的提示词：本机起一个假的 Responses 服务，用空的临时 CODEX_HOME 启动 app-server 发一句，
 * 记下请求里的第一条 developer 消息（就是默认资料的 base_instructions）。拿不到时 null
 */
export async function captureFallbackInstructions(
  launcher: Launcher,
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<string | null> {
  const home = mkdtempSync(join(tmpdir(), 'pixelsky-codex-catalog-'))
  let captured: string | null = null
  let finish!: () => void
  const done = new Promise<void>(resolve => (finish = resolve))
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', () => {
      try {
        const input = (JSON.parse(body) as { input?: unknown }).input
        const first = Array.isArray(input)
          ? (input as Array<{ role?: unknown; content?: Array<{ text?: unknown }> }>).find(x => x.role === 'developer')
          : undefined
        const text = first?.content?.[0]?.text
        if (typeof text === 'string' && text.trim()) captured = text
      } catch {
        // 不是我们要的请求
      }
      // 回一个出错，Codex 不再往下做
      res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":{"message":"probe"}}')
      finish()
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as { port: number }).port
    const provider = `{ name = "probe", base_url = "http://127.0.0.1:${port}/v1", wire_api = "responses", env_key = "PIXELSKY_CATALOG_KEY", request_max_retries = 0, stream_max_retries = 0 }`
    const child = spawn(
      launcher.command,
      [
        ...launcher.args,
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        `model_providers.probe=${provider}`,
        '-c',
        'model_provider="probe"',
        '-c',
        'model="pixelsky-probe-model"',
      ],
      { cwd: home, env: isolated(env, home), windowsHide: true, stdio: 'pipe' },
    )
    child.on('error', () => finish())
    child.on('exit', () => finish())
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})
    let buf = ''
    let threadId: string | null = null
    const send = (id: number, method: string, params: unknown): void => {
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    }
    child.stdout.on('data', (data: Buffer) => {
      buf += data.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let msg: { id?: number; result?: { thread?: { id?: string } } }
        try {
          msg = JSON.parse(line) as typeof msg
        } catch {
          continue
        }
        if (msg.id === 1) {
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
          send(2, 'thread/start', { cwd: home })
        } else if (msg.id === 2 && !threadId) {
          threadId = msg.result?.thread?.id ?? null
          if (!threadId) finish()
          else send(3, 'turn/start', { threadId, input: [{ type: 'text', text: 'hi' }] })
        }
      }
    })
    send(1, 'initialize', { clientInfo: { name: 'pixelsky-catalog', version: '0' } })
    const timer = setTimeout(finish, timeoutMs)
    await done
    clearTimeout(timer)
    killTree(child)
    return captured
  } catch (error) {
    log.info('capture codex fallback instructions failed', { error: (error as Error).message })
    return null
  } finally {
    server.close()
    removeLater(home)
  }
}

/**
 * 每个适配器一个：自带目录和默认提示词按 Codex 的路径和版本缓存（提示词另存到临时目录，重启应用不用再测）；
 * file() 返回要交给 model_catalog_json 的文件路径，不需要时 null
 */
export class CodexCatalog {
  private readonly cache = new Map<string, Promise<{ bundled: CatalogModel[] | null; instructions: string | null }>>()
  constructor(private readonly dir = join(tmpdir(), 'pixelsky-codex-catalog')) {}

  private sources(launcher: Launcher, version: string | null, env: NodeJS.ProcessEnv) {
    const key = createHash('sha256')
      .update(JSON.stringify([launcher.command, launcher.args, version]))
      .digest('hex')
      .slice(0, 16)
    let hit = this.cache.get(key)
    if (!hit) {
      hit = (async () => {
        const bundled = await readBundledCatalog(launcher, env)
        if (!bundled) return { bundled: null, instructions: null }
        const saved = join(this.dir, `instructions-${key}.txt`)
        let instructions: string | null = null
        try {
          instructions = readFileSync(saved, 'utf8') || null
        } catch {
          instructions = await captureFallbackInstructions(launcher, env)
          if (instructions)
            try {
              mkdirSync(this.dir, { recursive: true })
              writeFileSync(saved, instructions)
            } catch {
              // 存不下次再测
            }
        }
        return { bundled, instructions }
      })()
      this.cache.set(key, hit)
      // 失败了下次再试（Codex 正在更新、临时目录写不了）
      void hit.then(r => {
        if (!r.bundled) this.cache.delete(key)
      })
    }
    return hit
  }

  async file(
    launcher: Launcher,
    version: string | null,
    env: NodeJS.ProcessEnv,
    model: string,
    window: number | null,
    auto: number | null,
    ultrafast = false,
  ): Promise<string | null> {
    const { bundled, instructions } = await this.sources(launcher, version, env)
    if (!bundled) return null
    const catalog = catalogWith(bundled, model, window, auto, instructions, ultrafast)
    if (!catalog) return null
    const text = JSON.stringify(catalog)
    const path = join(this.dir, `catalog-${createHash('sha256').update(text).digest('hex').slice(0, 16)}.json`)
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(path, text)
      return path
    } catch (error) {
      log.warn('write codex catalog failed', { error: (error as Error).message })
      return null
    }
  }
}
