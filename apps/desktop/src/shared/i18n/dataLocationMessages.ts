// 设置 › 存储 › 数据位置（docs/ui/data-location.md）
export const dataLocationMessages = {
  'dataLocation.title': { zh: '数据位置', en: 'Data location' },
  'dataLocation.description': {
    zh: '对话历史、检查点、频道、项目登记放在这里。设置和登录信息始终留在系统用户目录。',
    en: 'Conversation history, checkpoints, channels and the project list live here. Settings and sign-in data always stay in your user profile.',
  },
  'dataLocation.inAppData': {
    zh: '现在在 C 盘的 AppData 里，对话多了会占不少空间，可以换到别的盘。',
    en: 'This is in AppData on the system drive; it can grow large. You can move it to another drive.',
  },
  'dataLocation.open': { zh: '打开', en: 'Open' },
  'dataLocation.chooseTitle': { zh: '选择数据位置', en: 'Choose data location' },
  'dataLocation.change': { zh: '更改…', en: 'Change…' },
  'dataLocation.confirmTitle': { zh: '把数据搬到新位置？', en: 'Move data to the new location?' },
  'dataLocation.confirmBody': {
    zh: '要搬约 {size} 到 {path}。像素星空会退出（正在运行的对话和频道会停下），重启时先复制、核对，再打开。旧位置的数据会留着，之后可以在这里删除。',
    en: 'About {size} will be moved to {path}. Pixel Starry Sky will quit (running conversations and channels stop), then copy and verify the data on restart. The old copy is kept; you can delete it here afterwards.',
  },
  'dataLocation.confirm': { zh: '搬过去并重启', en: 'Move and restart' },
  'dataLocation.cancel': { zh: '取消', en: 'Cancel' },
  'dataLocation.cancelMove': { zh: '取消搬家', en: 'Cancel move' },
  'dataLocation.dismissError': { zh: '知道了', en: 'Dismiss' },
  'dataLocation.useTitle': { zh: '接回这里的数据？', en: 'Use the data in this folder?' },
  'dataLocation.useBody': {
    zh: '{path} 里已经有像素星空的数据（比如以前用过的数据位置）。像素星空会重启并直接用那里的数据，不复制；现在位置的数据不受影响。',
    en: '{path} already has Pixel Starry Sky data (for example a previous data location). Pixel Starry Sky will restart and use it directly without copying; the current data is not affected.',
  },
  'dataLocation.useConfirm': { zh: '接回并重启', en: 'Use and restart' },
  'dataLocation.problem.notAbsolute': { zh: '路径不对', en: 'Invalid path' },
  'dataLocation.problem.same': { zh: '已经是现在的数据位置', en: 'This is already the data location' },
  'dataLocation.problem.insideCurrent': {
    zh: '不能选现在数据位置里面的文件夹',
    en: 'Choose a folder outside the current data location',
  },
  'dataLocation.problem.containsCurrent': {
    zh: '不能选包含现在数据位置的文件夹',
    en: 'Choose a folder that does not contain the current data location',
  },
  'dataLocation.problem.insideInstall': {
    zh: '不能放在安装目录里：卸载和更新会清掉它',
    en: 'Not inside the install folder: uninstalling or updating would remove it',
  },
  'dataLocation.problem.notWritable': { zh: '这个文件夹写不进去', en: 'This folder is not writable' },
  'dataLocation.problem.hasData': {
    zh: '这个文件夹里已经有像素星空的数据，请选一个空文件夹',
    en: 'This folder already has Pixel Starry Sky data; choose an empty folder',
  },
  'dataLocation.problem.noSpace': { zh: '那个盘剩余空间不够', en: 'Not enough free space on that drive' },
  'dataLocation.previous': {
    zh: '旧位置的数据还在：{path}',
    en: 'The old data is still at {path}',
  },
  'dataLocation.removeOld': { zh: '删除旧数据', en: 'Delete old data' },
  'dataLocation.keepOld': { zh: '保留', en: 'Keep' },
  'dataLocation.removeOldTitle': { zh: '删除旧位置的数据？', en: 'Delete the old data?' },
  'dataLocation.removeOldBody': {
    zh: '会把 {path} 里的对话、频道等数据移到回收站。新位置的数据不受影响。',
    en: 'Conversations, channels and other data in {path} will be moved to the Recycle Bin. The new location is not affected.',
  },
  'dataLocation.moveFailed': {
    zh: '上次搬数据没成功，还在原位置：{error}',
    en: 'The last move failed; data stays in the old location: {error}',
  },
  'dataLocation.pending': { zh: '重启后会搬到 {path}', en: 'Will move to {path} after restart' },
  'dataLocation.missingTitle': { zh: '找不到数据位置', en: 'Data location not found' },
  'dataLocation.missingMessage': {
    zh: '找不到 {path}。如果它在移动硬盘或网络盘上，请先接上再重试；也可以回到默认位置（原来的数据还在那个盘上，之后可以在设置 › 存储里选那个文件夹接回来）。',
    en: '{path} is not available. If it is on a removable or network drive, connect it and retry, or use the default location (your data stays on that drive; you can reconnect it later in Settings › Storage).',
  },
  'dataLocation.retry': { zh: '重试', en: 'Retry' },
  'dataLocation.useDefault': { zh: '回到默认位置', en: 'Use default location' },
  'dataLocation.quit': { zh: '退出', en: 'Quit' },
} as const satisfies Record<string, { zh: string; en: string }>
