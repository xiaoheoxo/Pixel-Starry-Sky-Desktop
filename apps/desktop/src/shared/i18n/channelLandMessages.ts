// 本机多 AI 协作剩下几项（docs/ui/channels-local-rest.md）
export const channelLandMessages = {
  // 主进程抛出的报错原文（中文）→ 英文；translateMessage 按原文查
  'channels.land.memberInFlow': {
    zh: '这个成员还在没结束的流程里，流程结束后再删',
    en: 'This member is still in an unfinished workflow; delete it after the workflow ends',
  },
  'channels.land.cardMerged': {
    zh: '这张卡已经合并回去了，不能再追加',
    en: 'This task was already merged back; it can’t take more requests',
  },
  'channels.land.cantMerge': { zh: '这张卡现在不能合并', en: 'This task can’t be merged right now' },
  'channels.land.prExists': { zh: '已经开过 PR 了', en: 'A PR was already opened' },
  'channels.land.merging': { zh: '正在合并，稍等', en: 'Merging, please wait' },
  'channels.land.cardChanged': {
    zh: '这张卡在合并期间变了，请重新操作',
    en: 'The task changed during the merge; please try again',
  },
  'channels.land.noSession': {
    zh: '这张卡没有会话，开不了 PR',
    en: 'This task has no session, so no PR can be opened',
  },
  'channels.land.unavailable': { zh: '现在不能合并', en: 'Merging isn’t available right now' },
  'channels.land.notRepo': { zh: '项目目录不是 Git 仓库', en: 'The project folder isn’t a Git repository' },
  'channels.land.detached': {
    zh: '主目录是分离 HEAD，先切到一个分支再合并',
    en: 'The main folder is on a detached HEAD; switch to a branch before merging',
  },
  'channels.land.wrongBranch': {
    zh: '主目录现在在「{branch}」，切回「{base}」再合并',
    en: 'The main folder is on “{branch}”; switch back to “{base}” to merge',
  },
  'channels.land.untrackedClash': {
    zh: '主目录里没跟踪的文件和要合并的同名：{files}',
    en: 'Untracked files in the main folder clash with the merge: {files}',
  },
  'channels.land.mainDirty': {
    zh: '主目录有没提交的改动，先提交或收起再合并',
    en: 'The main folder has uncommitted changes; commit or stash them first',
  },
  'channels.land.mainOperation': {
    zh: '主目录有进行中的合并或变基，先处理完',
    en: 'A merge or rebase is in progress in the main folder; finish it first',
  },
  'channels.land.mainBusy': {
    zh: '主目录里还有会话在运行，等它停下再合并',
    en: 'A session is still running in the main folder; wait for it to stop',
  },
  'channels.land.hookFailed': {
    zh: '提交钩子没通过，已撤回：{detail}',
    en: 'A commit hook failed and the merge was rolled back: {detail}',
  },
  'channels.land.gitTooOld': {
    zh: '合并需要 Git 2.38 或更新的版本，请先升级 Git',
    en: 'Merging needs Git 2.38 or newer; please update Git',
  },
  'channels.land.pushFailed': { zh: '推送分支失败：{detail}', en: 'Couldn’t push the branch: {detail}' },
  'channels.land.notGithub': {
    zh: 'origin 不是 GitHub 仓库，开不了 PR；分支已推送，请到代码托管网站上手动建',
    en: 'origin isn’t a GitHub repository, so no PR was opened; the branch is pushed, open one on your Git host',
  },
} as const
