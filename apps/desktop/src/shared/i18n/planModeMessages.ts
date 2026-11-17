// 「先出计划」开关，和权限档位分开（docs/ui/plan-mode-split.md）
export const planModeMessages = {
  'planMode.toggle': { zh: '先出计划', en: 'Plan first' },
  'planMode.toggleHint': {
    zh: '只读，先写计划给你看，批准后再动手',
    en: 'Read-only: writes a plan for you to approve before changing anything',
  },
  'planMode.onHint': { zh: '计划中：批准后回到「{p0}」', en: 'Planning: approval returns to "{p0}"' },
  'planMode.menuTitle': { zh: '批准计划后用哪档执行', en: 'Level to use once the plan is approved' },
  'planMode.returnHere': { zh: '计划批准后回到这里', en: 'Approval returns here' },
  'planMode.chip': { zh: '计划中', en: 'Planning' },
  'planMode.chipOff': {
    zh: '关掉先出计划，回到「{p0}」',
    en: 'Stop planning and return to "{p0}"',
  },
  'planMode.start': { zh: '开始执行（{p0}）', en: 'Start ({p0})' },
  'planMode.placeholder': {
    zh: '描述要做的事，先出计划（只读，不改文件）',
    en: 'Describe the task; a plan comes first (read-only, no edits)',
  },
  'planMode.ready.title': { zh: '计划写好了', en: 'The plan is ready' },
  'planMode.ready.hint': { zh: '继续打字可以接着改计划', en: 'Keep typing to refine it' },
  'planMode.ready.run': { zh: '按计划执行（{p0}）', en: 'Run the plan ({p0})' },
  'planMode.ready.message': { zh: '按上面的计划执行。', en: 'Carry out the plan above.' },
} as const
