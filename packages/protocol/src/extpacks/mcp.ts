// MCP 连接器贡献（contributes.mcpServers）的校验：只看清单，不读文件。
// 规则（docs/ui/extension-remaining-plan.md §G.1）：命令只能是 npx / uvx / docker，包的版本写死（镜像用摘要），
// 要用户填的值在 inputs 里声明，args / url / headers 里只能引用声明过的 ${NAME}，必须写公开的源码地址。
import type { ExtIssueCode } from './codes'
import { EXT_MCP_COMMANDS } from './types'

type Rec = Record<string, unknown>

// 协议包不带 DOM / node 类型；URL 在主进程、渲染进程、命令行里都有
declare const URL: new (input: string) => { protocol: string; hostname: string }

export interface McpProblem {
  code: ExtIssueCode
  zh: string
  en: string
  path?: string
}

export const MCP_KEYS = [
  'name',
  'description',
  'type',
  'command',
  'args',
  'url',
  'headers',
  'inputs',
  'source',
] as const
export const MCP_INPUT_KEYS = ['name', 'description', 'secret', 'required'] as const

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const INPUT_RE = /^[A-Z][A-Z0-9_]{0,63}$/
/** 会改变跑什么的环境变量（换包源、预加载代码、改查找路径）：inputs 不能叫这些 */
const RESERVED_INPUT =
  /^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|NPM_CONFIG_.*|UV_.*|PIP_.*|DOCKER_.*|LD_.*|DYLD_.*)$/
const SEMVER = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?`
/** npm 包：name@1.2.3、@scope/name@1.2.3 */
const NPM_PINNED = new RegExp(String.raw`^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@${SEMVER}$`, 'i')
/** PyPI 包：name==1.2.3 或 name@1.2.3（uv 两种都认） */
const PYPI_PINNED = new RegExp(String.raw`^[a-z0-9][\w.-]*(\[[\w,.-]+\])?(==|@)${SEMVER}$`, 'i')
const DOCKER_PINNED = /@sha256:[0-9a-f]{64}$/
const PLACEHOLDER = /\$\{([^}]*)\}/g

/** 带值的参数（值不是包名）；没列出来的当成开关 */
const VALUE_FLAGS: Record<string, readonly string[]> = {
  npx: ['--registry', '--cache'],
  uvx: ['--python', '-p', '--python-preference', '--cache-dir', '--directory'],
  docker: [
    '-e',
    '--env',
    '-v',
    '--volume',
    '--mount',
    '--name',
    '--network',
    '-p',
    '--publish',
    '-w',
    '--workdir',
    '-u',
    '--user',
    '--entrypoint',
    '--platform',
    '-m',
    '--memory',
    '--cpus',
    '-l',
    '--label',
  ],
}
/** 不允许的参数：换包源（审核的和跑的不是同一份）、npx 跑任意 shell、docker 提权 */
const FORBIDDEN: Record<string, readonly string[]> = {
  npx: ['-c', '--call', '--registry', '--userconfig'],
  uvx: ['--index', '--index-url', '--default-index', '--extra-index-url', '-i', '-f', '--find-links'],
  docker: ['--privileged', '--cap-add', '--pid', '--ipc', '--env-file'],
}
/** 值是包名、也要写死版本的参数 */
const PACKAGE_FLAGS: Record<string, readonly string[]> = {
  npx: ['-p', '--package'],
  uvx: ['--from', '--with'],
  docker: [],
}

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isText(v: unknown): boolean {
  if (typeof v === 'string') return v.trim() !== ''
  return isRec(v) && typeof v.zh === 'string' && v.zh.trim() !== '' && (v.en === undefined || typeof v.en === 'string')
}
function httpsUrl(v: unknown, localHttp: boolean): boolean {
  if (typeof v !== 'string' || v.length > 500) return false
  // 占位换成一个合法的主机 / 路径再解析：https://${HOST}/mcp 这种写法也认
  const probe = v.replace(PLACEHOLDER, 'x')
  try {
    const u = new URL(probe)
    if (u.protocol === 'https:') return true
    return localHttp && u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
}

/** `--flag=value` 拆成 [flag, value]；不是参数返回 null */
function splitFlag(arg: string): [string, string | null] | null {
  if (!arg.startsWith('-')) return null
  const eq = arg.indexOf('=')
  return eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null]
}

/** 启动命令的参数：禁止的参数、要写死版本的包；返回问题列表 */
export function commandProblems(command: string, args: readonly string[]): McpProblem[] {
  const out: McpProblem[] = []
  const pinned = (spec: string): boolean =>
    command === 'npx' ? NPM_PINNED.test(spec) : command === 'uvx' ? PYPI_PINNED.test(spec) : DOCKER_PINNED.test(spec)
  const unpinned = (spec: string, at: number): void => {
    out.push({
      code: 'mcp.unpinned',
      zh:
        command === 'docker'
          ? `镜像要用摘要写死：${spec}@sha256:…`
          : `包的版本要写死（如 ${command === 'npx' ? 'name@1.2.3' : 'name==1.2.3'}）：${spec}`,
      en:
        command === 'docker'
          ? `Pin the image by digest: ${spec}@sha256:…`
          : `Pin the package version (e.g. ${command === 'npx' ? 'name@1.2.3' : 'name==1.2.3'}): ${spec}`,
      path: `args[${at}]`,
    })
  }
  let i = 0
  if (command === 'docker') {
    if (args[0] !== 'run') {
      out.push({
        code: 'mcp.command',
        zh: 'docker 的第一个参数必须是 run',
        en: 'The first docker argument must be run',
        path: 'args[0]',
      })
      return out
    }
    i = 1
  }
  let main: number | null = null
  for (; i < args.length; i++) {
    const flag = splitFlag(args[i])
    if (!flag) {
      // 第一个不是参数的就是包（docker 是镜像）；后面的是传给它的参数，不管
      main = i
      break
    }
    const [name, inline] = flag
    if (FORBIDDEN[command].includes(name)) {
      out.push({
        code: 'mcp.command',
        zh: `不允许的参数：${name}`,
        en: `Argument not allowed: ${name}`,
        path: `args[${i}]`,
      })
      continue
    }
    const takesValue = VALUE_FLAGS[command].includes(name) || PACKAGE_FLAGS[command].includes(name)
    if (!takesValue) continue
    const value = inline ?? args[i + 1]
    const at = inline === null ? i + 1 : i
    if (inline === null) i++
    if (PACKAGE_FLAGS[command].includes(name) && value !== undefined && !pinned(value)) unpinned(value, at)
  }
  if (main === null) {
    // npx -p x@1 cmd / uvx --from x==1 cmd 也要有个要跑的命令
    out.push({
      code: 'mcp.command',
      zh: `${command} 后面要写要运行的包`,
      en: `${command} needs a package to run`,
      path: 'args',
    })
  } else if (!pinned(args[main]) && !(command !== 'docker' && hasPackageFlag(command, args))) unpinned(args[main], main)
  return out
}

/** 用 -p / --from 指定了包时，后面那个是要跑的命令名，不是包 */
function hasPackageFlag(command: string, args: readonly string[]): boolean {
  return args.some(a => {
    const f = splitFlag(a)
    return f !== null && (command === 'npx' ? ['-p', '--package'] : ['--from']).includes(f[0])
  })
}

/** 一条 mcpServers 贡献的问题；names 用来查重（调用方每条传同一个 Set） */
export function mcpServerProblems(raw: unknown, names: Set<string>): McpProblem[] {
  const out: McpProblem[] = []
  const bad = (code: ExtIssueCode, zh: string, en: string, path?: string): void => {
    out.push({ code, zh, en, path })
  }
  if (!isRec(raw)) {
    bad('mcp.fields', 'MCP 连接器必须是对象', 'An MCP server must be an object')
    return out
  }
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name))
    bad(
      'mcp.fields',
      'name 只能用小写字母、数字和 -，最多 32 个字符',
      'name may only use lowercase letters, digits and -, up to 32 characters',
      'name',
    )
  else if (names.has(raw.name))
    bad('mcp.fields', `连接器名字重复：${raw.name}`, `Duplicate server name: ${raw.name}`, 'name')
  else names.add(raw.name)
  if (raw.description !== undefined && !isText(raw.description))
    bad(
      'mcp.fields',
      'description 必须是非空文字或 { zh, en }',
      'description must be non-empty text or { zh, en }',
      'description',
    )
  if (!httpsUrl(raw.source, false) || String(raw.source).includes('${'))
    bad('mcp.fields', 'source 必须写公开的源码地址（https）', 'source must be a public source URL (https)', 'source')

  // 用户要填的值
  const declared = new Set<string>()
  if (raw.inputs !== undefined) {
    if (!Array.isArray(raw.inputs) || raw.inputs.length > 20)
      bad('mcp.inputs', 'inputs 必须是数组，最多 20 项', 'inputs must be an array of at most 20 items', 'inputs')
    else
      raw.inputs.forEach((input, k) => {
        const at = `inputs[${k}]`
        if (!isRec(input)) return bad('mcp.inputs', `${at} 必须是对象`, `${at} must be an object`, at)
        const unknown = Object.keys(input).filter(key => !(MCP_INPUT_KEYS as readonly string[]).includes(key))
        if (unknown.length)
          bad(
            'mcp.inputs',
            `${at} 里不认识的字段「${unknown[0]}」`,
            `Unknown field "${unknown[0]}" in ${at}`,
            `${at}.${unknown[0]}`,
          )
        if (typeof input.name !== 'string' || !INPUT_RE.test(input.name))
          return bad(
            'mcp.inputs',
            `${at}.name 只能用大写字母、数字和 _（如 GITHUB_TOKEN）`,
            `${at}.name may only use uppercase letters, digits and _ (e.g. GITHUB_TOKEN)`,
            `${at}.name`,
          )
        if (RESERVED_INPUT.test(input.name))
          bad(
            'mcp.inputs',
            `${at}.name 不能用 ${input.name}（会改变运行的程序）`,
            `${at}.name cannot be ${input.name} (it changes what runs)`,
            `${at}.name`,
          )
        if (declared.has(input.name))
          bad(
            'mcp.inputs',
            `inputs 里重复的名字：${input.name}`,
            `Duplicate name in inputs: ${input.name}`,
            `${at}.name`,
          )
        declared.add(input.name)
        if (!isText(input.description))
          bad(
            'mcp.inputs',
            `${at}.description 要写这个值是什么、去哪拿`,
            `${at}.description must say what the value is and where to get it`,
            `${at}.description`,
          )
        for (const key of ['secret', 'required'] as const)
          if (input[key] !== undefined && typeof input[key] !== 'boolean')
            bad('mcp.inputs', `${at}.${key} 必须是 true / false`, `${at}.${key} must be true or false`, `${at}.${key}`)
      })
  }
  const refs = (value: string, path: string): void => {
    for (const m of value.matchAll(PLACEHOLDER))
      if (!declared.has(m[1]))
        bad('mcp.placeholder', `引用了没在 inputs 里声明的 \${${m[1]}}`, `\${${m[1]}} is not declared in inputs`, path)
  }

  const type = raw.type
  if (type === 'stdio') {
    if (raw.url !== undefined || raw.headers !== undefined)
      bad(
        'mcp.fields',
        'stdio 连接器不能写 url / headers',
        'A stdio server cannot have url or headers',
        raw.url !== undefined ? 'url' : 'headers',
      )
    const args = raw.args ?? []
    if (!Array.isArray(args) || args.length > 64 || !args.every(a => typeof a === 'string' && a.length <= 1024))
      bad(
        'mcp.fields',
        'args 必须是字符串数组（最多 64 项，每项最多 1024 个字符）',
        'args must be an array of strings (at most 64, each up to 1024 characters)',
        'args',
      )
    else if (typeof raw.command !== 'string' || !EXT_MCP_COMMANDS.includes(raw.command))
      bad(
        'mcp.command',
        `command 只能是 ${EXT_MCP_COMMANDS.join(' / ')}`,
        `command must be one of ${EXT_MCP_COMMANDS.join(' / ')}`,
        'command',
      )
    else {
      args.forEach((a: string, k: number) => refs(a, `args[${k}]`))
      out.push(...commandProblems(raw.command, args))
    }
  } else if (type === 'http' || type === 'sse') {
    if (raw.command !== undefined || raw.args !== undefined)
      bad(
        'mcp.fields',
        `${type} 连接器不能写 command / args`,
        `A ${type} server cannot have command or args`,
        raw.command !== undefined ? 'command' : 'args',
      )
    if (!httpsUrl(raw.url, true))
      bad(
        'mcp.fields',
        'url 必须是 https，或者本机（localhost / 127.0.0.1）的 http',
        'url must be https, or http on localhost / 127.0.0.1',
        'url',
      )
    else refs(raw.url as string, 'url')
    if (raw.headers !== undefined) {
      const h = raw.headers
      if (
        !isRec(h) ||
        Object.keys(h).length > 20 ||
        !Object.values(h).every(v => typeof v === 'string' && v.length <= 2048)
      )
        bad(
          'mcp.fields',
          'headers 必须是「名字 → 文字」的对象，最多 20 项',
          'headers must be an object of name → text, at most 20',
          'headers',
        )
      else for (const [k, v] of Object.entries(h)) refs(v as string, `headers.${k}`)
    }
  } else bad('mcp.fields', 'type 只能是 stdio、http、sse', 'type must be stdio, http or sse', 'type')
  return out
}
