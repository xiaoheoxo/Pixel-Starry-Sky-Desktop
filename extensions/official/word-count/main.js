/// <reference path="../pixelsky.d.ts" />
// 字数统计：选中了就统计选中的，否则统计整个文件

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const WORD = /[\p{L}\p{N}_'-]+/gu

function count(text) {
  const cjk = text.match(CJK)?.length ?? 0
  const rest = text.replace(CJK, ' ')
  return {
    words: cjk + (rest.match(WORD)?.length ?? 0),
    chars: [...text.replace(/\s/gu, '')].length,
    lines: text === '' ? 0 : text.split('\n').length,
  }
}

pixelsky.commands.register('count', async () => {
  const { selection } = await pixelsky.editor.getContext()
  const text = selection.text || (await pixelsky.editor.getText())
  const { words, chars, lines } = count(text)
  const zh = Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh')
  await pixelsky.ui.showMessage(
    zh ? `${words} 字（词），${chars} 个字符，${lines} 行` : `${words} words, ${chars} characters, ${lines} lines`,
  )
})
