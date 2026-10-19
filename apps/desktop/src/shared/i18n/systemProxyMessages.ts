// 设置 › 本机引擎「使用系统代理」（renderer features/settings/engines/SystemProxySettings.tsx）
export const systemProxyMessages = {
  'systemProxy.title': { zh: '使用系统代理', en: 'Use system proxy' },
  'systemProxy.description': {
    zh: 'Claude Code、Codex 和像素星空引擎只认 HTTPS_PROXY 这类环境变量，不读系统代理。打开后，系统开着代理时自动传给它们；新开的会话生效，已经开着的会话重开后生效。',
    en: 'Claude Code, Codex and the Pixel Starry Sky engine only read proxy environment variables like HTTPS_PROXY, not the system proxy. When on, the system proxy is passed to them. Applies to new sessions; reopen running ones.',
  },
  'systemProxy.using': {
    zh: '检测到系统代理 {proxy}，本机引擎会通过它连网。',
    en: 'System proxy {proxy} detected; local engines connect through it.',
  },
  'systemProxy.ownEnv': {
    zh: '{engines} 的环境变量里自己设了代理，按你的设置。',
    en: '{engines} have their own proxy in environment variables, which is used instead.',
  },
  'systemProxy.envSet': {
    zh: '系统环境变量里已经设了 HTTPS_PROXY 等代理变量，按你的设置，不另外传。',
    en: 'Proxy variables such as HTTPS_PROXY are already set in your system environment and are used as is.',
  },
  'systemProxy.socks': {
    zh: '系统代理是 SOCKS 类型（{proxy}），Claude Code 不支持，没有传。请在代理软件里改用 HTTP 端口，或在引擎详情的环境变量里设置 HTTPS_PROXY。',
    en: 'The system proxy is SOCKS ({proxy}), which Claude Code doesn’t support, so it isn’t passed. Use an HTTP port in your proxy app, or set HTTPS_PROXY in the engine’s environment variables.',
  },
  'systemProxy.none': {
    zh: '系统没开代理，本机引擎直接连网。',
    en: 'No system proxy; local engines connect directly.',
  },
  'systemProxy.off': {
    zh: '已关闭：本机引擎只按环境变量里的代理设置连网。',
    en: 'Off: local engines only use proxy settings from environment variables.',
  },
} as const
