// 通用的加密存储（docs/ui/custom-api.md §4.2）：一个文件，按 id 存若干字符串值，整份用系统加密写盘。
// 系统加密不可用时只放内存、不写明文；解不开的旧文件留着并备份，不覆盖成空的；
// 启动时加密不可用、旧文件没读的，之后能用了先读出来合并再写
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Cipher {
  available(): boolean
  encrypt(text: string): string
  decrypt(text: string): string
}

export class SecureStore {
  private data: Record<string, Record<string, string>> = {}
  warning: string | null = null
  private unreadable = false
  /** 构造时系统加密不可用，已有的文件还没读 */
  private unread = false

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {
    if (!existsSync(file)) return
    if (cipher.available()) this.load()
    else this.unread = true
  }

  /** 读出已有文件，和内存里的合并（内存里的更新，同 id 以内存为准） */
  private load(): void {
    this.unread = false
    try {
      const parsed: unknown = JSON.parse(this.cipher.decrypt(readFileSync(this.file, 'utf8')))
      if (parsed && typeof parsed === 'object')
        this.data = { ...(parsed as Record<string, Record<string, string>>), ...this.data }
    } catch {
      this.warning = '已有凭据无法解密，请重新填写；原加密文件保留。'
      this.unreadable = true
    }
  }

  /** 之前没读的旧文件：系统加密能用了就补读 */
  private catchUp(): void {
    if (this.unread && this.cipher.available()) {
      if (existsSync(this.file)) this.load()
      else this.unread = false
    }
  }

  get persistent(): boolean {
    return this.cipher.available()
  }

  get(id: string): Readonly<Record<string, string>> | undefined {
    this.catchUp()
    return this.data[id]
  }

  set(id: string, values: Record<string, string>): void {
    this.data[id] = { ...values }
    this.save()
  }

  remove(id: string): void {
    this.catchUp()
    if (!(id in this.data)) return
    delete this.data[id]
    this.save()
  }

  private save(): void {
    if (!this.persistent) return
    // 先合并旧文件再写，免得把它覆盖成只有这次改动的
    this.catchUp()
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = this.file + '.tmp'
    if (this.unreadable && existsSync(this.file)) {
      copyFileSync(this.file, this.file + '.unreadable-' + Date.now() + '.bak')
      this.unreadable = false
    }
    if (Object.keys(this.data).length === 0 && !existsSync(this.file)) return
    writeFileSync(temp, this.cipher.encrypt(JSON.stringify(this.data)), { mode: 0o600 })
    try {
      renameSync(temp, this.file)
    } catch (err) {
      rmSync(temp, { force: true })
      throw err
    }
  }
}
