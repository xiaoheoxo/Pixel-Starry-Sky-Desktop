/// <reference path="../pixelsky.d.ts" />
// JSON 排版：解析失败时抛错，软件会显示错误提示，文件不动

pixelsky.commands.register('format', async () => {
  const { selection, length } = await pixelsky.editor.getContext()
  const whole = selection.from === selection.to
  const text = whole ? await pixelsky.editor.getText() : selection.text
  const formatted = JSON.stringify(JSON.parse(text), null, 2)
  if (whole) await pixelsky.editor.replaceRange(0, length, formatted + '\n')
  else await pixelsky.editor.replaceRange(selection.from, selection.to, formatted)
})
