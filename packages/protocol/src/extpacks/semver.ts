// 版本号比较：照云端 services/cloud/internal/extensions/semver.go 的 CompareVersions 重写，两边结果必须一致
// （共享用例 corpus/extpacks/semver.json）。不是 text.ts 的 cmpVer：那个只比三段数字、预发布后缀整个丢掉。
// 数字段用 BigInt 比：云端按 uint64 解析，JS 的 number 在 2^53 以上会丢精度。

/** 云端用 uint64 解析数字，超过的当作解析失败 */
const UINT64_MAX = (1n << 64n) - 1n

/** 和 validate.ts 的 VERSION_RE、云端 versionRE 一样：主.次.修订，可带预发布后缀，不带构建元数据 */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

interface Semver {
  core: [bigint, bigint, bigint]
  pre: string[]
}

/** 纯数字且不超过 uint64；否则返回 null（云端的 ParseUint 失败，按非数字段处理） */
function toUint(s: string): bigint | null {
  if (!/^\d+$/.test(s)) return null
  const n = BigInt(s)
  return n <= UINT64_MAX ? n : null
}

function parseSemver(s: string): Semver | null {
  const m = SEMVER_RE.exec(s)
  if (!m) return null
  const core: bigint[] = []
  for (let i = 1; i <= 3; i++) {
    const n = toUint(m[i])
    if (n === null) return null
    core.push(n)
  }
  return { core: core as Semver['core'], pre: m[4] ? m[4].split('.') : [] }
}

/** 字符串按字节比（版本号只有 ASCII，和 Go 的 strings.Compare 一致） */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 预发布后缀的一段：纯数字按数值、比非数字小；非数字按 ASCII */
function comparePre(a: string, b: string): number {
  const na = toUint(a)
  const nb = toUint(b)
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0
  if (na !== null) return -1
  if (nb !== null) return 1
  return cmpStr(a, b)
}

/**
 * 按 semver 2.0 比较两个版本号：a < b 返回 -1，相等 0，a > b 返回 1。
 * 没有预发布后缀的比有的大；不合法的版本号排在最前面（两个都不合法时按字符串比）。
 */
export function compareExtVersion(a: string, b: string): -1 | 0 | 1 {
  const va = parseSemver(a)
  const vb = parseSemver(b)
  if (!va && !vb) return cmpStr(a, b) as -1 | 0 | 1
  if (!va) return -1
  if (!vb) return 1
  for (let i = 0; i < 3; i++) {
    if (va.core[i] !== vb.core[i]) return va.core[i] < vb.core[i] ? -1 : 1
  }
  if (va.pre.length === 0 && vb.pre.length === 0) return 0
  if (va.pre.length === 0) return 1
  if (vb.pre.length === 0) return -1
  for (let i = 0; i < va.pre.length && i < vb.pre.length; i++) {
    const c = comparePre(va.pre[i], vb.pre[i])
    if (c !== 0) return c as -1 | 1
  }
  if (va.pre.length < vb.pre.length) return -1
  if (va.pre.length > vb.pre.length) return 1
  return 0
}
