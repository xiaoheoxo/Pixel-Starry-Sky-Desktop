import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoreInstallRecord } from './market/types'

/** 测试用：临时目录放在仓库的 scratch/ 下，afterEach 里统一清掉 */
const SCRATCH = join(__dirname, '../../../../../scratch')
const made: string[] = []

export function tempDir(prefix = 'extpacks-'): string {
  mkdirSync(SCRATCH, { recursive: true })
  const dir = mkdtempSync(join(SCRATCH, prefix))
  made.push(dir)
  return dir
}

export function cleanTemp(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** 共享用例的底板文件夹（packages/protocol/corpus/extpacks/bases） */
export const FIXTURES = join(__dirname, '../../../../../packages/protocol/corpus/extpacks/bases')

/** 把 bases/<name> 复制成 <into>/<as ?? name>，返回目标目录 */
export function copyFixture(name: string, into: string, as: string = name): string {
  const target = join(into, as)
  cpSync(join(FIXTURES, name), target, { recursive: true })
  return target
}

/** 测试用：在 <storeDir>/<id>/ 下搭一份商店扩展（install.json 加解压后的目录），返回回执 */
export function installStoreFixture(
  storeDir: string,
  fixture: string,
  id: string,
  over: Partial<StoreInstallRecord> = {},
): StoreInstallRecord {
  const record: StoreInstallRecord = {
    id,
    version: '1.0.0',
    sha256: 'a'.repeat(64),
    size: 1,
    signature: 'c2ln',
    keyId: '8273f03a',
    site: 'https://auth.pixelstarrysky.xyz',
    dir: 'aaaaaaaaaaaaaaaa',
    installedAt: 1000,
    ...over,
  }
  copyFixture(fixture, join(storeDir, id), record.dir)
  writeFileSync(join(storeDir, id, 'install.json'), JSON.stringify(record))
  return record
}
