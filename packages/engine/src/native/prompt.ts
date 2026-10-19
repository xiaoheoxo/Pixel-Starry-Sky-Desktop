import { HANDOFF_TAG } from '../handoff'

export const OVERVIEW_PREFIX = '（像素星空补充：'

export interface PromptParts {
  /** 用户自己的话 */
  text: string
  /** 文字交接材料（<pixelsky-handoff>…</pixelsky-handoff>） */
  handoff: string | null
  /** 接力第一轮前面的概要（到第一个空行为止） */
  overview: string | null
}

/** 用户话前面像素星空加的两种东西拆开：文字交接材料（§3.2）和接力的概要 */
export function splitPrompt(raw: string): PromptParts {
  let text = raw
  let handoff: string | null = null
  let overview: string | null = null
  if (text.trimStart().startsWith(`<${HANDOFF_TAG}`)) {
    const close = `</${HANDOFF_TAG}>`
    const i = text.indexOf(close)
    if (i >= 0) {
      handoff = text.slice(text.indexOf(`<${HANDOFF_TAG}`), i + close.length)
      text = text.slice(i + close.length).replace(/^\r?\n(?:\r?\n)?/, '')
    }
  }
  if (text.startsWith(OVERVIEW_PREFIX)) {
    const i = text.indexOf('\n\n')
    if (i >= 0) {
      overview = text.slice(0, i)
      text = text.slice(i + 2)
    }
  }
  return { text, handoff, overview }
}

const IDE_HEAD = '# Context from my IDE setup:'
const IDE_REQUEST = '## My request for Codex:'

export interface IdeParts {
  /** 用户自己的请求 */
  text: string
  /** VS Code 扩展加在前面的编辑器上下文（打开的文件、选中的内容……）；没有为 null */
  context: string | null
}

/**
 * VS Code 扩展发的消息以「# Context from my IDE setup:」开头，真正的请求在「## My request for Codex:」之后（docs/ui/codex-resume.md §3.2）。
 * 开头是这两个标记之一并且找得到请求标记才拆；用户话中间碰巧出现这行字不动
 */
export function splitIdeContext(raw: string): IdeParts {
  const head = raw.trimStart()
  if (!head.startsWith(IDE_HEAD) && !head.startsWith(IDE_REQUEST)) return { text: raw, context: null }
  const at = head.indexOf(IDE_REQUEST)
  if (at < 0) return { text: raw, context: null }
  const context = head.slice(0, at).trim()
  return {
    text: head
      .slice(at + IDE_REQUEST.length)
      .replace(/^[ \t]*\r?\n?/, '')
      .trim(),
    context: context || null,
  }
}
