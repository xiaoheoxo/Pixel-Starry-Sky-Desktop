import type { ExtPackInfo, ExtPackSource } from '@pixelsky/protocol'
import { computeLive, loaderIssue, packStatus } from '@pixelsky/protocol'
import { addPackIssue, type LoadedPack } from '../loader'

// 同 id 的优先级：开发中的文件夹 > 商店 > 内置（docs/ui/extension-store-client.md §3.4）。

const RANK: Record<ExtPackSource, number> = { folder: 3, store: 2, builtin: 1 }

/**
 * 每个 id 在「开着、没有错误、没被平台停用」的几份里选一份生效，顺序是文件夹 > 商店 > 内置（同级先到先得）。
 * 返回 key → 生效那一份的来源，只含没生效的那几份（同 id 的其他几份，包括关着的、出错的、被停用的）。
 * 一份都选不出来（都关了、都出错了、都被停用）时谁也不标。
 */
export function pickWinners(infos: ExtPackInfo[]): Map<string, ExtPackSource> {
  const groups = new Map<string, ExtPackInfo[]>()
  for (const info of infos) {
    if (!info.id) continue
    const list = groups.get(info.id)
    if (list) list.push(info)
    else groups.set(info.id, [info])
  }
  const shadowed = new Map<string, ExtPackSource>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    let winner: ExtPackInfo | null = null
    for (const info of group) {
      if (!info.enabled || info.status === 'error' || info.blocked) continue
      if (!winner || RANK[info.source] > RANK[winner.source]) winner = info
    }
    if (!winner) continue
    for (const info of group) if (info !== winner) shadowed.set(info.key, winner.source)
  }
  return shadowed
}

/**
 * 重算同 id 的生效关系，直接改 packs 里每份的 info：
 * 1. 清掉旧的 pack.duplicateId；两个文件夹扩展同 id 时后到的仍然报 pack.duplicateId；
 * 2. 按 pickWinners 设置 / 清掉 shadowedBy；
 * 3. 每份都重算 live。
 * packs 的顺序是内置、商店、文件夹，「后到」就是数组里靠后。
 */
export function applyWinners(packs: LoadedPack[]): void {
  for (const pack of packs) {
    const info = pack.info
    if (!info.issues.some(i => i.code === 'pack.duplicateId')) continue
    info.issues = info.issues.filter(i => i.code !== 'pack.duplicateId')
    info.status = packStatus(info.issues)
  }
  const seen = new Set<string>()
  for (const pack of packs) {
    const { id, source } = pack.info
    if (!id || source !== 'folder') continue
    if (seen.has(id)) addPackIssue(pack, loaderIssue('pack.duplicateId', { id }))
    else seen.add(id)
  }
  const shadowed = pickWinners(packs.map(p => p.info))
  for (const pack of packs) {
    const info = pack.info
    const by = shadowed.get(info.key)
    if (by) info.shadowedBy = by
    else delete info.shadowedBy
    info.live = computeLive(info)
  }
}
