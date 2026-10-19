// 像素星空引擎（自带命令行智能体，基于 Pi）的界面文案，docs/own-cli.md
export const pixelMessages = {
  'engine.pixel.name': { zh: '像素星空', en: 'Pixel Starry Sky' },
  'engine.pixel.intro': {
    zh: '像素星空自带的编码智能体，基于开源的 Pi（MIT 协议）。需要你自己的 API Key，或使用平台余额。',
    en: "Pixel Starry Sky's built-in coding agent, built on the open-source Pi (MIT license). Needs your own API key, or your platform balance.",
  },
  'engine.pixel.useSettings': {
    zh: '使用像素星空命令行的默认模型',
    en: 'Use the Pixel Starry Sky CLI default model',
  },
  // 防空转（packages/cli/src/extensions/loopGuard.ts stopNotice）：引擎发英文原文，这里按模板翻译
  'engine.pixel.loopGuard.repeat': {
    zh: '这一轮已停下：智能体连着 {p1} 次用同样的参数调用「{p0}」，结果都一样。发一条消息可以接着做。',
    en: 'Stopped this run: the agent repeated the same "{p0}" call {p1} times in a row with the same result. Send a message to continue.',
  },
  'engine.pixel.loopGuard.failed': {
    zh: '这一轮已停下：连着 {p0} 步工具调用全部失败。发一条消息可以接着做。',
    en: 'Stopped this run: every tool call failed for {p0} steps in a row. Send a message to continue.',
  },
} as const
