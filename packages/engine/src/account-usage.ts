import type { EngineAccountUsage } from '@pixelsky/protocol'

export const ACCOUNT_USAGE_TTL = 30_000

/** 每个适配器一份短缓存；配置变更和重新检测会丢弃旧账号数据，额度不落盘。 */
export class AccountUsageCache {
  private key: string | null = null
  private value: EngineAccountUsage | null = null
  private pending: Promise<EngineAccountUsage> | null = null
  private revision = 0

  constructor(private readonly notify?: (value: EngineAccountUsage) => void) {}

  reset(): void {
    this.key = null
    this.value = null
    this.pending = null
    this.revision++
  }

  private scope(key: string): void {
    if (this.key === key) return
    this.reset()
    this.key = key
  }

  push(key: string, value: EngineAccountUsage): void {
    this.scope(key)
    this.value = value
    this.revision++
    this.notify?.(value)
  }

  peek(key: string): EngineAccountUsage | null {
    return this.key === key ? this.value : null
  }

  read(key: string, fetch: () => Promise<EngineAccountUsage>, force = false): Promise<EngineAccountUsage> {
    this.scope(key)
    if (this.pending) return this.pending
    if (!force && this.value && !this.value.partial && Date.now() - this.value.observedAt < ACCOUNT_USAGE_TTL)
      return Promise.resolve(this.value)
    const revision = this.revision
    const pending = fetch()
      .catch((): EngineAccountUsage => ({ status: 'error', windows: [], observedAt: Date.now() }))
      .then(value => {
        if (this.key === key && revision === this.revision) this.push(key, value)
        return this.key === key ? (this.value ?? value) : value
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null
      })
    this.pending = pending
    return pending
  }
}

/** 仅用于内存里的配置指纹，绝不记录到日志。 */
export function accountUsageKey(command: unknown, args: unknown, env: NodeJS.ProcessEnv): string {
  return JSON.stringify([command, args, Object.entries(env).sort(([a], [b]) => a.localeCompare(b))])
}

export function usageFailure(error: unknown): EngineAccountUsage {
  const message = error instanceof Error ? error.message : String(error)
  return {
    status:
      /unknown.*(?:request|method|subtype)|method not found|not supported|unsupported|unrecognized|method.*-32601/i.test(
        message,
      )
        ? 'unsupported'
        : 'error',
    windows: [],
    observedAt: Date.now(),
  }
}
