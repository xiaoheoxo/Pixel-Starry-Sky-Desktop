import { readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isExtId } from '@pixelsky/protocol'
import { readStoreRecord } from './store-load'

// 启动时清理商店目录（docs/ui/extension-store-client.md §3.8）。在 loadStore 之前由 service 调用，
// 保证安装、卸载中途断电以后状态一致。删不掉的（文件被占用）跳过、写一行日志，下次启动再删。

type Log = (message: string) => void
type Rm = (path: string, opts: { recursive?: boolean; force?: boolean }) => Promise<void>

async function remove(path: string, rmFn: Rm, log: Log): Promise<void> {
  try {
    await rmFn(path, { recursive: true, force: true })
  } catch (e) {
    log(`cannot remove ${path}: ${(e as Error).message}`)
  }
}

/**
 * 1. store/.tmp/ 整个清空；
 * 2. store/<id>/ 里没有 install.json（或坏了）的：整个目录删掉——包括新装时目录改名之后、install.json 写好之前断电，
 *    和卸载时 install.json 已删、目录还没删完；
 * 3. install.json 指向的目录不在、但有同名的 `<dir>.old-*`（同一个包重装，旧目录改名之后断电）：改回来，不丢已装的版本；
 * 4. store/<id>/ 里除了 install.json 和它的 dir 以外的东西（旧版本、*.old-*、install.json.tmp-*）都删掉。
 */
export async function cleanStoreDir(storeDir: string, log: Log = () => {}, rmFn: Rm = rm): Promise<void> {
  await remove(join(storeDir, '.tmp'), rmFn, log)
  let names: string[]
  try {
    names = (await readdir(storeDir, { withFileTypes: true }))
      .filter(e => e.isDirectory() && isExtId(e.name))
      .map(e => e.name)
  } catch {
    return
  }
  for (const id of names) {
    const dir = join(storeDir, id)
    const record = readStoreRecord(storeDir, id)
    if (!record) {
      log(`store/${id}: no valid install.json, removing`)
      await remove(dir, rmFn, log)
      continue
    }
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (e) {
      log(`cannot read ${dir}: ${(e as Error).message}`)
      continue
    }
    if (!entries.includes(record.dir)) {
      const old = entries.filter(n => n.startsWith(`${record.dir}.old-`)).sort()[0]
      if (old) {
        try {
          await rename(join(dir, old), join(dir, record.dir))
          entries = entries.map(n => (n === old ? record.dir : n))
          log(`store/${id}: restored ${record.dir} from ${old}`)
        } catch (e) {
          log(`cannot restore ${old}: ${(e as Error).message}`)
        }
      }
    }
    if (!entries.includes(record.dir)) {
      log(`store/${id}: directory ${record.dir} is missing, removing`)
      await remove(dir, rmFn, log)
      continue
    }
    for (const name of entries)
      if (name !== 'install.json' && name !== record.dir) await remove(join(dir, name), rmFn, log)
  }
}

/** 卸载的最后一步：先删 install.json（这一刻起启动时不会再把它当已装），再删整个 store/<id>/；删不掉的留给下次启动 */
export async function removeStoreFiles(
  storeDir: string,
  id: string,
  log: Log = () => {},
  rmFn: Rm = rm,
): Promise<void> {
  const dir = join(storeDir, id)
  try {
    await rmFn(join(dir, 'install.json'), { force: true })
  } catch (e) {
    log(`cannot remove store/${id}/install.json: ${(e as Error).message}`)
  }
  await remove(dir, rmFn, log)
}
