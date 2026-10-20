// 代码编辑器：把选中的代码引用到对话（docs/ui/editor-quote.md）、右键菜单
export const editorMessages = {
  // Markdown 预览（docs/ui/markdown-preview.md）
  'editor.preview.toc': { zh: '目录', en: 'Contents' },
  'editor.quote.action': { zh: '引用到对话', en: 'Quote in chat' },
  'editor.quote.palette': { zh: '把选中的代码引用到对话', en: 'Quote selected code in chat' },
  'editor.quote.noSession': {
    zh: '没有能引用到的会话，先打开一个会话',
    en: 'No conversation to quote into. Open a conversation first.',
  },
  'editor.quote.tooLong': {
    zh: '选中的内容太长（{lines} 行、{chars} 字），最多 {maxLines} 行、{maxChars} 字。缩小范围，或让智能体直接读这个文件',
    en: 'Selection is too long ({lines} lines, {chars} characters); the limit is {maxLines} lines and {maxChars} characters. Select less, or ask the agent to read the file.',
  },
  'editor.menu.label': { zh: '编辑器菜单', en: 'Editor menu' },
  'editor.menu.cut': { zh: '剪切', en: 'Cut' },
  'editor.menu.copy': { zh: '复制', en: 'Copy' },
  'editor.menu.paste': { zh: '粘贴', en: 'Paste' },
  'editor.menu.selectAll': { zh: '全选', en: 'Select all' },
  // 顶栏「打开方式」（GitHub #12）
  'openWith.openWith': { zh: '用 {p0} 打开 {p1}', en: 'Open {p1} in {p0}' },
  'openWith.choose': { zh: '选择打开工作区的程序', en: 'Choose an app to open the workspace' },
  'openWith.more': { zh: '打开方式', en: 'Open with' },
  'openWith.title': { zh: '打开「{p0}」', en: 'Open “{p0}”' },
  'openWith.workspace': { zh: '工作区', en: 'workspace' },
  'openWith.noWorkspace': { zh: '先打开一个会话或选一个项目', en: 'Open a conversation or choose a project first' },
  'openWith.editors': { zh: '编辑器', en: 'Editors' },
  'openWith.tools': { zh: '文件夹和终端', en: 'Folder and terminals' },
  'openWith.explorer': { zh: '文件资源管理器', en: 'File Explorer' },
  'openWith.openedIn': { zh: '已在{tool}中打开 {name}', en: 'Opened {name} in {tool}' },
  'openWith.finder': { zh: '访达', en: 'Finder' },
  'openWith.files': { zh: '文件管理器', en: 'Files' },
  'openWith.terminal': { zh: '终端', en: 'Terminal' },
  'openWith.default': { zh: '默认', en: 'Default' },
  'openWith.setDefault': { zh: '设为默认', en: 'Set as default' },
  'openWith.detecting': { zh: '正在查找本机的编辑器…', en: 'Looking for editors on this computer…' },
  'openWith.settings': { zh: '编辑器设置…', en: 'Editor settings…' },
  // 自动保存（参考 VS Code 的 files.autoSave）
  'editor.autoSave.title': { zh: '自动保存', en: 'Auto save' },
  'editor.autoSave.description': {
    zh: '像素星空内置编辑器里有未保存改动的文件，什么时候自动保存',
    en: 'When files with unsaved changes in the built-in editor are saved automatically',
  },
  'editor.autoSave.off': { zh: '关闭', en: 'Off' },
  'editor.autoSave.afterDelay': { zh: '停止输入后', en: 'After a delay' },
  'editor.autoSave.onFocusChange': { zh: '编辑器失去焦点时', en: 'When the editor loses focus' },
  'editor.autoSave.onWindowChange': { zh: '窗口失去焦点时', en: 'When the window loses focus' },
  'editor.autoSave.default': { zh: '默认', en: 'Default' },
  'editor.autoSave.hint.off': {
    zh: '不自动保存，按 Ctrl+S 保存',
    en: 'Files are not saved automatically. Press Ctrl+S to save.',
  },
  'editor.autoSave.hint.afterDelay': {
    zh: '停止输入 {seconds} 秒后自动保存',
    en: 'Saved automatically {seconds} s after you stop typing',
  },
  'editor.autoSave.hint.onFocusChange': {
    zh: '点到编辑器以外的地方、换标签页或切到别的窗口时，自动保存有改动的文件',
    en: 'Saved when you click outside the editor, switch tabs, or switch to another window',
  },
  'editor.autoSave.hint.onWindowChange': {
    zh: '切到别的窗口时，自动保存有改动的文件',
    en: 'Saved when you switch to another window',
  },
  'editor.autoSave.note': {
    zh: 'AI 正在这个项目里干活时先不存，等它停下再存；文件在磁盘上被别处改过时不存，在标签页上提示',
    en: 'While the AI is working in the project, saving waits until it stops. Files changed on disk elsewhere are not saved; the tab shows the conflict.',
  },
  'editor.autoSave.delay': { zh: '延迟（毫秒）', en: 'Delay (ms)' },
  'editor.autoSave.keywords': {
    zh: '自动保存 保存 失去焦点 延迟 auto save autosave focus delay',
    en: 'auto save autosave focus delay save 自动保存 保存 失去焦点',
  },
}
