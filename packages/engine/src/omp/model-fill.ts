// 网关扩展（gateway-ext.ts）和子智能体扩展（subagent-ext.ts）共用；单独一个文件，免得和 pixel/session.ts 循环导入
/** 两个扩展共用的源码：thinkingOf、fillModel（补模型缺的字段，见 gateway-ext.ts 的 OMP_GATEWAY_SOURCE） */
export const OMP_MODEL_FILL_SOURCE = `let builtin
try {
  builtin = (await import('@oh-my-pi/pi-catalog/models')).getBundledModel
} catch {
  // 拿不到内置目录：档位由 omp 自己推断
}
const thinkingOf = (api, id) => {
  if (api !== 'anthropic-messages') return undefined
  try {
    const thinking = builtin?.('anthropic', String(id).replace(/\\[1m\\]$/i, ''))?.thinking
    return thinking && { thinking }
  } catch {
    return undefined
  }
}
const fillModel = (api, m) => ({
  name: m.id,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
  ...thinkingOf(m.api ?? api, m.id),
  ...m,
})`
