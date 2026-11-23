// 目标模式（Codex、oh-my-pi 的 /goal，docs/ui/codex-goal.md、docs/omp-engine.md §13.1）：{engine} 是引擎名。输入框上方的目标栏、/goal 的结果提示，以及引擎在对话里说的话（NATIVE_TEXT.goal*）
export const goalMessages = {
  'goal.bar.label': { zh: '目标', en: 'Goal' },
  'goal.bar.region': { zh: '当前目标', en: 'Current goal' },
  'goal.bar.tokens': { zh: '已用 {used} token', en: '{used} tokens used' },
  'goal.bar.tokensBudget': { zh: '已用 {used} / {budget} token', en: '{used} / {budget} tokens used' },
  'goal.bar.time': { zh: '用时 {time}', en: '{time} elapsed' },
  'goal.bar.pause': { zh: '暂停', en: 'Pause' },
  'goal.bar.resume': { zh: '继续', en: 'Resume' },
  'goal.bar.clear': { zh: '清除', en: 'Clear' },
  'goal.bar.pauseHint': {
    zh: '暂停后 {engine} 做完这一轮就停下，不再自己接着开下一轮',
    en: 'After pausing, {engine} stops when this turn ends instead of starting the next one',
  },
  'goal.bar.resumeHint': { zh: '{engine} 接着朝这个目标做', en: '{engine} keeps working toward this goal' },
  'goal.bar.clearHint': {
    zh: '清除目标（不会停止正在跑的这一轮）',
    en: 'Clear the goal (the current turn keeps running)',
  },
  'goal.bar.expand': { zh: '展开看完整目标', en: 'Show the full goal' },
  'goal.bar.collapse': { zh: '收起', en: 'Collapse' },
  'goal.bar.full': { zh: '完整目标', en: 'Full goal' },
  'goal.bar.edit': { zh: '改目标', en: 'Edit goal' },
  'goal.bar.editCancel': { zh: '取消', en: 'Cancel' },
  'goal.bar.editSave': { zh: '换成新目标', en: 'Replace goal' },
  'goal.bar.editHint': {
    zh: '换目标等于重新发 /goal，{engine} 按新目标接着做',
    en: 'Same as sending /goal again: {engine} continues with the new goal',
  },
  'goal.bar.statStatus': { zh: '状态', en: 'Status' },
  'goal.bar.statTokens': { zh: '已用 token', en: 'Tokens used' },
  'goal.bar.statNoBudget': { zh: '{used}（没设预算）', en: '{used} (no budget)' },
  'goal.bar.statTime': { zh: '用时', en: 'Elapsed' },
  'goal.bar.statUpdated': { zh: '最后更新', en: 'Last update' },
  'goal.bar.plan': { zh: '当前计划', en: 'Current plan' },
  'goal.bar.hint.blocked': {
    zh: 'Codex 说卡住了：看最后一轮的说明，补充信息后点「继续」，或者改目标',
    en: 'Codex is blocked: read the last turn, add what it needs and resume, or edit the goal',
  },
  'goal.bar.hint.usageLimited': {
    zh: '额度用完了：额度恢复或换账号后点「继续」',
    en: 'Usage limit reached: resume once the limit resets or after switching accounts',
  },
  'goal.bar.hint.budgetLimited': {
    zh: 'token 预算用完了：点「继续」接着做，或者改目标',
    en: 'Token budget used up: resume to keep going, or edit the goal',
  },
  'goal.status.active': { zh: '进行中', en: 'In progress' },
  'goal.status.paused': { zh: '已暂停', en: 'Paused' },
  'goal.status.blocked': { zh: '卡住了', en: 'Blocked' },
  'goal.status.usageLimited': { zh: '额度用完', en: 'Usage limit reached' },
  'goal.status.budgetLimited': { zh: '预算用完', en: 'Budget used up' },
  'goal.status.complete': { zh: '已完成', en: 'Complete' },
  // 引擎在对话里说的话（packages/engine/src/native/text.ts 的 goal*，原文要一字不差）
  'goal.native.set': {
    zh: '已设目标：{p0}。Codex 会一轮接一轮地做，直到完成；输入 /goal pause 暂停，/goal clear 清除',
    en: 'Goal set: {p0}. Codex will keep working turn after turn until it’s done. Type /goal pause to pause or /goal clear to clear it',
  },
  'goal.native.waiting': {
    zh: 'Codex 已经记下目标，会自己接着做',
    en: 'Codex saved the goal and will keep working on it',
  },
  'goal.native.none': {
    zh: '这个对话没有目标。输入 /goal 加上要达成的目标来设一个',
    en: 'This conversation has no goal. Type /goal followed by what you want done to set one',
  },
  'goal.native.showActive': { zh: '当前目标（进行中）：{p0}', en: 'Current goal (in progress): {p0}' },
  'goal.native.showPaused': { zh: '当前目标（已暂停）：{p0}', en: 'Current goal (paused): {p0}' },
  'goal.native.showBlocked': { zh: '当前目标（卡住了）：{p0}', en: 'Current goal (blocked): {p0}' },
  'goal.native.showUsageLimited': {
    zh: '当前目标（额度用完）：{p0}',
    en: 'Current goal (usage limit reached): {p0}',
  },
  'goal.native.showBudgetLimited': { zh: '当前目标（预算用完）：{p0}', en: 'Current goal (budget used up): {p0}' },
  'goal.native.showComplete': { zh: '当前目标（已完成）：{p0}', en: 'Current goal (complete): {p0}' },
  'goal.native.paused': { zh: '目标已暂停', en: 'Goal paused' },
  'goal.native.resumed': { zh: '目标继续进行', en: 'Goal resumed' },
  'goal.native.cleared': { zh: '目标已清除', en: 'Goal cleared' },
  'goal.native.complete': { zh: '目标已完成：{p0}', en: 'Goal complete: {p0}' },
  'goal.native.blocked': {
    zh: '目标卡住了，Codex 需要你帮忙：{p0}',
    en: 'Codex is stuck on the goal and needs your help: {p0}',
  },
  'goal.native.usageLimited': { zh: '额度用完了，目标先停下', en: 'Usage limit reached, so the goal is on hold' },
  'goal.native.budgetLimited': { zh: '目标的 token 预算用完了', en: 'The goal’s token budget is used up' },
  'goal.native.unsupported': {
    zh: '这个 Codex 版本没有目标模式（/goal），请更新到 0.128 以上',
    en: 'This Codex version doesn’t support goals (/goal). Update to 0.128 or later',
  },
  'goal.native.ompSet': {
    zh: '已设目标：{p0}。oh-my-pi 会一轮接一轮地做，直到完成；输入 /goal pause 暂停，/goal clear 清除',
    en: 'Goal set: {p0}. oh-my-pi will keep working turn after turn until it’s done. Type /goal pause to pause or /goal clear to clear it',
  },
  'goal.native.ompUnsupported': {
    zh: '这个 oh-my-pi 版本没有目标模式（/goal），请在终端运行 omp update',
    en: 'This oh-my-pi version doesn’t support goals (/goal). Run omp update in a terminal',
  },
  'goal.native.ompPlan': {
    zh: '先退出计划模式，再设目标或继续目标',
    en: 'Leave plan mode before setting or resuming a goal',
  },
  'goal.native.ompCost': {
    zh: '目标会一轮接一轮地做，一直用平台额度，直到完成或你停下；输入 /goal pause 暂停',
    en: 'A goal keeps working turn after turn and keeps using your platform balance until it’s done or you stop it. Type /goal pause to pause',
  },
  'goal.native.ompIdle': {
    zh: '这一轮没有新的进展，oh-my-pi 先停下了，目标还在；发一条消息就接着做，或者 /goal clear 清除',
    en: 'This turn made no new progress, so oh-my-pi stopped. The goal is still set: send a message to continue, or /goal clear to clear it',
  },
  'goal.native.ompHeld': {
    zh: '设置改了，oh-my-pi 换了进程，目标先停下；发一条消息后接着做',
    en: 'oh-my-pi restarted because a setting changed, so the goal is on hold. Send a message to continue',
  },
  'goal.native.images': {
    zh: '目标只能是文字，/goal 不能带图片',
    en: 'A goal can only be text; /goal can’t include images',
  },
} as const
