// 文字截断的公共小工具：按 UTF-16 下标截，但不把 emoji（代理对）劈成两半。
// 截出来的文字会进交接材料、对话历史工具、命令输出和工具标题，最后都要发给引擎（Codex 的 JSON 解析器拒收半个代理项）。
const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * 按 UTF-16 下标截取 [start, end)，但不把代理对劈成两半：边界落在 emoji 中间时往里收一位
 * （半个代理项发给 Codex，它的 JSON 解析器会拒收整条消息）
 */
export function cut(text: string, start: number, end = text.length): string {
  let from = Math.max(0, Math.min(start, text.length))
  let to = Math.max(from, Math.min(end, text.length))
  if (from > 0 && from < text.length && isLow(text.charCodeAt(from)) && isHigh(text.charCodeAt(from - 1))) from++
  if (to > from && to < text.length && isHigh(text.charCodeAt(to - 1)) && isLow(text.charCodeAt(to))) to--
  return text.slice(from, to)
}
/** 落单的代理项换成 U+FFFD（上游原文里本来就有的也一并处理），保证发出去的是合法 UTF-16 */
export const wellFormed = (text: string): string => text.replace(LONE_SURROGATE, '\uFFFD')
