// 系统代理补给本机引擎：Windows / macOS 开着「系统代理」（Clash 之类）时，浏览器和本软件自己的请求都走代理，
// 但 Claude Code、Codex、像素星空引擎只认 HTTPS_PROXY 这类环境变量，直接连外网会被拒（国内常见 403）。
// 这里按 Chromium 的规则（含 PAC）查出每个引擎要连的地址走什么代理，启动引擎时补上（packages/engine env.ts systemProxyEnv）。
// 只查本机，不联网；启动时查一次、之后每分钟查一次。开关存在 <userData>/system-proxy.json，默认开
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineId } from '@pixelsky/protocol'
import type { SystemProxyStatus } from '../../shared/types/system-proxy'

/** 每个引擎按它要连的地址查（PAC 可能对不同网站给不同的代理） */
const TARGETS: Record<EngineId, string> = {
  claude: 'https://api.anthropic.com',
  codex: 'https://api.openai.com',
  pixel: 'https://api.anthropic.com',
}
const FILE = 'system-proxy.json'
const REFRESH_MS = 60_000
const PROXY_KEY = /^(https?_proxy|all_proxy)$/i

export type ProxyRule = { kind: 'http'; url: string } | { kind: 'socks'; server: string } | null

/**
 * Chromium 的代理结果（如 "PROXY 127.0.0.1:7890; DIRECT"）：取第一个 HTTP / HTTPS 代理；
 * 只有 SOCKS 时报出来（Claude Code 不支持 SOCKS，不传）；DIRECT 或空是没开代理
 */
export function parseProxyRule(rule: string): ProxyRule {
  let socks: string | null = null
  for (const entry of rule.split(';')) {
    const [type, server] = entry.trim().split(/\s+/)
    if (!type || type.toUpperCase() === 'DIRECT') {
      if (type) break
      continue
    }
    if (!server) continue
    const upper = type.toUpperCase()
    if (upper === 'PROXY') return { kind: 'http', url: `http://${server}` }
    if (upper === 'HTTPS') return { kind: 'http', url: `https://${server}` }
    if (upper.startsWith('SOCKS')) socks ??= server
  }
  return socks ? { kind: 'socks', server: socks } : null
}

/** 进程自己的环境里已经有代理变量（用户在系统里设的）：引擎按用户的，不另外补 */
export const envHasProxy = (env: NodeJS.ProcessEnv): boolean =>
  Object.keys(env).some(k => PROXY_KEY.test(k) && env[k] !== undefined)

export interface SystemProxyOptions {
  /** Chromium 的代理查询（session.resolveProxy） */
  resolve: (url: string) => Promise<string>
  /** 存开关的目录（userData） */
  dir: string
  env?: NodeJS.ProcessEnv
  log?: (message: string, fields?: Record<string, unknown>) => void
}

export class SystemProxy {
  private enabled = true
  private rules: Partial<Record<EngineId, ProxyRule>> = {}
  private logged = ''
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly opts: SystemProxyOptions) {
    try {
      const raw = JSON.parse(readFileSync(join(opts.dir, FILE), 'utf8')) as { enabled?: unknown }
      if (typeof raw.enabled === 'boolean') this.enabled = raw.enabled
    } catch {
      // 没有文件或读不了：默认开
    }
  }

  /** 启动时查一次，之后每分钟查一次（用户可能随时开关代理软件） */
  start(): void {
    void this.refresh()
    this.timer ??= setInterval(() => void this.refresh(), REFRESH_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<void> {
    const next: Partial<Record<EngineId, ProxyRule>> = {}
    for (const engine of Object.keys(TARGETS) as EngineId[]) {
      next[engine] = await this.opts.resolve(TARGETS[engine]).then(parseProxyRule, () => null)
    }
    this.rules = next
    const summary = JSON.stringify(next.claude ?? null)
    if (summary !== this.logged) {
      this.logged = summary
      const rule = next.claude
      this.opts.log?.(
        rule?.kind === 'http' ? '系统代理' : rule?.kind === 'socks' ? '系统代理是 SOCKS，不传给引擎' : '系统没开代理',
        rule ? { proxy: rule.kind === 'http' ? rule.url : rule.server } : undefined,
      )
    }
  }

  /** 启动这个引擎时补的代理：开关开着、查到 HTTP 代理才有 */
  forEngine(engine: EngineId): string | null {
    const rule = this.rules[engine]
    return this.enabled && rule?.kind === 'http' ? rule.url : null
  }

  status(): SystemProxyStatus {
    const rule = this.rules.claude ?? null
    return {
      enabled: this.enabled,
      proxy: rule?.kind === 'http' ? rule.url : null,
      socks: rule?.kind === 'socks' ? rule.server : null,
      envSet: envHasProxy(this.opts.env ?? process.env),
    }
  }

  setEnabled(enabled: boolean): SystemProxyStatus {
    this.enabled = enabled
    try {
      writeFileSync(join(this.opts.dir, FILE), JSON.stringify({ enabled }))
    } catch {
      // 存不下：这次运行照样生效
    }
    return this.status()
  }
}
