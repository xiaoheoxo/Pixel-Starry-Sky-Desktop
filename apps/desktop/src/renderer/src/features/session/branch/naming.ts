// 开分支和「独立副本」共用的命名规则（docs/ui/branch-merge.md §3、docs/ui/desktop-parity.md §3.2）

/** Windows 的设备名：分支（松散引用文件）和副本目录都建不出来 */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/

/** 默认分支名：名字里的英文词连起来，没有（或者正好是 Windows 设备名）就用日期时间；重名加序号 */
export function defaultBranch(name: string, taken: readonly string[], now = new Date()): string {
  const joined = (name.toLowerCase().match(/[a-z0-9]+/g) ?? []).join('-').slice(0, 30).replace(/-+$/, '')
  const words = RESERVED.test(joined) ? '' : joined
  const d = now
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  const base = `pixelsky/${words || 'branch-' + stamp}`
  let branch = base
  for (let i = 2; taken.includes(branch); i++) branch = `${base}-${i}`
  return branch
}

/** 副本名：分支名最后一段，重名时加序号 */
export function copyName(branch: string, taken: readonly string[]): string {
  const base = (branch.split('/').filter(Boolean).pop() ?? 'branch').replace(/[. ]+$/, '') || 'branch'
  let name = base
  for (let i = 2; taken.includes(name); i++) name = `${base}-${i}`
  return name
}
