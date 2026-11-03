import { tr } from '../../../i18n/core'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting, type Language } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { tags } from '@lezer/highlight'

/**
 * 有选区时给编辑器加 cm-has-selection，不显示当前行高亮：当前行的背景画在选区上面，
 * 多行选中时光标那一行会变成一条横穿选区的浅色带（issue #4）
 */
export const selectionMarker = EditorView.editorAttributes.compute(
  ['selection'],
  (state): Record<string, string> => (state.selection.ranges.some(r => !r.empty) ? { class: 'cm-has-selection' } : {}),
)

/** 编辑器外观（底色、光标、选区、搜索面板……）；颜色主题扩展会在它上面再盖一层 */
export const editorChrome = [
  selectionMarker,
  EditorView.theme({
    '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg-app)', fontSize: 'var(--text-meta)' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
    '.cm-content': { padding: '8px 0', caretColor: 'var(--accent)' },
    '.cm-line': { padding: '0 14px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' },
    // 选区和应用里其他地方选中文字同色（globals.css 的 ::selection）。CodeMirror 自带的选区色（聚焦时是浅色主题的淡紫，
    // 深色主题下字看不清）选择器更具体，所以这里多写一个 .cm-editor 才盖得住
    '&.cm-editor .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)',
    },
    '&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--bg-hover)' },
    '&.cm-has-selection .cm-activeLine, &.cm-has-selection .cm-activeLineGutter': { backgroundColor: 'transparent' },
    '.cm-gutters': {
      color: 'var(--text-faint)',
      backgroundColor: 'var(--bg-app)',
      borderRight: '1px solid var(--border-layout)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 5px' },
    '.cm-foldGutter span': { color: 'var(--text-muted)' },
    '.cm-tooltip, .cm-panels': {
      color: 'var(--text)',
      backgroundColor: 'var(--bg-popover)',
      borderColor: 'var(--border)',
    },
    // 补全弹窗：和应用里其他弹出菜单一样的底色、边框和阴影；选中项的自带底色（亮蓝 / 深蓝）选择器更具体，多写一层才盖得住
    '.cm-tooltip.cm-tooltip-autocomplete': {
      borderColor: 'var(--border-card)',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-popover)',
    },
    // 圆角裁在列表上：弹窗本身不能 overflow: hidden，片段说明面板挂在弹窗外侧
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-meta)',
      borderRadius: 'inherit',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px', lineHeight: '1.6' },
    '&.cm-editor .cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]': {
      color: 'var(--text)',
      background: 'var(--accent-soft)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section': {
      padding: '4px 10px 2px',
      fontFamily: 'var(--font-sans)',
      color: 'var(--text-faint)',
      borderBottom: '1px solid var(--border-subtle)',
      opacity: '1',
    },
    '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
    '.cm-completionDetail': { marginLeft: '14px', fontStyle: 'normal', color: 'var(--text-faint)' },
    '.cm-panel.cm-search': { padding: '8px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-meta)' },
    '.cm-dialog': { padding: '8px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-meta)' },
    '.cm-dialog input, .cm-dialog button': {
      color: 'var(--text)',
      background: 'var(--bg-subtle)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-md)',
      font: 'inherit',
    },
    '.cm-textfield, .cm-button': {
      color: 'var(--text)',
      background: 'var(--bg-subtle)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-md)',
      fontFamily: 'var(--font-sans)',
    },
    '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent-border)' },
    '.cm-searchMatch-selected': { backgroundColor: 'var(--bg-selected)', outline: '1px solid var(--accent)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--bg-selected)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', color: 'var(--accent-text)' },
    '.cm-git-gutter': { width: '5px' },
    '.cm-git-added': { borderLeft: '3px solid var(--success)' },
    '.cm-git-modified': { borderLeft: '3px solid var(--syn-func)' },
    '.cm-git-deleted': { borderTop: '3px solid var(--danger)' },
    '.cm-external-change': { backgroundColor: 'var(--accent-soft)' },
  }),
]

/** 默认的语法着色（--syn-* 变量）；用了扩展的颜色主题时整个拿掉 */
export const baseHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.comment], color: 'var(--syn-comment)' },
    { tag: [tags.keyword, tags.operator], color: 'var(--syn-keyword)' },
    { tag: [tags.string, tags.regexp], color: 'var(--syn-string)' },
    { tag: [tags.character], color: 'var(--syn-string)' },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syn-number)' },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syn-func)' },
    { tag: [tags.heading], color: 'var(--syn-func)' },
    { tag: [tags.typeName, tags.className], color: 'var(--syn-type)' },
    // 注解（Java 的 @Override、Python 的装饰器）在各语言里都是 meta
    { tag: [tags.meta, tags.tagName, tags.attributeName], color: 'var(--syn-meta)' },
  ]),
)

/**
 * 键名上色（JSON、YAML、properties 的键），和对话里代码块的属性名同色（--syn-type）。
 * 只在传入的语言里生效：TS / JS 的成员访问也是属性名，全局上色会满屏都是这个颜色
 */
export const keyHighlight = (language: Language): Extension =>
  syntaxHighlighting(HighlightStyle.define([{ tag: tags.propertyName, color: 'var(--syn-type)' }], { scope: language }))

export const editorPhrases = {
  get Find() {
    return tr('editor.code.theme.find')
  },
  get Replace() {
    return tr('editor.code.theme.replace')
  },
  get 'Replace all'() {
    return tr('editor.code.theme.replaceAll')
  },
  get replace() {
    return tr('editor.code.theme.replace')
  },
  get 'replace all'() {
    return tr('editor.code.theme.replaceAll')
  },
  get next() {
    return tr('editor.code.theme.next')
  },
  get previous() {
    return tr('editor.code.theme.previous')
  },
  get all() {
    return tr('editor.code.theme.all')
  },
  get 'match case'() {
    return tr('editor.code.theme.matchCase')
  },
  get regexp() {
    return tr('editor.code.theme.regularExpression')
  },
  get 'by word'() {
    return tr('editor.code.theme.wholeWords')
  },
  get close() {
    return tr('editor.code.theme.close')
  },
  get 'Go to line'() {
    return tr('editor.code.theme.goToLine')
  },
  get go() {
    return tr('editor.code.theme.go')
  },
  get 'Fold line'() {
    return tr('editor.code.theme.foldLine')
  },
  get 'Unfold line'() {
    return tr('editor.code.theme.unfoldLine')
  },
  get to() {
    return tr('editor.code.theme.replaceWith')
  },
  get 'No matches'() {
    return tr('editor.code.theme.noMatches')
  },
}
