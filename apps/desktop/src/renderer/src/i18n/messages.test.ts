import { afterEach, describe, expect, it } from 'vitest'
import { allMessages, setCurrentLocale, tr, translateText, translateMessage } from './core'
import { searchSettings } from '../features/settings/searchIndex'

afterEach(() => setCurrentLocale('zh-CN'))
describe('中英文词典', () => {
  it('两种语言完整且插值参数一致', () => {
    for (const [key, value] of Object.entries(allMessages)) {
      expect(value.zh.trim(), key).not.toBe('')
      expect(value.en.trim(), key).not.toBe('')
      const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
      expect(params(value.en), key).toEqual(params(value.zh))
    }
  })
  it('宿主动态错误可以切回中文，原始引擎输出保持原文', () => {
    expect(translateMessage('工作目录不存在：D:\\中文文件', 'en-US')).toBe('Working directory not found: D:\\中文文件')
    expect(translateMessage('Working directory not found: D:\\中文文件', 'zh-CN')).toBe('工作目录不存在：D:\\中文文件')
    expect(translateMessage('Unexpected tool failure: EXTERNAL_123', 'en-US')).toBe(
      'Unexpected tool failure: EXTERNAL_123',
    )
  })
  it('交接通知带图片说明时也能翻成英文', () => {
    const cases: [string, string][] = [
      ['已把之前的聊天带给 Codex（3 轮）', 'Brought the previous chat to Codex (3 turns)'],
      [
        '已把之前的聊天带给 Codex（3 轮，含 5 张图片）',
        'Brought the previous chat to Codex (3 turns, including 5 image(s))',
      ],
      [
        '已把之前的聊天带给 Codex（3 轮，含 5 张图片，1 张图片未带上）',
        'Brought the previous chat to Codex (3 turns, including 5 image(s), 1 image(s) not carried)',
      ],
      [
        '已把之前的聊天带给 Codex（3 轮，1 张图片未带上）',
        'Brought the previous chat to Codex (3 turns, 1 image(s) not carried)',
      ],
      ['已把 Codex 期间的聊天同步给 Claude Code（2 轮）', 'Synced the chat from Codex to Claude Code (2 turns)'],
      [
        '已把 Codex 期间的聊天同步给 Claude Code（2 轮，含 2 张图片）',
        'Synced the chat from Codex to Claude Code (2 turns, including 2 image(s))',
      ],
      [
        '已把 Codex 期间的聊天同步给 Claude Code（2 轮，含 2 张图片，3 张图片未带上）',
        'Synced the chat from Codex to Claude Code (2 turns, including 2 image(s), 3 image(s) not carried)',
      ],
      [
        '已把 Codex 期间的聊天同步给 Claude Code（2 轮，3 张图片未带上）',
        'Synced the chat from Codex to Claude Code (2 turns, 3 image(s) not carried)',
      ],
      ['已把之前的对话交接给 Codex（4 条）', 'Handed the previous conversation to Codex (4 messages)'],
      [
        '已把之前的对话交接给 Codex（4 条，含 1 张图片）',
        'Handed the previous conversation to Codex (4 messages, including 1 image(s))',
      ],
      [
        '已把之前的对话交接给 Codex（4 条，含 2 张图片，2 张图片未带上）',
        'Handed the previous conversation to Codex (4 messages, including 2 image(s), 2 image(s) not carried)',
      ],
      [
        '已把之前的对话交接给 Codex（4 条，1 张图片未带上）',
        'Handed the previous conversation to Codex (4 messages, 1 image(s) not carried)',
      ],
      ['已把 Codex 期间的进展同步给 Claude Code', 'Synced the progress from Codex to Claude Code'],
      [
        '已把 Codex 期间的进展同步给 Claude Code（含 2 张图片）',
        'Synced the progress from Codex to Claude Code (including 2 image(s))',
      ],
      [
        '已把 Codex 期间的进展同步给 Claude Code（含 2 张图片，1 张图片未带上）',
        'Synced the progress from Codex to Claude Code (including 2 image(s), 1 image(s) not carried)',
      ],
      [
        '已把 Codex 期间的进展同步给 Claude Code（1 张图片未带上）',
        'Synced the progress from Codex to Claude Code (1 image(s) not carried)',
      ],
    ]
    for (const [zh, en] of cases) {
      expect(translateMessage(zh, 'en-US'), zh).toBe(en)
      expect(translateMessage(en, 'zh-CN'), en).toBe(zh)
    }
  })
  it('不知道是哪个引擎处理的那段时，同步通知里的「其他引擎」也能翻成英文', () => {
    const cases: [string, string][] = [
      [
        '已把其他引擎期间的聊天同步给 Claude Code（2 轮）',
        'Synced the chat from another engine to Claude Code (2 turns)',
      ],
      [
        '已把其他引擎期间的聊天同步给 Claude Code（2 轮，含 2 张图片）',
        'Synced the chat from another engine to Claude Code (2 turns, including 2 image(s))',
      ],
      [
        '已把其他引擎期间的聊天同步给 Claude Code（2 轮，含 2 张图片，3 张图片未带上）',
        'Synced the chat from another engine to Claude Code (2 turns, including 2 image(s), 3 image(s) not carried)',
      ],
      [
        '已把其他引擎期间的聊天同步给 Claude Code（2 轮，3 张图片未带上）',
        'Synced the chat from another engine to Claude Code (2 turns, 3 image(s) not carried)',
      ],
      ['已把其他引擎期间的进展同步给 Claude Code', 'Synced the progress from another engine to Claude Code'],
      [
        '已把其他引擎期间的进展同步给 Claude Code（含 2 张图片）',
        'Synced the progress from another engine to Claude Code (including 2 image(s))',
      ],
      [
        '已把其他引擎期间的进展同步给 Claude Code（含 2 张图片，1 张图片未带上）',
        'Synced the progress from another engine to Claude Code (including 2 image(s), 1 image(s) not carried)',
      ],
      [
        '已把其他引擎期间的进展同步给 Claude Code（1 张图片未带上）',
        'Synced the progress from another engine to Claude Code (1 image(s) not carried)',
      ],
    ]
    for (const [zh, en] of cases) {
      expect(translateMessage(zh, 'en-US'), zh).toBe(en)
      expect(translateMessage(en, 'zh-CN'), en).toBe(zh)
    }
  })
  it('接着终端里的 Codex 会话的分隔条和提示都能翻成英文', () => {
    const pairs: [string, string][] = [
      ['接着终端里的 Codex 会话 · 3 轮', 'Continuing the Codex session from the terminal · 3 turns'],
      [
        '接着 Codex 会话（来自其他程序）· 3 轮（更早的 2 轮没有显示）',
        'Continuing a Codex session (from another program) · 3 turns (2 earlier turns not shown)',
      ],
      [
        '复制了终端里的 Codex 会话 · 3 轮（原会话不动，两边可以同时用）',
        'Copied the Codex session from the terminal · 3 turns (the original is untouched; both can be used at the same time)',
      ],
      [
        '复制了其他程序的 Codex 会话 · 3 轮（旧格式的线程不能原地回退，复制成新线程接着聊，原会话不动）（更早的 2 轮没有显示）',
        'Copied a Codex session from another program · 3 turns (legacy-format threads can’t be rewound in place, so it was copied into a new thread; the original is untouched) (2 earlier turns not shown)',
      ],
      [
        'Codex 的会话记录不在了，已把像素星空里的聊天（2 轮）写进新的引擎会话（工具调用和文件改动没有带过去）',
        'The Codex session record is gone. The chat from Pixel Starry Sky (2 turns) was written into a new engine session (tool calls and file changes were not carried over)',
      ],
      ['Codex 没装好，读不到它的会话：spawn ENOENT', 'Codex isn’t set up, so its sessions can’t be read: spawn ENOENT'],
      ['这一轮带着编辑器的上下文', 'This turn carried context from the editor'],
      ['这个会话还没有聊完的一轮，没法复制', 'This session has no finished turn yet, so it can’t be copied'],
    ]
    for (const [zh, en] of pairs) expect(translateMessage(zh, 'en-US'), zh).toBe(en)
  })
  it('模型不能看图的更正提示中英文互译', () => {
    const en = "The current model can't view images, so 2 earlier image(s) were not actually passed along"
    expect(translateMessage(en, 'zh-CN')).toBe('当前模型不能看图，之前的 2 张图片实际没有带上')
    expect(translateMessage('当前模型不能看图，之前的 2 张图片实际没有带上', 'en-US')).toBe(en)
  })
  it('Codex 换模型、像素星空防空转停下的提示翻成中文', () => {
    expect(
      translateMessage(
        'Codex switched the model from gpt-5.5 to gpt-5.5-mini: the request was flagged as high-risk cybersecurity activity',
        'zh-CN',
      ),
    ).toBe('Codex 把模型从 gpt-5.5 换成了 gpt-5.5-mini：请求被判定为高风险网络安全活动')
    expect(translateMessage('Codex switched the model from a to b', 'zh-CN')).toBe('Codex 把模型从 a 换成了 b')
    expect(
      translateMessage(
        'Stopped this run: the agent repeated the same "edit" call 4 times in a row with the same result. Send a message to continue.',
        'zh-CN',
      ),
    ).toBe('这一轮已停下：智能体连着 4 次用同样的参数调用「edit」，结果都一样。发一条消息可以接着做。')
    expect(
      translateMessage(
        'Stopped this run: every tool call failed for 6 steps in a row. Send a message to continue.',
        'zh-CN',
      ),
    ).toBe('这一轮已停下：连着 6 步工具调用全部失败。发一条消息可以接着做。')
    expect(translateMessage('waiting for network', 'zh-CN')).toBe('等待网络恢复')
  })
  it('几乎只有占位符的模板不会改坏引擎原文', () => {
    for (const text of [
      'Reconnecting... 3/5',
      'stream disconnected',
      'Too many requests',
      'Bad Gateway: upstream',
      'local · main',
    ]) {
      expect(translateMessage(text, 'zh-CN')).toBe(text)
    }
    expect(translateMessage('3月5日', 'en-US')).toBe('3月5日')
    // 有足够固定文字的宿主模板照常双向翻译
    expect(translateMessage('退出码 3', 'en-US')).not.toBe('退出码 3')
  })
  it('动态参数保留用户原始文字，包括插值符号', () => {
    setCurrentLocale('en-US')
    expect(tr('files.FileConfirm.hasUnsavedChanges', { p0: '中文文件{p0}.ts' })).toBe(
      '中文文件{p0}.ts has unsaved changes',
    )
    expect(translateText('用户项目名称')).toBe('用户项目名称')
    expect(translateText('src/中文文件.ts')).toBe('src/中文文件.ts')
  })
  it('英文设置搜索可以命中并保留稳定的原始定位标题', () => {
    setCurrentLocale('en-US')
    expect(searchSettings('language', s => s).some(e => e.title === '界面语言')).toBe(true)
    expect(searchSettings('compaction', s => s).some(e => e.title === '压缩上下文用的模型')).toBe(true)
    expect(searchSettings('主题', s => s).some(e => e.title === '主题')).toBe(true)
    expect(searchSettings('do not disturb', s => s).some(e => e.title === '勿扰')).toBe(true)
    expect(searchSettings('Reply failed', s => s).some(e => e.title === '回复出错')).toBe(true)
  })
})
