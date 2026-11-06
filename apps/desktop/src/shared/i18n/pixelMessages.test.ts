import { describe, expect, it } from 'vitest'
import { translateMessage } from './translate'

// 像素星空引擎（packages/engine/src/pixel）发中文原文，英文界面按词典翻译（docs/own-cli.md §15）
describe('Pixel 引擎的报错和提示', () => {
  it('固定文字和带参数的都能翻成英文，中文界面照原样', () => {
    expect(translateMessage('引擎进程已退出', 'en-US')).toBe('The engine process has exited')
    expect(translateMessage('Pixel 60 秒没有开始处理这条消息，已让它停下', 'en-US')).toBe(
      'Pixel did not start on this message within 60 seconds, so it was stopped',
    )
    expect(translateMessage('引擎进程已退出', 'zh-CN')).toBe('引擎进程已退出')
  })
  it('启动失败：带「请重新安装」的先认，原因原样带过去', () => {
    expect(translateMessage('Pixel 命令行启动不了：spawn EPERM。请重新安装像素星空', 'en-US')).toBe(
      'The Pixel CLI failed to start: spawn EPERM. Please reinstall Pixel Starry Sky.',
    )
    expect(translateMessage('Pixel 命令行启动不了：spawn EPERM', 'en-US')).toBe(
      'The Pixel CLI failed to start: spawn EPERM',
    )
    expect(translateMessage('Pixel 命令行启动不了', 'en-US')).toBe('The Pixel CLI failed to start')
  })
  it('Windows 上没有 Git Bash 的提示', () => {
    const text =
      '没有找到 Git Bash，只找到了 WSL 的 bash（C:\\Windows\\System32\\bash.exe）：命令会在 Linux 子系统里运行，Windows 的路径和工具用不了。' +
      '请安装 Git for Windows（https://git-scm.com/download/win），装好后点「重新检测」；' +
      '已经装了的话，在 ~/.pixelsky-cli/agent/settings.json 里用 "shellPath" 写上 bash.exe 的完整路径'
    expect(translateMessage(text, 'en-US')).toMatch(/^Git Bash was not found, only the WSL bash \(C:\\Windows/)
  })
})
