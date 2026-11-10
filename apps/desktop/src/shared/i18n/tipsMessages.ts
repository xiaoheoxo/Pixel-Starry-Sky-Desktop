// 功能提示（renderer features/tips，docs/ui/feature-tips.md）：points 用换行分条
export const tipsMessages = {
  'tips.new': { zh: '新功能', en: 'New' },
  'tips.help': { zh: '{name}：说明', en: '{name}: help' },
  'tips.ok': { zh: '知道了', en: 'Got it' },
  'tips.never': { zh: '不再提示任何功能', en: 'Don’t show feature tips' },
  'tips.turnedOff': {
    zh: '功能提示已关闭，可在「设置 › 外观」重新打开',
    en: 'Feature tips are off. Turn them back on in Settings › Appearance',
  },
  'tips.setting.title': { zh: '功能提示', en: 'Feature tips' },
  'tips.setting.desc': {
    zh: '第一次用到某个功能时弹一次说明；看过的不再弹，入口旁的「?」随时能点开',
    en: 'Explain a feature the first time you reach it. Seen tips stay quiet; the ? next to the entry always opens them',
  },
  'tips.setting.reset': { zh: '全部重新显示', en: 'Show all again' },
  'tips.setting.resetDone': { zh: '提示会在下次碰到时重新出现', en: 'Tips will show again next time' },
  'tips.setting.keywords': {
    zh: '功能提示 新手 引导 说明 帮助 问号 不再提示 tips onboarding help',
    en: 'feature tips onboarding help guide',
  },

  'tips.flow.title': {
    zh: '流程：按步骤派活，能并行的同时跑',
    en: 'Flows: split the work, run independent steps together',
  },
  'tips.flow.body': {
    zh: '一件事拆成几步，每步交给一个成员；点「开始运行」才派活。',
    en: 'A request is split into steps, each assigned to a member. Nothing runs until you click Start.',
  },
  'tips.flow.points': {
    zh: '只依赖同一步的几步会同时开工。\n同一项目里并行的步骤各在自己的副本里做，互不覆盖，最后在汇合那步合并回主目录。\n不同项目的步骤直接在各自的主目录做。',
    en: 'Steps that depend only on the same step start together.\nParallel steps in the same project each work in their own copy, then the merge step brings them back.\nSteps in different projects work in their own project folders.',
  },
  'tips.flow.eg': {
    zh: '例：① 写接口 → ② 前端 + ③ 测试 同时 → ④ 汇合',
    en: 'e.g. ① API → ② frontend + ③ tests together → ④ merge',
  },

  'tips.subagent.title': { zh: '子智能体可以用更便宜的模型', en: 'Subagents can use a cheaper model' },
  'tips.subagent.body': {
    zh: '主会话继续用强模型，派出去的子任务改用你指定的模型和强度。',
    en: 'Keep a strong model for the main session and pick the model and effort for subtasks.',
  },
  'tips.subagent.points': {
    zh: '只影响之后派出的子任务，正在跑的不切换。\n这里改的只对本会话有效；长期默认在「设置 › 子智能体」。',
    en: 'Only future subtasks change; running ones keep their settings.\nThis applies to this session only. Defaults live in Settings › Subagents.',
  },
  'tips.subagent.eg': {
    zh: '例：主会话 Astra，子任务统一 Sol · 中',
    en: 'e.g. main session Astra, subtasks Sol · medium',
  },

  'tips.fast.title': { zh: 'Fast：点一下开关，按住升到 Ultrafast', en: 'Fast: click to toggle, hold for Ultrafast' },
  'tips.fast.body': {
    zh: '同样的模型和强度，用更快的通道出字，价格更高。',
    en: 'Same model and effort on a faster lane, at a higher price.',
  },
  'tips.fast.points': {
    zh: '点一下开 / 关 Fast；按住 0.6 秒升级 Ultrafast。\n回答中切换，下一轮才生效。\nUltrafast 只对这个会话生效。',
    en: 'Click to turn Fast on or off; hold 0.6 s for Ultrafast.\nChanges during a reply apply from the next turn.\nUltrafast applies to this session only.',
  },
  'tips.fast.eg': { zh: '按住开关，直到出现「Ultrafast」再松手', en: 'Hold the switch until it says Ultrafast' },

  'tips.queue.title': { zh: '回答中也能继续发：排队或引导', en: 'Keep sending while it replies: queue or steer' },
  'tips.queue.body': { zh: '不用等它说完。', en: 'No need to wait for the reply to finish.' },
  'tips.queue.points': {
    zh: 'Enter：加入队列，这一轮结束后按顺序发。\n引导：把这条交给正在跑的这一轮，它会马上看到并调整。\n插队：中断当前任务，先做这条；队列里的也能撤回、调序。',
    en: 'Enter adds to the queue; queued messages go out in order after this turn.\nSteer hands the message to the running turn so it adjusts right away.\nJump the queue interrupts the current task; queued messages can also be withdrawn or reordered.',
  },
  'tips.queue.eg': {
    zh: '改主意了用「引导」，追加新任务用排队',
    en: 'Changed your mind? Steer. New task? Queue it.',
  },
} as const
