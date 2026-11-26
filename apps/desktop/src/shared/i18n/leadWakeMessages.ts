// 牵头唤醒和同一目录排队（docs/multica-learn.md §5、§10、§11.2）
export const leadWakeMessages = {
  'channels.wake.from': { zh: '牵头接手 · {name} 交回了结果', en: 'Lead taking over · {name} handed back a result' },
  'channels.wake.merged': {
    zh: '牵头接手 · {name} 等 {count} 个结果已并入',
    en: 'Lead taking over · {count} results merged ({name} and others)',
  },
  'channels.dirWait.text': {
    zh: '等 {name} 改完「{title}」（同一个目录）',
    en: 'Waiting for {name} to finish "{title}" in the same folder',
  },
  'channels.dirWait.copyNow': { zh: '改用副本马上开始', en: 'Use a copy and start now' },
  'channels.dialog.leadWake': {
    zh: '成员交回结果时叫牵头',
    en: 'Call the lead when a member hands back a result',
  },
  'channels.dialog.leadWakeHint': {
    zh: '牵头经手的活，成员做完、回复里没 @ 别人时，牵头决定接着派、问你、总结还是不说话。要开着「允许 AI 成员互相派活」；只开「牵头派活自动放行」时只叫自动派出的活',
    en: 'For work the lead handed out: when a member finishes without @-ing anyone, the lead decides whether to assign more, ask you, sum up or stay quiet. Needs "Let AI members assign work to each other"; with only lead auto-approve on, it is called for auto-sent work only',
  },
  'channels.dialog.leadDispatchOnly': { zh: '牵头只派活不动手', en: 'Lead only assigns, never edits' },
  'channels.dialog.leadDispatchOnlyHint': {
    zh: '牵头只分派和协调，不自己改代码或文件',
    en: 'The lead only assigns and coordinates; it does not change code or files itself',
  },
  'channels.dialog.leadRules': {
    zh: '什么时候叫牵头：不写 @ 的需求；牵头经手的活，成员交回结果、没 @ 别人。不叫：消息里 @ 了人（照 @ 交接）、牵头自己的回复、流程里的步骤、成员问你的事（「需要你决定」）。牵头在这件事上已经有卡没做完时，新的结果并进那张卡。',
    en: 'The lead is called for requests without an @, and when a member hands back work the lead gave out without @-ing anyone. Not called when a message @-mentions someone (that is the handoff), for the lead’s own replies, flow steps, or questions for you ("Needs your decision"). If the lead already has an unfinished card for this work, new results join that card.',
  },
  'channels.agent.sameDir': { zh: '同一目录有活在做时', en: 'When the same folder is busy' },
  'channels.agent.sameDirHint': {
    zh: '同一台电脑、同一个项目目录里别的成员正在做活时。用副本要项目是 Git 仓库',
    en: 'When another member is working in the same project folder on this computer. A copy needs a Git repository',
  },
  'channels.agent.sameDir.queue': { zh: '排队等', en: 'Wait' },
  'channels.agent.sameDir.copy': { zh: '用 Git 副本并行', en: 'Use a Git copy' },
  'channels.agent.sameDir.together': { zh: '照常一起跑', en: 'Run anyway' },
} as const
