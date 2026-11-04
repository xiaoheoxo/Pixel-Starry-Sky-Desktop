/// <reference path="../pixelsky.d.ts" />
// 插入时间戳：读权限只用来拿光标和选区的位置

const pad = n => String(n).padStart(2, '0')

function local(d) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function insert(text) {
  const { selection } = await pixelsky.editor.getContext()
  await pixelsky.editor.replaceRange(selection.from, selection.to, text)
}

pixelsky.commands.register('local', () => insert(local(new Date())))
pixelsky.commands.register('iso', () => insert(new Date().toISOString()))
