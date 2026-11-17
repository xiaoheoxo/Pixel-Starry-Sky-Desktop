// 设置 › 本机引擎「闲置后释放引擎进程」（renderer features/settings/engines/IdleReleaseSettings.tsx，docs/engine-idle-release.md）
export const idleReleaseMessages = {
  'idleRelease.title': { zh: '闲置后释放引擎进程', en: 'Release idle engine processes' },
  'idleRelease.description': {
    zh: '会话停下这么久，就关掉它的引擎进程省内存；再发消息时自动接上原对话，多等两三秒。正在跑、有后台任务或在等你确认的不会关。',
    en: 'Close a session’s engine process after it has been idle this long to save memory. The next message reconnects to the same conversation and takes a few extra seconds. Running sessions, background tasks and pending approvals are never closed.',
  },
  'idleRelease.hint': {
    zh: '选了时长时，闲置的进程最多留 2 个，多了先关最久没用的。电脑内存紧张时，不管这里怎么设都会马上释放。只管这台电脑。',
    en: 'With a time limit set, at most 2 idle processes are kept; the least recently used close first. When the computer runs low on memory they are released right away regardless of this setting. Applies to this computer only.',
  },
  'idleRelease.mode': { zh: '闲置多久释放', en: 'Release after idle for' },
  'idleRelease.min5': { zh: '5 分钟', en: '5 min' },
  'idleRelease.min10': { zh: '10 分钟', en: '10 min' },
  'idleRelease.min30': { zh: '30 分钟', en: '30 min' },
  'idleRelease.off': { zh: '不释放', en: 'Never' },
  'idleRelease.searchKeywords': {
    zh: '内存 进程 闲置 空闲 释放 省内存 引擎进程 memory idle',
    en: 'memory process idle release engine save memory',
  },
} as const
