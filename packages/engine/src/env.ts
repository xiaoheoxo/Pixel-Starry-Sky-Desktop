// 启动引擎时的环境变量（docs/engines.md §7.3）
//
// 从终端（尤其是 Mirasim 的终端）启动像素星空时，会继承别的程序的变量：
// - CLAUDECODE、CLAUDE_PID、CLAUDE_EFFORT 和下面列出的 CLAUDE_CODE_* 会让 claude 以为自己是别的 Claude Code 的子会话；
// - MIRASIM_*、ELECTRON_RUN_AS_NODE、ELECTRON_RENDERER_URL、NODE_PATH 是其他程序自己用的。
// ANTHROPIC_*、OPENAI_* 保留：用户可能就是靠它们配置的 Key 或中转。
// 其余 CLAUDE_CODE_* 是用户的配置（CLAUDE_CODE_GIT_BASH_PATH、CLAUDE_CODE_OAUTH_TOKEN、CLAUDE_CODE_USE_BEDROCK /
// VERTEX、CLAUDE_CODE_MAX_OUTPUT_TOKENS、CLAUDE_CODE_DISABLE_* …），保留；原来整类丢掉，靠它们登录 / 运行的用户用不了。
// 网关会话要清掉的认证类变量在 claude/index.ts 的 launchEnv 里单独处理。
const DROP =
  /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|EXECPATH|CHILD_SESSION|MESSAGING_.*|SESSION_ATTENDED|ENABLE_SDK_FILE_CHECKPOINTING)|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AUTOCOMPACT_PCT_OVERRIDE|MIRASIM_.*|ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_PATH)$/i

export function engineEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !DROP.test(k)) env[k] = v
  }
  return env
}

const PROXY_KEY = /^(https?_proxy|all_proxy)$/i
const NO_PROXY_KEY = /^no_proxy$/i
/** 本机地址不走代理：平台会话连的是本机网关（http://127.0.0.1:端口） */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']

/**
 * 系统开着代理（Windows / macOS 的「系统代理」）时补给引擎的代理变量：Claude Code、Codex、像素星空引擎都只认
 * HTTPS_PROXY 这类环境变量，不读系统代理，不补的话会直接连外网（国内常见 403）。
 * - 系统环境或用户在 设置 › 本机引擎 里填的变量里有任何代理变量（大小写都算，空值也算用户的选择）：不动；
 * - 否则补 HTTPS_PROXY、HTTP_PROXY，NO_PROXY 在用户原有的后面补上本机地址（键名沿用用户原来的大小写）。
 * proxy 为 null（没开代理、开关关了、远程机器）时什么都不补
 */
export function systemProxyEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
  proxy: string | null,
): Record<string, string> {
  if (!proxy) return {}
  const keys = [
    ...Object.keys(base).filter(k => base[k] !== undefined),
    ...Object.keys(extra).filter(k => extra[k] !== undefined),
  ]
  if (keys.some(k => PROXY_KEY.test(k))) return {}
  const noKey = keys.find(k => NO_PROXY_KEY.test(k)) ?? 'NO_PROXY'
  const current = (extra[noKey] ?? base[noKey] ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  const merged = [...current, ...LOCAL_HOSTS.filter(h => !current.some(c => c.toLowerCase() === h))]
  return { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, [noKey]: merged.join(',') }
}
