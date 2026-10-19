// 扩展商店「我的发布」页签的界面文案（docs/ui/extension-store-client.md §2.6）。
// 云端错误文案在 extensionCenterMessages 的 errors.extstore.*，这里不重复。
export const extstorePublishMessages = {
  'extstore.publish.signIn.title': { zh: '登录后才能发布扩展', en: 'Sign in to publish extensions' },
  'extstore.publish.signIn.hint': {
    zh: '用像素星空账号登录，再注册一个发布者名，就可以上传扩展了。',
    en: 'Sign in with your Pixel Sky account, register a publisher name, and you can upload extensions.',
  },
  'extstore.publish.signIn.button': { zh: '登录', en: 'Sign in' },
  'extstore.publish.loading': { zh: '正在读取我的发布…', en: 'Loading your publications…' },
  'extstore.publish.loadFailed': { zh: '读取失败：{error}', en: 'Failed to load: {error}' },
  'extstore.publish.retry': { zh: '重试', en: 'Retry' },

  'extstore.publish.register.title': { zh: '注册发布者', en: 'Register as a publisher' },
  'extstore.publish.register.hint': {
    zh: '发布者名（id 前缀，注册后不能改）：扩展 id 要以「发布者名.」开头。',
    en: 'Publisher name (id prefix, cannot be changed): extension ids must start with "name.".',
  },
  'extstore.publish.register.placeholder': { zh: '例如 lin', en: 'e.g. lin' },
  'extstore.publish.register.submit': { zh: '注册', en: 'Register' },

  'extstore.publish.header.publisher': { zh: '发布者', en: 'Publisher' },
  'extstore.publish.header.upload': { zh: '上传新扩展 / 新版本', en: 'Upload extension / new version' },
  'extstore.publish.empty': {
    zh: '还没有发布过扩展。点右上角「上传新扩展 / 新版本」。',
    en: 'Nothing published yet. Use "Upload extension / new version" at the top right.',
  },
  'extstore.publish.ext.downloads': { zh: '↓ {count}', en: '↓ {count}' },
  'extstore.publish.ext.latest': { zh: '已上架 {version}', en: 'Live {version}' },
  'extstore.publish.ext.notLive': { zh: '还没有上架的版本', en: 'No live version yet' },
  'extstore.publish.ext.delistedByAdmin': { zh: '平台下架：{reason}', en: 'Delisted by the platform: {reason}' },
  'extstore.publish.ext.delistedByAuthor': { zh: '已下架', en: 'Delisted' },
  'extstore.publish.ext.blocked': { zh: '已被平台停用：{reason}', en: 'Disabled by the platform: {reason}' },
  'extstore.publish.ext.delist': { zh: '下架', en: 'Delist' },
  'extstore.publish.ext.relist': { zh: '重新上架', en: 'Relist' },

  'extstore.publish.version.pending': { zh: '待审核', en: 'In review' },
  'extstore.publish.version.approved': { zh: '已上架', en: 'Live' },
  'extstore.publish.version.rejected': { zh: '未通过', en: 'Rejected' },
  'extstore.publish.version.withdrawn': { zh: '已撤回', en: 'Withdrawn' },
  'extstore.publish.version.blocked': { zh: '已停用', en: 'Disabled' },
  'extstore.publish.version.hints': { zh: '{count} 条提示', en: '{count} notices' },
  'extstore.publish.version.withdraw': { zh: '撤回', en: 'Withdraw' },

  'extstore.publish.report.noLocal': {
    zh: '逐条结果只在上传的那台电脑上有',
    en: 'Per-item results are only on the computer that uploaded this version',
  },
  'extstore.publish.report.reject': { zh: '要改的', en: 'Must fix' },
  'extstore.publish.report.hint': { zh: '建议', en: 'Suggested' },
  'extstore.publish.report.note': { zh: '提示', en: 'Notes' },
  'extstore.publish.report.clean': { zh: '没有发现问题', en: 'No problems found' },
  'extstore.publish.report.incomplete': {
    zh: '本机没检查完，没有逐条结果',
    en: 'The local check did not finish, so there are no per-item results',
  },

  'extstore.publish.delist.title': { zh: '下架 {name}？', en: 'Delist {name}?' },
  'extstore.publish.delist.body': {
    zh: '下架后不在商店里显示、不能新装；已经装了的人照常能用。',
    en: 'After delisting it is hidden from the store and cannot be newly installed; people who already installed it can keep using it.',
  },
  'extstore.publish.delist.confirm': { zh: '下架', en: 'Delist' },
  'extstore.publish.delist.cancel': { zh: '取消', en: 'Cancel' },

  'extstore.publish.upload.titleIdle': { zh: '上传扩展', en: 'Upload an extension' },
  'extstore.publish.upload.title': { zh: '上传 {id} {version}', en: 'Upload {id} {version}' },
  'extstore.publish.upload.drop': {
    zh: '把 zip 拖到这里，或点击选择 zip / 文件夹…',
    en: 'Drop a zip here, or click to choose a zip / folder…',
  },
  'extstore.publish.upload.dropHint': {
    zh: '拖入只支持 zip，最大 10 MB；文件夹请用选择框。',
    en: 'Drag-and-drop takes zip files only, 10 MB at most; use the chooser for folders.',
  },
  'extstore.publish.upload.picking': { zh: '正在检查…', en: 'Checking…' },
  'extstore.publish.upload.check.permissionsNone': {
    zh: '不运行代码，不需要权限',
    en: 'Runs no code, needs no permissions',
  },
  'extstore.publish.upload.check.permissions': { zh: '需要的权限：{list}', en: 'Permissions needed: {list}' },
  'extstore.publish.upload.check.prefixOk': { zh: 'id 前缀 {name} 属于你', en: 'The id prefix {name} is yours' },
  'extstore.publish.upload.check.prefixBad': {
    zh: 'id 前缀不是你的发布者名 {name}',
    en: 'The id prefix is not your publisher name {name}',
  },
  'extstore.publish.upload.check.versionOk': {
    zh: '版本 {version} 比已上架的都大',
    en: 'Version {version} is newer than all live versions',
  },
  'extstore.publish.upload.check.versionBad': {
    zh: '版本 {version} 不比已上架的版本大',
    en: 'Version {version} is not newer than the live versions',
  },
  'extstore.publish.upload.contents': { zh: '包含什么', en: 'Contents' },
  'extstore.publish.upload.new': { zh: '（新增）', en: ' (new)' },
  'extstore.publish.upload.contentsEmpty': { zh: '没有贡献内容', en: 'No contributions' },
  'extstore.publish.upload.versionRule': {
    zh: '被撤回或没通过的版本号可以再用；上架过的版本号永远不能再用。',
    en: 'A withdrawn or rejected version number can be used again; a version number that went live can never be reused.',
  },
  'extstore.publish.upload.incomplete': {
    zh: '本机没检查完，可能会被云端拒收，并占用一次上传额度（每天 20 次）',
    en: "The local check didn't finish; the cloud may reject it and it still uses one of your uploads (20 per day)",
  },
  'extstore.publish.upload.checking': { zh: '云端检查中（最多 1 分钟）', en: 'Checking in the cloud (up to 1 minute)' },
  'extstore.publish.upload.cloudFailed': { zh: '云端检查没通过', en: 'The cloud check failed' },
  'extstore.publish.upload.submit': { zh: '提交审核', en: 'Submit for review' },
  'extstore.publish.upload.cancel': { zh: '取消', en: 'Cancel' },

  'extstore.publish.kind.grammars': { zh: '语法高亮', en: 'Grammars' },
  'extstore.publish.kind.themes': { zh: '主题', en: 'Themes' },
  'extstore.publish.kind.snippets': { zh: '代码片段', en: 'Snippets' },
  'extstore.publish.kind.iconThemes': { zh: '文件图标', en: 'File icons' },
  'extstore.publish.kind.taskTemplates': { zh: '任务模板', en: 'Task templates' },
  'extstore.publish.kind.skills': { zh: '技能', en: 'Skills' },
  'extstore.publish.kind.prompts': { zh: '提示词', en: 'Prompts' },
} as const satisfies Record<string, { zh: string; en: string }>
