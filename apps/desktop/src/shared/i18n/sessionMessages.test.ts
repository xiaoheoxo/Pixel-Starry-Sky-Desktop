import { describe, expect, it } from 'vitest'
import { translateMessage } from './translate'

// 换进程时结束了后台任务的提示是引擎写的中文原文（packages/engine/src/host/sessions.ts 的 BACKGROUND_STOPPED，
// 引擎测试 host.test.ts / switch-background.test.ts 断言的也是这几句），英文界面按词典反查（docs/ui/source-switch.md §9）
describe('换进程时结束了后台任务的提示', () => {
  it('三种原因都能翻成英文，名字原样带过去；中文界面照原样', () => {
    const source = '换了额度来源，结束了正在后台跑的 2 个任务：npm run dev、pytest -x'
    expect(translateMessage(source, 'en-US')).toBe(
      'Switched the credit source and stopped 2 background task(s): npm run dev、pytest -x',
    )
    expect(translateMessage(source, 'zh-CN')).toBe(source)
    expect(translateMessage('换了引擎，结束了正在后台跑的 1 个任务：npm run dev', 'en-US')).toBe(
      'Switched engines and stopped 1 background task(s): npm run dev',
    )
    expect(translateMessage('重启了引擎进程，结束了正在后台跑的 1 个任务：后台子智能体', 'en-US')).toBe(
      'Restarted the engine process and stopped 1 background task(s): 后台子智能体',
    )
  })
})
