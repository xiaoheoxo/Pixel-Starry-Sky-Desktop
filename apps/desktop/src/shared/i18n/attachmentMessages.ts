// 输入框里的文本文件附件（docs/ui/composer-file-attachments.md）；宿主报的错（protocol/files.ts）也在这里翻译
export const attachmentMessages = {
  'composer.file.add': { zh: '图片或文件', en: 'Image or file' },
  'composer.file.drop': { zh: '松开以添加图片或文件', en: 'Drop to add images or files' },
  'composer.file.tooLarge': {
    zh: '{p0} 太大，文件不能超过 50 MB',
    en: '{p0} is too large. Files must be 50 MB or smaller',
  },
  'composer.file.remoteTooLarge': {
    zh: '{p0} 超过临时文件引用上限 1 GB',
    en: '{p0} exceeds the 1 GB limit for staged file references',
  },
  'composer.file.uploading': {
    zh: '正在上传 {p0}：{p1}%（{p2} / {p3}）',
    en: 'Uploading {p0}: {p1}% ({p2} / {p3})',
  },
  'composer.file.cancelUpload': { zh: '取消上传', en: 'Cancel upload' },
  'composer.file.uploadCancelled': { zh: '已取消上传', en: 'Upload cancelled' },
  'composer.file.stageUnavailable': {
    zh: '当前会话无法保存文件引用；请先选择一个项目或会话工作区',
    en: 'File references need an active project or session workspace',
  },
  'composer.file.binary': {
    zh: '{p0} 不能直接发给智能体（支持文本、日志、代码、配置文件，以及 Word、Excel、PPT、PDF、OpenDocument、RTF、EPUB 文档）',
    en: '{p0} can’t be sent to the agent (text, logs, code, config files and Word, Excel, PowerPoint, PDF, OpenDocument, RTF and EPUB documents are supported)',
  },
  // 从文档提取文字（docs/ui/composer-file-attachments.md §7）
  'composer.file.legacyOffice': {
    zh: '{p0} 是旧版 Office 格式，请用 {p1} 另存为 {p2} 后再添加',
    en: '{p0} uses an old Office format. Save it as {p2} in {p1}, then add it',
  },
  'composer.file.encrypted': {
    zh: '{p0} 有打开密码，读不了；去掉密码后再添加',
    en: '{p0} is password-protected and can’t be read. Remove the password, then add it',
  },
  'composer.file.archive': {
    zh: '{p0} 是压缩包，不能直接添加；解压后把需要的文件拖进来',
    en: '{p0} is an archive and can’t be added. Extract it and add the files you need',
  },
  'composer.file.archiveList': { zh: '里面有 {p0} 个文件：{p1}', en: '{p0} files inside: {p1}' },
  'composer.file.listSep': { zh: '、', en: ', ' },
  'composer.file.notDocument': {
    zh: '{p0} 不是能读的 Office 文件：可能被公司的文档加密软件加过密，或者文件坏了。用 Word / Excel / PowerPoint 打开后另存一份再添加',
    en: '{p0} isn’t a readable Office file: it may be protected by document-encryption software, or damaged. Open it and save a copy, then add that',
  },
  'composer.file.unzipTooLarge': {
    zh: '{p0} 解压后超过 256 MB，太大了读不了',
    en: '{p0} is over 256 MB once unpacked, too large to read',
  },
  'composer.file.broken': { zh: '{p0} 打不开，文件可能损坏了', en: '{p0} couldn’t be opened; the file may be damaged' },
  'composer.file.noText': { zh: '{p0} 里没有能提取的文字', en: 'No text could be extracted from {p0}' },
  'composer.file.textOnly': { zh: '只带文字', en: 'Text only' },
  'composer.file.textOnlyHint': {
    zh: '发的是从{p0}里提取的文字，图片和排版不带',
    en: 'Sends the text extracted from this {p0}; images and layout are left out',
  },
  'composer.file.headOnlyHint': {
    zh: '太长了，只带了前 {p0} 行，后面 {p1} 行没带',
    en: 'Too long: only the first {p0} lines are sent; the remaining {p1} are left out',
  },
  'composer.file.headOnly': { zh: '… 后面还有 {p0} 行没带 …', en: '… {p0} more lines left out …' },
  'composer.file.source.docx': { zh: 'Word 文档', en: 'Word document' },
  'composer.file.source.xlsx': { zh: 'Excel 表格', en: 'Excel workbook' },
  'composer.file.source.pptx': { zh: 'PPT 演示文稿', en: 'PowerPoint deck' },
  'composer.file.source.odt': { zh: 'OpenDocument 文档', en: 'OpenDocument text' },
  'composer.file.source.ods': { zh: 'OpenDocument 表格', en: 'OpenDocument spreadsheet' },
  'composer.file.source.odp': { zh: 'OpenDocument 演示文稿', en: 'OpenDocument presentation' },
  'composer.file.source.pdf': { zh: 'PDF', en: 'PDF' },
  'composer.file.source.rtf': { zh: 'RTF 文档', en: 'RTF document' },
  'composer.file.source.epub': { zh: 'EPUB 电子书', en: 'EPUB book' },
  'composer.file.source.html': { zh: '网页', en: 'web page' },
  'composer.file.source.ipynb': { zh: 'Jupyter 笔记本', en: 'Jupyter notebook' },
  'composer.file.scanned': {
    zh: '{p0} 是扫描的图片，提取不到文字；可以截图后当图片添加',
    en: '{p0} is a scanned image with no text to extract. Take a screenshot and add it as an image',
  },
  'composer.extract.page': { zh: '第 {p0} 页', en: 'Page {p0}' },
  'composer.extract.noTextPage': { zh: '（这一页没有文字）', en: '(no text on this page)' },
  'composer.extract.pdfPartial': {
    zh: '（一共 {p0} 页，内容太长，只读了前 {p1} 页）',
    en: '({p0} pages in total; too long, so only the first {p1} were read)',
  },
  'composer.extract.comments': { zh: '批注', en: 'Comments' },
  'composer.extract.sheet': { zh: '工作表「{p0}」', en: 'Sheet "{p0}"' },
  'composer.extract.sheetSize': { zh: '{p0} 行 × {p1} 列', en: '{p0} rows × {p1} columns' },
  'composer.extract.sheetLimit': {
    zh: '（只带了前 {p0} 行，一共 {p1} 行）',
    en: '(only the first {p0} of {p1} rows are included)',
  },
  'composer.extract.emptySheet': { zh: '（空表）', en: '(empty)' },
  'composer.extract.slide': { zh: '第 {p0} 页', en: 'Slide {p0}' },
  'composer.extract.notes': { zh: '备注', en: 'Notes' },
  'composer.extract.output': { zh: '输出', en: 'Output' },
  'composer.extract.outputCut': { zh: '…（输出太长，后面没带）', en: '… (output too long; the rest is left out)' },
  'composer.extract.imageOutput': { zh: '（图片输出，没带）', en: '(image output, not included)' },
  'composer.file.tooMany': { zh: '一条消息最多添加 10 个文件', en: 'You can add up to 10 files per message' },
  'composer.file.totalTooLarge': {
    zh: '文件内容合计不能超过 300 KB，请移除一些文件',
    en: 'Files can add up to 300 KB of text per message. Remove some files',
  },
  'composer.file.invalid': { zh: '文件附件格式不正确', en: 'Invalid file attachment' },
  'composer.file.saveError': {
    zh: '文件草稿保存失败，当前文件仍保留，请重试',
    en: 'Could not save the file draft. Your files are preserved; please retry',
  },
  'composer.file.restoreError': {
    zh: '文件草稿读取失败，请重新打开或添加文件',
    en: 'Could not restore file drafts. Reopen the conversation or add files again',
  },
  'composer.file.lines': { zh: '{p0} 行', en: '{p0} lines' },
  'composer.file.tokens': { zh: '约 {p0} tokens', en: '~{p0} tokens' },
  'composer.file.truncated': { zh: '已截断', en: 'Truncated' },
  'composer.file.truncatedHint': {
    zh: '文件较大，只带上开头 {p0} 行和结尾 {p1} 行，中间 {p2} 行省略',
    en: 'Large file: only the first {p0} and last {p1} lines are sent; {p2} lines in between are left out',
  },
  'composer.file.byPath': { zh: '可按路径读全文', en: 'Full file via path' },
  'composer.file.pathOnly': { zh: '路径引用', en: 'Path reference' },
  'composer.file.staged': { zh: '临时引用 · 30 天后清理', en: 'Temporary · removed after 30 days' },
  'composer.file.referencePreviewHint': {
    zh: '发送文件路径，不内联文件内容',
    en: 'Sends a file path without inlining its contents',
  },
  'composer.file.referencePreview': {
    zh: '文件内容未复制到消息中，智能体会从此路径读取：{p0}',
    en: 'The file contents are not copied into the message. The agent will read this path: {p0}',
  },
  'composer.file.referenceHint': {
    zh: '文件内容未内联；智能体会按路径读取：{p0}',
    en: 'Contents are not inlined; the agent will read the file at: {p0}',
  },
  'composer.file.byPathHint': {
    zh: '中间省略的部分智能体可以按路径读完整文件：{p0}',
    en: 'The agent can read the omitted part from the full file: {p0}',
  },
  'composer.file.path': { zh: '路径：{p0}', en: 'Path: {p0}' },
  'composer.file.omitted': { zh: '… 中间省略 {p0} 行 …', en: '… {p0} lines left out …' },
  'composer.file.secret': { zh: '可能含密钥', en: 'May contain secrets' },
  'composer.file.secretHint': {
    zh: '文件名看起来像放密钥的，发送前请确认里面没有不该发出去的内容',
    en: 'This file name looks like it holds secrets. Make sure nothing in it should stay private before sending',
  },
  'composer.file.preview': { zh: '预览文件', en: 'Preview file' },
  'composer.file.previewHint': { zh: '发给智能体的内容', en: 'What the agent receives' },
  'composer.file.remove': { zh: '移除文件', en: 'Remove file' },
  'composer.file.closePreview': { zh: '关闭预览', en: 'Close preview' },
  'composer.file.encoding': { zh: '编码 {p0}', en: 'Encoding {p0}' },
  // 拖进来的文件夹（GitHub #15）
  'composer.folder.remote': {
    zh: '这个会话在远程机器上，看不到本机的文件夹；可以用 @ 引用远程机器上的文件',
    en: 'This conversation runs on a remote machine and can’t see folders on this computer. Use @ to reference files on the remote machine',
  },
  'composer.folder.noPath': {
    zh: '拿不到这个文件夹在磁盘上的路径，请从资源管理器拖进来，或用 @ 引用',
    en: 'Couldn’t get this folder’s path on disk. Drag it from File Explorer, or reference it with @',
  },
  // 粘贴的长文本折成标签（docs/ui/composer-paste-fold.md）
  'composer.paste.label': { zh: '粘贴的文本 #{id}', en: 'Pasted text #{id}' },
  'composer.paste.lines': { zh: '{count} 行', en: '{count} lines' },
  'composer.paste.chars': { zh: '{count} 字', en: '{count} chars' },
  'composer.paste.expand': { zh: '点开查看和修改', en: 'Click to view and edit' },
  'composer.paste.collapse': { zh: '收起', en: 'Collapse' },
  'composer.input': { zh: '消息输入框', en: 'Message input' },
} as const
