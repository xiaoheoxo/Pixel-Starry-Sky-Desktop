import type { TurnUsage } from '@pixelsky/protocol'

/** 仅用于设置里的统计显示预览，不写入真实会话或用量记录。 */
export const replyStatsPreview: TurnUsage = {
  durationMs: 10_000,
  models: {
    'claude-opus-5-5': {
      input: 1800,
      cacheRead: 37_000,
      cacheWrite: 1200,
      output: 318,
      costUsd: 0.19,
      requests: 3,
      genMs: 3_700,
      genOutput: 318,
      firstTokenMs: 1_200,
    },
  },
}
