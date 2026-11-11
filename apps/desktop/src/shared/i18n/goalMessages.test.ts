import { describe, expect, it } from 'vitest'
import { GOAL_NO_ENGINE, GOAL_NO_PROCESS, codedError } from '@pixelsky/protocol'
import { translateMessage } from './translate'

// 引擎在对话里说的话是中文原文（packages/engine/src/native/text.ts 的 goal*），英文界面按词典反查
describe('目标模式的文案（docs/ui/codex-goal.md）', () => {
  it('引擎的提示带着目标文字也能翻成英文，中文界面照原样', () => {
    const set =
      '已设目标：把测试修好。全部通过为止。Codex 会一轮接一轮地做，直到完成；输入 /goal pause 暂停，/goal clear 清除'
    expect(translateMessage(set, 'en-US')).toBe(
      'Goal set: 把测试修好。全部通过为止. Codex will keep working turn after turn until it’s done. Type /goal pause to pause or /goal clear to clear it',
    )
    expect(translateMessage(set, 'zh-CN')).toBe(set)
    expect(translateMessage('当前目标（已暂停）：修 bug', 'en-US')).toBe('Current goal (paused): 修 bug')
    expect(translateMessage('目标已完成：修 bug', 'en-US')).toBe('Goal complete: 修 bug')
    expect(translateMessage('目标已暂停', 'en-US')).toBe('Goal paused')
    expect(translateMessage('目标卡住了，像素星空需要你帮忙：修 bug', 'en-US')).toBe(
      'PixelSky is stuck on the goal and needs your help: 修 bug',
    )
    expect(translateMessage('这个 Codex 版本没有目标模式（/goal），请更新到 0.128 以上', 'en-US')).toBe(
      'This Codex version doesn’t support goals (/goal). Update to 0.128 or later',
    )
  })

  it('engine:goal 的错误代码有中英文', () => {
    expect(translateMessage(codedError(GOAL_NO_PROCESS).message, 'zh-CN')).toBe('会话没在运行，发一条消息后再试')
    expect(translateMessage(codedError(GOAL_NO_ENGINE).message, 'en-US')).toBe('This engine doesn’t support goals')
  })
})
