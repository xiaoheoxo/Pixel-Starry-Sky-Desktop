import { describe, expect, it } from 'vitest'
import { translateMessage } from './translate'

// oh-my-pi 的发现、启动、会话提示是中文原文（packages/engine/src/omp），英文界面按词典翻译
describe('oh-my-pi 的报错和提示', () => {
  it('没装、版本太低、没模型：英文界面能翻，中文界面照原样', () => {
    expect(
      translateMessage(
        '没找到 oh-my-pi（omp）。安装：在 PowerShell 运行 irm https://omp.sh/install.ps1 | iex',
        'en-US',
      ),
    ).toBe('oh-my-pi (omp) not found. Install it in PowerShell: irm https://omp.sh/install.ps1 | iex')
    expect(translateMessage('oh-my-pi 19.0.9 版本太低（需要 19.1.0 以上）：在终端运行 omp update', 'en-US')).toBe(
      'oh-my-pi 19.0.9 is too old (requires 19.1.0 or later). Run omp update in a terminal.',
    )
    expect(
      translateMessage(
        'oh-my-pi 还没有能用的模型：在终端里运行 omp，用 /login 登录或设置 API Key；也可以在模型菜单里改用平台线路',
        'en-US',
      ),
    ).toMatch(/^oh-my-pi has no usable model yet/)
    expect(translateMessage('oh-my-pi 60 秒没有开始处理这条消息，已让它停下', 'en-US')).toBe(
      'oh-my-pi did not start on this message within 60 seconds, so it was stopped',
    )
    expect(translateMessage('oh-my-pi 启动不了', 'zh-CN')).toBe('oh-my-pi 启动不了')
    expect(translateMessage('oh-my-pi 的这个模型不支持 Fast，已关闭', 'en-US')).toBe(
      'This oh-my-pi model does not support Fast, so it was turned off',
    )
    expect(translateMessage('oh-my-pi 换了进程（权限档、设置变了），旁聊被打断，请再问一次', 'en-US')).toMatch(
      /^oh-my-pi restarted/,
    )
  })
})
