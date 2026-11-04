// 脚本权限的同意记录和每个扩展的键值存储（docs/ui/extension-commands-plan.md §6）。都放在 extension-packs 数据目录，跟扩展 id 走
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SCRIPT_LIMITS, ScriptCallError } from './api'

function readJson(file: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  renameSync(tmp, file)
}

export class ScriptConsent {
  private readonly grants: Record<string, string[]>

  constructor(private readonly file: string) {
    const raw = readJson(file)
    this.grants = Object.fromEntries(
      Object.entries(raw).filter(
        (e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every(p => typeof p === 'string'),
      ),
    )
  }

  granted(id: string): string[] {
    return this.grants[id] ?? []
  }

  /** 同意（只会加，不会把没申请的也写进去：调用方传清单里的） */
  grant(id: string, permissions: readonly string[]): void {
    this.grants[id] = [...new Set([...this.granted(id), ...permissions])]
    writeJson(this.file, this.grants)
  }

  revoke(id: string, permission: string): void {
    this.grants[id] = this.granted(id).filter(p => p !== permission)
    writeJson(this.file, this.grants)
  }

  forget(id: string): void {
    if (!(id in this.grants)) return
    delete this.grants[id]
    writeJson(this.file, this.grants)
  }
}

export class ScriptStorage {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`)
  }

  get(id: string, key: string): string | null {
    const data = readJson(this.file(id))
    const value = Object.hasOwn(data, key) ? data[key] : null
    return typeof value === 'string' ? value : null
  }

  set(id: string, key: string, value: string): void {
    const data = readJson(this.file(id))
    // __proto__ 这样的键：普通赋值会改原型、不会存进去
    Object.defineProperty(data, key, { value, enumerable: true, writable: true, configurable: true })
    if (JSON.stringify(data).length > SCRIPT_LIMITS.storageChars)
      throw new ScriptCallError('storage is full (5 MB per extension)')
    writeJson(this.file(id), data)
  }

  delete(id: string, key: string): void {
    const data = readJson(this.file(id))
    if (!Object.hasOwn(data, key)) return
    delete data[key]
    writeJson(this.file(id), data)
  }

  forget(id: string): void {
    rmSync(this.file(id), { force: true })
  }
}
