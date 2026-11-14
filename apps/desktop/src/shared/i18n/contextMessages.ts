// 云端 / 本机模型的上下文窗口、Codex 自动压缩、上下文按钮里的入口（GitHub #20，docs/ui/context-settings-branch-switch.md §2）
export const contextMessages = {
  'contextWindow.label': { zh: '上下文窗口', en: 'Context window' },
  'contextWindow.of': { zh: '{model} 的上下文窗口', en: 'Context window for {model}' },
  'contextWindow.auto': { zh: '自动', en: 'Auto' },
  'contextWindow.customTitle': { zh: '自定义 API 的模型', en: 'Custom API models' },
  'contextWindow.customHint': {
    zh: '和「自定义 API」里接口配置的上下文窗口是同一个值，改哪边都一样。留空用引擎自己知道的大小。',
    en: 'Same value as the context window in the custom API settings; editing either place changes both. Leave empty to use the engine’s own value.',
  },
  'contextWindow.platformTitle': { zh: '上下文窗口', en: 'Context windows' },
  'contextWindow.platformHint': {
    zh: '每个模型可以填上下文窗口，如 1M、200K；留空用引擎自己知道的大小。比模型实际支持的大，请求会出错。改了以后下一条消息生效。',
    en: "Set a context window per model, e.g. 1M or 200K. Leave empty to use the engine's own value. Larger than the model really supports and requests fail. Applies from the next message.",
  },
  'contextWindow.engineTitle': { zh: '模型的上下文窗口', en: 'Model context windows' },
  'contextWindow.engineHint': {
    zh: '用自己的账号时，每个模型的上下文窗口，如 1M、200K；留空用 {engine} 自己知道的大小。比模型实际支持的大，请求会出错。',
    en: "Context window per model when using your own account, e.g. 1M or 200K. Leave empty to use {engine}'s own value. Larger than the model really supports and requests fail.",
  },
  'contextWindow.noModels': {
    zh: '{engine} 还没报告模型列表，检测成功后显示。',
    en: "{engine} hasn't reported its models yet. They appear after detection succeeds.",
  },
  'contextWindow.pixelCompactHint': {
    zh: '占用到窗口的这个比例就压缩（一轮中途发请求前、一轮结束时都会检查）；像素星空自己的规则（离窗口还剩约 16K）先到时照旧按它。窗口按模型定，不知道窗口的模型不受这里影响。改了以后下一条消息生效。',
    en: "Compacts when usage reaches this share of the window (checked before each request mid-turn and when a turn ends). If Pixel Starry Sky's own rule (about 16K before the window) comes first, it still applies. The window depends on the model; models with an unknown window are not affected. Takes effect from the next message.",
  },
  'contextWindow.agyCompactHint': {
    zh: 'Antigravity 自己固定在约 256K 时压缩，不能改；选了比例后，一轮结束时用量到了窗口的这个比例，下一条消息前先替你发一次 /compact。窗口由 Antigravity 报告。',
    en: 'Antigravity compacts on its own at about 256K and that cannot be changed. With a percentage set, when a turn ends at or above that share of the window, /compact is sent for you before the next message. The window is reported by Antigravity.',
  },
  'contextWindow.codexCompactHint': {
    zh: 'Codex 按「窗口 × 这个比例」算出压缩的位置；窗口依次取这里填的、Codex 报过的、内置价格表里的，都不知道时由 Codex 自己决定。对 Codex 的所有会话生效（云端、本机、自定义 API）。',
    en: 'Codex compacts at window × this percentage. The window comes from what you set here, then what Codex reported, then the built-in price table; when none is known Codex decides. Applies to all Codex conversations (cloud, own account, custom API).',
  },
  'contextWindow.settings': { zh: '上下文设置…', en: 'Context settings…' },
} as const
