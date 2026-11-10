// 本机多 AI 协作剩下几项（docs/ui/channels-local-rest.md）
export const channelLandUiMessages = {
  'channels.land.copyPerTask': { zh: '每项活一个 Git 副本', en: 'One Git copy per task' },
  'channels.land.copyPerTaskHint': {
    zh: '每张任务卡在自己的副本和分支里做，做完可以查看改动、合并回去或开 PR',
    en: 'Each task works in its own copy and branch; afterwards you can review, merge back or open a PR',
  },
  'channels.land.branch': { zh: '分支 {branch} ← 从 {base} 分出', en: 'Branch {branch} ← from {base}' },
  'channels.land.merged': { zh: '已合并回 {base}（提交 {commit}）', en: 'Merged into {base} (commit {commit})' },
  'channels.land.conflict': { zh: '合并有冲突的文件：{files}', en: 'Merge conflicts in: {files}' },
  'channels.land.pr': { zh: '已开 PR：{url}', en: 'PR opened: {url}' },
  'channels.land.changes': { zh: '查看改动', en: 'View changes' },
  'channels.land.noChanges': { zh: '这个副本还没有改动', en: 'No changes in this copy yet' },
  'channels.land.changesDemo': { zh: '演示模式里看不了改动', en: 'Changes aren’t available in demo mode' },
  'channels.land.merge': { zh: '合并回 {base}', en: 'Merge into {base}' },
  'channels.land.openPr': { zh: '开 PR', en: 'Open PR' },
  'channels.land.resolve': { zh: '让成员处理冲突', en: 'Ask member to resolve' },
} as const
