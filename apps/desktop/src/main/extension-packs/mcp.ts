// 扩展里的 MCP 连接器（contributes.mcpServers，docs/ui/extension-remaining-plan.md §G）：
// 不复制进「插件配置」，启动会话时从生效的扩展里取（和扩展技能一样，停用 / 卸载 / 停用名单自动生效）。
// 要用户同意过「这一份」启动方式才用：记下同意时的指纹，更新改了命令、参数、地址、要填的值、来源就要重新同意。
// 同意记录和用户填的值按扩展 id 存在 SecureStore（系统加密；不可用时只在内存里，重启后要重新同意）。
import { createHash } from 'node:crypto'
import type { ExtMcpServer, ExtPackInfo, ExtPackMcpStatus, McpConfig } from '@pixelsky/protocol'
import { SecureStore, type Cipher } from '../core/secure-store'
import type { LoadedPack } from './loader'

const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g

/** 审核过的那些字段的指纹：任何一项变了都要重新同意 */
export function mcpFingerprint(s: ExtMcpServer): string {
  const inputs = (s.inputs ?? []).map(i => [i.name, i.secret === true, i.required === true])
  return createHash('sha256')
    .update(JSON.stringify([s.type, s.command ?? null, s.args ?? [], s.url ?? null, s.headers ?? {}, inputs, s.source]))
    .digest('hex')
    .slice(0, 32)
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_, name: string) => values[name] ?? '')
}

/** 一条连接器 + 用户填的值 → 交给引擎的配置；stdio 时填的值也作为同名环境变量 */
export function mcpConfigOf(s: ExtMcpServer, values: Record<string, string>): McpConfig {
  if (s.type === 'stdio')
    return {
      type: 'stdio',
      command: s.command!,
      args: (s.args ?? []).map(a => fill(a, values)),
      env: Object.fromEntries((s.inputs ?? []).filter(i => values[i.name]).map(i => [i.name, values[i.name]])),
    }
  return {
    type: s.type,
    url: fill(s.url!, values),
    headers: Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) => [k, fill(v, values)])),
  }
}

const OK = 'ok:'
const VALUE = 'v:'

export class PackMcp {
  private readonly store: SecureStore

  constructor(file: string, cipher: Cipher) {
    this.store = new SecureStore(file, cipher)
  }

  private saved(id: string): Readonly<Record<string, string>> {
    return this.store.get(id) ?? {}
  }

  private values(id: string, server: string): Record<string, string> {
    const prefix = `${VALUE}${server}:`
    return Object.fromEntries(
      Object.entries(this.saved(id))
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k.slice(prefix.length), v]),
    )
  }

  /** 这个扩展每条连接器的状态；没有连接器时 undefined（不往状态里加字段） */
  status(info: ExtPackInfo): ExtPackMcpStatus[] | undefined {
    const list = info.manifest?.contributes.mcpServers
    if (!info.id || !list?.length) return undefined
    const saved = this.saved(info.id)
    return list.map(s => {
      const values = this.values(info.id!, s.name)
      return {
        name: s.name,
        approved: saved[OK + s.name] === mcpFingerprint(s),
        missing: (s.inputs ?? []).filter(i => i.required && !values[i.name]).map(i => i.name),
        filled: (s.inputs ?? []).filter(i => values[i.name]).map(i => i.name),
      }
    })
  }

  /**
   * 同意 / 撤销一条连接器，顺便改填的值：values 里 null = 不动，'' = 清掉，其他 = 新值；只收 inputs 里声明过的名字。
   * 同意记的是当前清单那一份的指纹
   */
  set(id: string, server: ExtMcpServer, approved: boolean, values: Record<string, string | null>): void {
    const next: Record<string, string> = { ...this.saved(id) }
    if (approved) next[OK + server.name] = mcpFingerprint(server)
    else delete next[OK + server.name]
    const declared = new Set((server.inputs ?? []).map(i => i.name))
    for (const [name, value] of Object.entries(values)) {
      if (!declared.has(name) || value === null) continue
      const key = `${VALUE}${server.name}:${name}`
      if (value === '') delete next[key]
      else next[key] = value
    }
    this.store.set(id, next)
  }

  /** 这个 id 的扩展都卸掉了：同意记录和填的值一起删 */
  forget(id: string): void {
    this.store.remove(id)
  }

  /**
   * 给引擎的连接器：只看生效的扩展（调用方已过滤 live）、没被校验停用的那几条、同意过当前这一份、必填都填了的。
   * 同名的先到先得（调用方的「插件配置」里同名的再盖过它们）。key 只含哈希，不带填的值
   */
  launch(packs: LoadedPack[]): { key: string; servers: Record<string, McpConfig> } {
    const servers: Record<string, McpConfig> = {}
    for (const pack of packs) {
      const id = pack.info.id
      const list = pack.info.manifest?.contributes.mcpServers
      if (!id || !list) continue
      const off = pack.info.inactive.mcpServers ?? []
      const saved = this.saved(id)
      list.forEach((s, i) => {
        if (off.includes(i) || s.name in servers || saved[OK + s.name] !== mcpFingerprint(s)) return
        const values = this.values(id, s.name)
        if ((s.inputs ?? []).some(input => input.required && !values[input.name])) return
        servers[s.name] = mcpConfigOf(s, values)
      })
    }
    const names = Object.keys(servers)
    if (!names.length) return { key: '', servers }
    const key = createHash('sha256').update(JSON.stringify(servers)).digest('hex').slice(0, 16)
    return { key, servers }
  }
}
