import type { CheckItem } from '../../shared/types/machines'

// 通过 probeArgs() 的参数从 stdin 喂进去；用户指定的 node 路径靠 `env PIXELSKY_NODE=...` 传，
// 因为 --exec 不会把 Windows 环境变量带进 WSL（除非配 WSLENV）。
// 脚本要能在 dash 下跑；不能写 ${ 和反引号（这是模板字符串）
export const PROBE_SCRIPT = String.raw`
# WSL 给这个进程分配了控制终端：不带 --foreground 时 timeout 把命令放到后台进程组，
# bash -ic 一碰终端就被暂停（SIGTTOU），timeout 也杀不掉，整个探测卡住。busybox 的 timeout 没有 --foreground，就不跑 bash -ic
TO=""
FG=0
if timeout --foreground -k 2 1 true >/dev/null 2>&1; then TO="timeout --foreground -k 2"; FG=1
elif command -v timeout >/dev/null 2>&1; then TO=timeout; fi
lim() { t="$1"; shift; if [ -n "$TO" ]; then $TO "$t" "$@"; else "$@"; fi; }
esc() { printf '%s' "$1" | tr -d '\001-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
s() { if [ -n "$1" ]; then printf '"%s"' "$(esc "$1")"; else printf null; fi; }
b() { if [ "$1" = 1 ]; then printf true; else printf false; fi; }
file_has() { if [ -f "$1" ]; then printf 1; else printf 0; fi; }

NODES=""
NSEEN="|"
add_node() { if [ -n "$NODES" ]; then NODES="$NODES,$1"; else NODES="$1"; fi; }
try_node() {
  p="$2"
  [ -n "$p" ] || return 0
  case "$NSEEN" in *"|$p|"*) return 0 ;; esac
  if [ ! -e "$p" ]; then
    # 用户指定的路径不存在也要报出来（版本为空 = 跑不起来），不能悄悄换成别的
    [ "$1" = env ] && add_node "{\"source\":\"env\",\"path\":$(s "$p"),\"windows\":false,\"version\":null,\"platform\":null}"
    return 0
  fi
  NSEEN="$NSEEN$p|"
  win=0; ver=""; plat=""
  case "$p" in /mnt/*) win=1 ;; esac
  if [ $win = 0 ]; then
    out=$(lim 10 "$p" -p "process.versions.node+' '+process.platform" </dev/null 2>/dev/null | tail -n 1)
    ver=$(printf '%s' "$out" | cut -d' ' -f1)
    plat=$(printf '%s' "$out" | cut -d' ' -f2)
  fi
  add_node "{\"source\":$(s "$1"),\"path\":$(s "$p"),\"windows\":$(b $win),\"version\":$(s "$ver"),\"platform\":$(s "$plat")}"
}

CL=""
CX=""
CSEEN="|"
try_cli() {
  n="$1"; p="$2"
  case "$p" in /*) ;; *) return 0 ;; esac
  case "$CSEEN" in *"|$n:$p|"*) return 0 ;; esac
  [ -e "$p" ] || return 0
  CSEEN="$CSEEN$n:$p|"
  real=$(realpath "$p" 2>/dev/null || readlink -f "$p" 2>/dev/null)
  [ -n "$real" ] || real="$p"
  mnt=0
  case "$p" in /mnt/*) mnt=1 ;; esac
  case "$real" in /mnt/*) mnt=1 ;; esac
  mz=0
  [ "$(head -c 2 "$real" 2>/dev/null)" = "MZ" ] && mz=1
  ver=""
  if [ $mnt = 0 ] && [ $mz = 0 ] && [ -n "$TO" ]; then
    ver=$(lim 10 "$p" --version </dev/null 2>/dev/null | head -n 1)
  fi
  item="{\"path\":$(s "$p"),\"real\":$(s "$real"),\"mnt\":$(b $mnt),\"mz\":$(b $mz),\"version\":$(s "$ver")}"
  if [ "$n" = claude ]; then
    if [ -n "$CL" ]; then CL="$CL,$item"; else CL="$item"; fi
  else
    if [ -n "$CX" ]; then CX="$CX,$item"; else CX="$item"; fi
  fi
}
shell_find() {
  if [ $FG = 1 ] && command -v bash >/dev/null 2>&1; then
    lim 8 bash -ic "command -v $1" </dev/null 2>/dev/null | grep '^/' | tail -n 1
  fi
}

PRETTY=$(grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | head -n 1 | sed -e 's/^PRETTY_NAME=//' -e 's/^"//' -e 's/"$//')
KERNEL=$(uname -r 2>/dev/null)
CHARMAP=$(locale charmap 2>/dev/null)
ARCH=$(uname -m 2>/dev/null)

try_node env "$PIXELSKY_NODE"
try_node shell "$(shell_find node)"
for p in "$HOME"/.nvm/versions/node/*/bin/node; do try_node nvm "$p"; done
for p in "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node; do try_node fnm "$p"; done
try_node volta "$HOME/.volta/bin/node"
try_node local /usr/local/bin/node
try_node usr /usr/bin/node

for n in claude codex; do
  try_cli $n "$(shell_find $n)"
  try_cli $n "$(command -v $n 2>/dev/null)"
  try_cli $n "$HOME/.local/bin/$n"
  try_cli $n "$HOME/.npm-global/bin/$n"
  try_cli $n "/usr/local/bin/$n"
  for p in "$HOME"/.nvm/versions/node/*/bin/$n; do try_cli $n "$p"; done
done

printf 'PIXELSKY_PROBE={"pretty":%s,"kernel":%s,"distro":%s,"shell":%s,"home":%s,"charmap":%s,"arch":%s,' \
  "$(s "$PRETTY")" "$(s "$KERNEL")" "$(s "$WSL_DISTRO_NAME")" "$(s "$SHELL")" "$(s "$HOME")" "$(s "$CHARMAP")" "$(s "$ARCH")"
printf '"nodes":[%s],"claude":[%s],"codex":[%s],' "$NODES" "$CL" "$CX"
printf '"login":{"claude":%s,"codex":%s}}\n' \
  "$(b "$(file_has "$HOME/.claude/.credentials.json")")" "$(b "$(file_has "$HOME/.codex/auth.json")")"
`

export function probeArgs(distro: string, nodePath?: string): string[] {
  const args = ['-d', distro, '--cd', '~', '--exec']
  if (nodePath) args.push('env', `PIXELSKY_NODE=${nodePath}`)
  args.push('sh', '-s')
  return args
}

export interface WslProbeNode {
  source: string
  path: string
  windows: boolean
  version: string | null
  platform: string | null
}

export interface WslProbeCli {
  path: string
  real: string | null
  mnt: boolean
  mz: boolean
  version: string | null
}

export interface WslProbe {
  pretty: string | null
  kernel: string | null
  distro: string | null
  shell: string | null
  home: string | null
  charmap: string | null
  /** uname -m 归一化后的架构；认不出（含 32 位）是 null，不下发命令行 */
  arch: 'x64' | 'arm64' | null
  nodes: WslProbeNode[]
  claude: WslProbeCli[]
  codex: WslProbeCli[]
  login: { claude: boolean; codex: boolean }
}

export function normalizeArch(raw: unknown): 'x64' | 'arm64' | null {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value === 'x86_64' || value === 'amd64' || value === 'x64') return 'x64'
  if (value === 'aarch64' || value === 'arm64') return 'arm64'
  return null
}

export function parseProbe(stdout: string): WslProbe | null {
  const marker = 'PIXELSKY_PROBE='
  const lines = stdout.replace(/\r/g, '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf(marker)
    if (at < 0) continue
    try {
      const value = JSON.parse(lines[i].slice(at + marker.length)) as Partial<WslProbe>
      if (!value || typeof value !== 'object') return null
      return {
        pretty: value.pretty ?? null,
        kernel: value.kernel ?? null,
        distro: value.distro ?? null,
        shell: value.shell ?? null,
        home: value.home ?? null,
        charmap: value.charmap ?? null,
        arch: normalizeArch(value.arch),
        nodes: Array.isArray(value.nodes) ? value.nodes : [],
        claude: Array.isArray(value.claude) ? value.claude : [],
        codex: Array.isArray(value.codex) ? value.codex : [],
        login: { claude: !!value.login?.claude, codex: !!value.login?.codex },
      }
    } catch {
      return null
    }
  }
  return null
}

export type { CheckItem }

const NODE_MIN = 22
const NODE_FIX = 'curl -fsSL https://fnm.vercel.app/install | bash && ~/.local/share/fnm/fnm install 22'
const CLI_FIX = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'npm i -g @openai/codex',
}

function versionParts(v: string | null): number[] {
  return (v ?? '').split('.').map(n => Number.parseInt(n, 10) || 0)
}

function compareVersion(a: string | null, b: string | null): number {
  const x = versionParts(a)
  const y = versionParts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

const isLinuxNode = (n: WslProbeNode) => !n.windows && n.platform === 'linux' && !!n.version
const major = (n: WslProbeNode) => versionParts(n.version)[0]

// 用户指定的 node 不可用时不换别的，免得悄悄忽略用户的选择；由 nodeItem 报出原因
const isUsable = (n: WslProbeNode) => isLinuxNode(n) && major(n) >= NODE_MIN

// 按优先级取第一个可用的；nvm / fnm 目录里装了多个版本时取其中最高的
export function pickNode(probe: WslProbe | null): string | null {
  const nodes = probe?.nodes ?? []
  const chosen = nodes.find(n => n.source === 'env')
  if (chosen && !isUsable(chosen)) return null
  const ok = nodes.filter(isUsable)
  const first = ok[0]
  if (!first) return null
  if (first.source !== 'nvm' && first.source !== 'fnm') return first.path
  let best = first
  for (const n of ok) if (n.source === first.source && compareVersion(n.version, best.version) > 0) best = n
  return best.path
}

function nodeFail(code: string, detail: string): CheckItem {
  return { key: 'node', status: 'fail', required: true, detail, code, fix: NODE_FIX }
}

function nodeItem(probe: WslProbe): CheckItem {
  const path = pickNode(probe)
  if (path) {
    const node = probe.nodes.find(n => n.path === path)!
    return { key: 'node', status: 'ok', required: true, detail: `${node.version} (${path})` }
  }
  const env = probe.nodes.find(n => n.source === 'env')
  const old = env ?? probe.nodes.filter(isLinuxNode).sort((a, b) => compareVersion(b.version, a.version))[0]
  if (old && !old.windows && old.platform !== 'win32') {
    if (!old.version) return nodeFail('NODE_BROKEN', old.path)
    if (old.platform === 'linux') return nodeFail('NODE_OLD', `${old.version} (${old.path})`)
  }
  const win = probe.nodes.find(n => n.windows || n.platform === 'win32')
  if (win) return nodeFail('NODE_WINDOWS', win.path)
  // 版本取不到的 Linux 版 node：二进制在，但跑不起来
  const broken = probe.nodes.find(n => !n.version)
  if (broken) return nodeFail('NODE_BROKEN', broken.path)
  return nodeFail('NODE_MISSING', '')
}

// npm 装的 Linux 版文件名也叫 claude.exe，只能按 /mnt/ 和 MZ 判断
function cliItem(key: 'claude' | 'codex', list: WslProbeCli[]): CheckItem {
  const name = key.toUpperCase()
  const linux = list.find(c => !c.mnt && !c.mz)
  if (linux) {
    return { key, status: 'ok', required: false, detail: `${linux.version ?? 'installed'} (${linux.path})` }
  }
  const win = list[0]
  if (win) {
    return { key, status: 'warn', required: false, detail: win.path, code: `${name}_WINDOWS`, fix: CLI_FIX[key] }
  }
  return { key, status: 'warn', required: false, detail: '', code: `${name}_MISSING`, fix: CLI_FIX[key] }
}

export function wslCheckItems(probe: WslProbe | null, startError?: string): CheckItem[] {
  if (!probe || startError) {
    return [
      {
        key: 'start',
        status: 'fail',
        required: true,
        detail: startError ?? '',
        code: 'WSL_START_FAILED',
      },
    ]
  }
  const items: CheckItem[] = [
    {
      key: 'start',
      status: 'ok',
      required: true,
      detail: [probe.pretty ?? probe.distro, probe.kernel].filter(Boolean).join(' · '),
    },
  ]
  const charmap = probe.charmap ?? ''
  if (/^utf-?8$/i.test(charmap)) {
    items.push({ key: 'encoding', status: 'ok', required: false, detail: 'UTF-8' })
  } else {
    items.push({
      key: 'encoding',
      status: 'info',
      required: false,
      detail: charmap || 'unknown',
      code: charmap ? 'ENCODING_NOT_UTF8' : 'ENCODING_UNKNOWN',
    })
  }
  items.push(nodeItem(probe), cliItem('claude', probe.claude), cliItem('codex', probe.codex))
  const logged = (['claude', 'codex'] as const).filter(k => probe.login[k])
  items.push({ key: 'login', status: 'info', required: false, detail: logged.join(', ') || 'none' })
  return items
}

export function readyToConnect(items: CheckItem[]): boolean {
  return items.every(i => !i.required || i.status === 'ok')
}
