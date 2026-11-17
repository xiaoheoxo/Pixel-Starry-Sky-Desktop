// Git 差异视图的配色（docs/ui/git-panel.md §2.5）：覆盖 @codemirror/merge 的固定颜色，改用设计变量，浅色 / 深色都跟着主题走
import { EditorView } from '@codemirror/view'

const removed = 'color-mix(in srgb, var(--danger) 12%, transparent)'
const removedText = 'color-mix(in srgb, var(--danger) 28%, transparent)'
const added = 'color-mix(in srgb, var(--success) 12%, transparent)'
const addedText = 'color-mix(in srgb, var(--success) 28%, transparent)'

export const mergeTheme = EditorView.theme({
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: removed },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': { backgroundColor: added },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': { background: removedText },
  '&.cm-merge-b .cm-changedText': { background: addedText },
  '&.cm-merge-b .cm-deletedText': { background: removedText },
  // 行内模式：新内容所在行没有 cm-merge-b 类
  '&:not(.cm-merge-a):not(.cm-merge-b) .cm-changedLine': { backgroundColor: added },
  '&:not(.cm-merge-a):not(.cm-merge-b) .cm-changedText': { background: addedText },
  '.cm-deletedChunk': { paddingLeft: '14px', position: 'relative' },
  // 删掉的那块悬停时右上角「复制删掉的内容」（DiffEditor 借 mergeControls 放的）；纯新增没有删掉的行，不显示
  '.cm-deletedChunk .cm-chunkButtons': { top: '2px', zIndex: '1', opacity: '0', transition: 'opacity 120ms' },
  '.cm-deletedChunk:hover .cm-chunkButtons, .cm-deletedChunk .cm-chunkButtons:focus-within': { opacity: '1' },
  '.cm-deletedChunk:not(:has(.cm-deletedLine)) .cm-chunkButtons': { display: 'none' },
  '.cm-deletedChunk button[data-copy-deleted]': {
    height: '20px',
    padding: '0 8px',
    borderRadius: '6px',
    border: '1px solid var(--border-strong)',
    background: 'var(--bg-popover)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-label)',
    lineHeight: '18px',
  },
  '.cm-deletedChunk button[data-copy-deleted]:hover': { color: 'var(--text)', background: 'var(--bg-hover)' },
  '.cm-collapsedLines': {
    color: 'var(--text-muted)',
    background: 'var(--bg-subtle)',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-meta)',
    padding: '4px 14px',
  },
  // 并排时对面新增 / 删除的行留出的空白（按行比对后两边逐行对齐，docs/ui/coding-mode.md §3.3.3）：斜纹，一眼看出「这边没有这几行」
  '.cm-mergeSpacer': {
    background:
      'repeating-linear-gradient(135deg, color-mix(in srgb, var(--text-muted) 12%, transparent) 0 1px, transparent 1px 7px)',
  },
  '.cm-changeGutter': { width: '3px', paddingLeft: '1px' },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': { background: 'var(--danger)' },
  '&.cm-merge-b .cm-changedLineGutter, .cm-changedLineGutter': { background: 'var(--success)' },
})
