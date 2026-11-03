// 编辑器里问题的波浪线（docs/ui/coding-tier1.md §4）：错误红、警告黄，悬停看报错原文；位置随编辑移动
import { StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import type { Problem } from '../../problemsModel'

const lintTheme = EditorView.theme({
  '.cm-problem-error': { textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' },
  '.cm-problem-warning': { textDecoration: 'underline wavy var(--warn)', textUnderlineOffset: '3px' },
})

/** 报错位置 → 画线的范围：那里的一个词，不是词就一个字；行号超出（文件改短了）、空行的不画 */
function build(state: EditorState, problems: readonly Problem[]): DecorationSet {
  const ranges = []
  for (const p of problems) {
    if (p.line > state.doc.lines) continue
    const line = state.doc.line(p.line)
    // 指在行尾的（「缺少 ;」）画前一个字
    const at = Math.min(line.from + p.column - 1, line.to)
    const from = at === line.to && at > line.from ? at - 1 : at
    const word = state.wordAt(from)
    const to = word && word.from === from ? word.to : Math.min(from + 1, line.to)
    if (to <= from) continue
    const title = `${p.message} (${p.code ? `${p.source} ${p.code}` : p.source})`
    ranges.push(Decoration.mark({ class: `cm-problem-${p.severity}`, attributes: { title } }).range(from, to))
  }
  return Decoration.set(ranges, true)
}

/** problems 是这个文件的问题（行列从 1 起） */
export function problemsLint(problems: readonly Problem[]): Extension {
  const field = StateField.define<DecorationSet>({
    create: state => build(state, problems),
    update: (deco, tr) => deco.map(tr.changes),
    provide: f => EditorView.decorations.from(f),
  })
  return [field, lintTheme]
}
