// 宿主错误及原生窗口文案；CLI 原始输出和用户内容保持原文。
export const systemMessages = {
  'markdown.image.name': { zh: '图片', en: 'Image' },
  'markdown.image.loading': { zh: '正在读取图片…', en: 'Loading image…' },
  'markdown.image.unavailable': { zh: '无法显示图片：{p0}', en: 'Could not display image: {p0}' },
  'composer.attachment.closePreview': { zh: '关闭图片预览', en: 'Close image preview' },
  'composer.attachment.loading': { zh: '正在读取附件…', en: 'Reading attachments…' },
  'composer.attachment.saveError': {
    zh: '图片草稿保存失败，当前图片仍保留，请重试',
    en: 'Could not save the image draft. Your images are preserved; please retry',
  },
  'composer.attachment.restoreError': {
    zh: '图片草稿读取失败，请重新打开或添加图片',
    en: 'Could not restore image drafts. Reopen the conversation or add images again',
  },
  'composer.attachment.invalid': { zh: '图片附件格式不正确', en: 'Invalid image attachment format' },
  'composer.attachment.dimensions': { zh: '图片尺寸不正确', en: 'Invalid image dimensions' },
  'composer.attachment.data': { zh: '图片数据不正确', en: 'Invalid image data' },
  'composer.attachment.mismatch': { zh: '图片类型与内容不符', en: 'Image type does not match its content' },
  'composer.attachment.addImage': { zh: '图片', en: 'Image' },
  'composer.attachment.remove': { zh: '移除图片', en: 'Remove image' },
  'composer.attachment.preview': { zh: '预览图片', en: 'Preview image' },
  'composer.attachment.drop': { zh: '松开以添加图片', en: 'Drop to add images' },
  'composer.attachment.invalidType': {
    zh: '只支持 PNG、JPEG、WebP、GIF 图片（BMP、ICO、AVIF 会自动转成 PNG）',
    en: 'Only PNG, JPEG, WebP and GIF images are supported (BMP, ICO and AVIF are converted to PNG automatically)',
  },
  'composer.attachment.cannotDecode': {
    zh: '{p0} 是 {p1} 图片，这里打不开；用「照片」或「画图」另存为 PNG / JPEG 后再添加，或者截图',
    en: '{p0} is a {p1} image and can’t be opened here. Save it as PNG or JPEG in Photos or Paint, or take a screenshot, then add it',
  },
  'composer.attachment.tooLarge': {
    zh: '图片过大，单张不能超过 10 MiB',
    en: 'Image is too large. Each image must be 10 MiB or smaller',
  },
  'composer.attachment.totalTooLarge': { zh: '图片总大小不能超过 20 MiB', en: 'Images cannot exceed 20 MiB in total' },
  'composer.attachment.tooMany': { zh: '一条消息最多添加 5 张图片', en: 'You can add up to 5 images per message' },
  'composer.attachment.readError': { zh: '图片读取失败，请重试', en: 'Could not read the image. Please try again' },
  'composer.attachment.unsupportedEngine': {
    zh: '当前引擎不支持图片输入',
    en: 'The current engine does not support image input',
  },
  'composer.attachment.count': { zh: '{p0} 张图片', en: '{p0} images' },
  'composer.menu.add': { zh: '添加图片、文件或命令', en: 'Add images, files or commands' },
  'composer.menu.file': { zh: '引用文件', en: 'Reference a file' },
  'composer.menu.command': { zh: '命令', en: 'Command' },
  'composer.menu.commandAtStart': { zh: '命令要写在消息开头', en: 'Commands go at the start of a message' },
  'composer.mention.label': { zh: '项目文件', en: 'Project files' },
  'composer.mention.loading': { zh: '正在查找…', en: 'Searching…' },
  'composer.mention.empty': { zh: '没有匹配的文件', en: 'No matching files' },
  'settings.motion.off': { zh: '关闭', en: 'Off' },
  'system.versionMismatch': {
    zh: '版本不符',
    en: 'Version mismatch',
  },
  'system.missingToken': {
    zh: '令牌缺失',
    en: 'Missing token',
  },
  'system.requestTimedOut': {
    zh: '请求超时',
    en: 'Request timed out',
  },
  'system.unknownError': {
    zh: '未知错误',
    en: 'Unknown error',
  },
  'system.networkError': {
    zh: '网络错误：{p0}',
    en: 'Network error: {p0}',
  },
  'system.serviceTemporarilyUnavailable': {
    zh: '服务暂时不可用',
    en: 'Service temporarily unavailable',
  },
  'system.requestFailedHttp': {
    zh: '请求失败（HTTP {p0}{p1}）',
    en: 'Request failed (HTTP {p0}{p1})',
  },
  'system.invalidTokenDataReturned': {
    zh: '服务返回的令牌数据异常',
    en: 'Invalid token data returned by service',
  },
  'system.invalidPlatformApi': {
    zh: '无效的平台接口',
    en: 'Invalid platform API',
  },
  'system.signInToPixel': {
    zh: '请先登录像素星空账号',
    en: 'Sign in to Pixel Starry Sky first',
  },
  'system.accountSignedOutSign': {
    zh: '账号已退出，请重新登录',
    en: 'Account signed out. Sign in again.',
  },
  'system.invalidAccountDataReturned': {
    zh: '服务返回的账号数据异常',
    en: 'Invalid account data returned by service',
  },
  'system.signInExpiredSign': {
    zh: '登录已过期，请重新登录',
    en: 'Sign-in expired. Sign in again.',
  },
  'system.signInInvalidSign': {
    zh: '登录已失效（已过期或被吊销），请重新登录',
    en: 'Sign-in is no longer valid (expired or revoked). Sign in again.',
  },
  'system.signedInSuccessfully': {
    zh: '登录成功',
    en: 'Signed in successfully',
  },
  'system.authorizationCancelled': {
    zh: '已取消授权',
    en: 'Authorization cancelled',
  },
  'system.signInFailed': {
    zh: '登录失败',
    en: 'Sign-in failed',
  },
  'system.youHaveReturnedTo': {
    zh: '已回到 Pixel Starry Sky，可以关闭此页面。',
    en: 'You have returned to Pixel Starry Sky. You can close this page.',
  },
  'system.noAccountIsSigned': {
    zh: '没有登录任何账号。需要时可以回到 Pixel Starry Sky 重新登录。',
    en: 'No account is signed in. Return to Pixel Starry Sky to sign in when needed.',
  },
  'system.returnToPixelStarry': {
    zh: '{p0}。请回到 Pixel Starry Sky 重试。',
    en: '{p0}. Return to Pixel Starry Sky and try again.',
  },
  'system.unknownReason': {
    zh: '未知原因',
    en: 'Unknown reason',
  },
  'system.signInFailedService': {
    zh: '登录失败：服务暂时不可用',
    en: 'Sign-in failed: service temporarily unavailable',
  },
  'system.signInFailed2': {
    zh: '登录失败：{p0}',
    en: 'Sign-in failed: {p0}',
  },
  'system.signInTimedOut': {
    zh: '登录超时，请重试',
    en: 'Sign-in timed out. Try again.',
  },
  'system.stateValidationFailed': {
    zh: '状态校验不通过',
    en: 'State validation failed',
  },
  'system.authorizationCallbackIsMissing': {
    zh: '回调缺少授权码',
    en: 'Authorization callback is missing its code',
  },
  'system.signInFailedMissing': {
    zh: '登录失败：回调缺少授权码',
    en: 'Sign-in failed: missing authorization code',
  },
  'system.signInFailedCould': {
    zh: '登录失败：无法启动本地回调服务（{p0}）',
    en: 'Sign-in failed: could not start local callback service ({p0})',
  },
  'system.signInFailedCould2': {
    zh: '登录失败：无法启动本地回调服务',
    en: 'Sign-in failed: could not start local callback service',
  },
  'system.signInFailedCould3': {
    zh: '登录失败：无法打开浏览器（{p0}）',
    en: 'Sign-in failed: could not open browser ({p0})',
  },
  'system.pixelStarrySky': {
    zh: '像素星空',
    en: 'Pixel Starry Sky',
  },
  'system.couldNotOpenData': {
    zh: '打不开数据目录：{p0}',
    en: 'Could not open data directory: {p0}',
  },
  'system.unauthorizedCaller': {
    zh: '不允许的调用方',
    en: 'Unauthorized caller',
  },
  'system.unknownLink': {
    zh: '未知的链接',
    en: 'Unknown link',
  },
  'system.invalidFileLineOr': {
    zh: '文件行列不正确',
    en: 'Invalid file line or column',
  },
  'system.invalidEditorSettings': {
    zh: '编辑器设置不正确',
    en: 'Invalid editor settings',
  },
  'system.editorNotFound': {
    zh: '编辑器不存在',
    en: 'Editor not found',
  },
  'system.invalidWindowMode': {
    zh: '窗口方式不正确',
    en: 'Invalid window mode',
  },
  'system.openingMethodNotFound': {
    zh: '打开方式不存在',
    en: 'Opening method not found',
  },
  'system.unknownEditor': {
    zh: '未知编辑器',
    en: 'Unknown editor',
  },
  'system.chooseEditorsExecutable': {
    zh: '请选择编辑器的 exe 程序',
    en: "Choose the editor's executable",
  },
  'system.chooseJetBrainsLauncher': {
    zh: '请选择 JetBrains IDE 的启动程序（bin 里的 idea64.exe、pycharm64.exe 这类）',
    en: 'Choose the JetBrains IDE launcher (idea64.exe, pycharm64.exe and the like in its bin folder)',
  },
  'system.customEditor': {
    zh: '自定义编辑器',
    en: 'Custom editor',
  },
  'system.invalidEditorId': {
    zh: '编辑器 ID 不正确',
    en: 'Invalid editor ID',
  },
  'system.invalidFilePath': {
    zh: '文件路径不正确',
    en: 'Invalid file path',
  },
  'system.chooseDefaultEditorFirst': {
    zh: '先选择默认编辑器',
    en: 'Choose a default editor first',
  },
  'system.defaultEditorIsUnavailable': {
    zh: '默认编辑器不可用，请重新检测或指定路径',
    en: 'Default editor is unavailable. Detect again or specify its path.',
  },
  'system.editorLaunchFailed': {
    zh: '编辑器启动失败：',
    en: 'Editor launch failed:',
  },
  'system.projectNotLoadedYet': {
    zh: '项目尚未加载',
    en: 'Project not loaded yet',
  },
  'system.conversationNoLongerExists': {
    zh: '会话已不存在',
    en: 'Conversation no longer exists',
  },
  'system.projectNoLongerExists': {
    zh: '项目已不存在',
    en: 'Project no longer exists',
  },
  'system.invalidParameter': {
    zh: '参数 {p0} 不对',
    en: 'Invalid parameter: {p0}',
  },
  'system.untrustedPage': {
    zh: '不受信任的页面',
    en: 'Untrusted page',
  },
  'system.unknownEngine': {
    zh: '未知引擎',
    en: 'Unknown engine',
  },
  'system.chooseProjectFolder': {
    zh: '选择项目文件夹',
    en: 'Choose project folder',
  },
  'system.chooseImportFolder': {
    zh: '选择一个包含多个项目的文件夹',
    en: 'Choose a folder that contains projects',
  },
  'system.pickProjectFolders': {
    zh: '选择要加进项目的文件夹',
    en: 'Choose folders to add to the project',
  },
  'system.projectFoldersInvalid': {
    zh: '项目文件夹不对',
    en: 'Invalid project folders',
  },
  'system.projectPathsInvalid': {
    zh: '项目路径不对',
    en: 'Invalid project paths',
  },
  'system.exportUsageRecords': {
    zh: '导出用量记录',
    en: 'Export usage records',
  },
  'system.unsavedFiles': {
    zh: '文件尚未保存',
    en: 'Unsaved files',
  },
  'system.someFilesHaveUnsaved': {
    zh: '有文件包含未保存的修改，仍然退出吗？',
    en: 'Some files have unsaved changes. Quit anyway?',
  },
  'system.returnToSave': {
    zh: '返回保存',
    en: 'Return to save',
  },
  'system.discardChangesAndQuit': {
    zh: '放弃修改并退出',
    en: 'Discard changes and quit',
  },
  'system.captureCouldNotSwitch': {
    zh: '[capture] 切换到 {p0} 主题失败（当前 {p1}）',
    en: '[capture] Could not switch to {p0} theme (current: {p1})',
  },
  'system.none': {
    zh: '无',
    en: 'None',
  },
  'system.captureLightAndDark': {
    zh: '[capture] 浅色和深色截图完全相同，深色主题没有渲染出来',
    en: '[capture] Light and dark screenshots are identical; dark theme did not render',
  },
  'system.file': {
    zh: '文件',
    en: 'File',
  },
  'system.window': {
    zh: '窗口',
    en: 'Window',
  },
  'system.platformServiceTemporarilyUnavailable': {
    zh: '平台服务暂时不可用，请刷新重试',
    en: 'Platform service temporarily unavailable. Refresh and retry.',
  },
  'system.invalidPlatformGroupData': {
    zh: '平台分组数据格式异常',
    en: 'Invalid platform group data',
  },
  'system.platformAccountSignedOut': {
    zh: '平台账号已退出或切换，请登录原账号后重试',
    en: 'Platform account signed out or changed. Sign in to the original account and retry.',
  },
  'system.queuedMessagesRouteIs': {
    zh: '排队消息的线路已不可用，请撤回后重新选择',
    en: "The queued message's route is unavailable. Withdraw it and choose again.",
  },
  'system.queuedMessagesModelIs': {
    zh: '排队消息的模型已不可用，请撤回后重新选择',
    en: "The queued message's model is unavailable. Withdraw it and choose again.",
  },
  'system.invalidGroup': {
    zh: '无效的分组',
    en: 'Invalid group',
  },
  'system.invalidPlatformModelData': {
    zh: '平台模型数据格式异常',
    en: 'Invalid platform model data',
  },
  'system.thisConversationNowUses': {
    zh: '这个会话已改用自有额度',
    en: 'This conversation now uses your own account',
  },
  'system.platformAccountSignedOut2': {
    zh: '平台账号已退出或切换，请重新登录原账号',
    en: 'Platform account signed out or changed. Sign in to the original account again.',
  },
  'system.couldNotStartPlatform': {
    zh: '平台代理启动失败',
    en: 'Could not start platform proxy',
  },
  'system.signInToThis': {
    zh: '请登录此会话使用的平台账号',
    en: "Sign in to this conversation's platform account",
  },
  'system.windowClosed': {
    zh: '窗口已经关闭',
    en: 'Window closed',
  },
  'system.invalidWindowLayout': {
    zh: '窗口布局不正确',
    en: 'Invalid window layout',
  },
  'system.invalidWindowRegion': {
    zh: '窗口区域不正确',
    en: 'Invalid window region',
  },
  'system.notEnoughDisplaySpace': {
    zh: '当前显示器空间不足，无法使用这个区域',
    en: 'Not enough display space for this region',
  },
  'system.missingProjectOrConversation': {
    zh: '缺少项目或会话',
    en: 'Missing project or conversation',
  },
  'system.invalidProjectTarget': {
    zh: '项目目标不正确',
    en: 'Invalid project target',
  },
  'system.usePathRelativeTo': {
    zh: '请使用项目内的相对路径',
    en: 'Use a path relative to the project',
  },
  'system.projectDirectoryNotFound': {
    zh: '项目目录不存在',
    en: 'Project directory not found',
  },
  'system.filePathIsOutside': {
    zh: '文件路径超出项目',
    en: 'File path is outside the project',
  },
  'system.fileOrDirectoryNo': {
    zh: '文件或目录已不存在',
    en: 'File or directory no longer exists',
  },
  'system.thisLinkPointsOutside': {
    zh: '此链接指向项目外，无法在软件内打开',
    en: 'This link points outside the project and cannot open in the app',
  },
  'system.targetIsNotFolder': {
    zh: '目标不是文件夹',
    en: 'Target is not a folder',
  },
  'system.targetIsNotRegular': {
    zh: '目标不是普通文件',
    en: 'Target is not a regular file',
  },
  'system.fileTooLargeOpen': {
    zh: '文件太大，请用外部编辑器打开',
    en: 'File too large. Open it in an external editor.',
  },
  'system.binaryOrNonUtf': {
    zh: '二进制文件或非 UTF-8 编码，请用外部编辑器打开',
    en: 'Binary or non-UTF-8 file. Open it in an external editor.',
  },
  'system.unsupportedEncodingOpenIt': {
    zh: '暂不支持此文件编码，请用外部编辑器打开',
    en: 'Unsupported encoding. Open it in an external editor.',
  },
  'system.filterNameTooLong': {
    zh: '筛选名称过长',
    en: 'Filter name too long',
  },
  'system.invalidSaveParameters': {
    zh: '保存参数不正确',
    en: 'Invalid save parameters',
  },
  'system.contentTooLargeSave': {
    zh: '内容太大，请用外部编辑器保存',
    en: 'Content too large. Save it with an external editor.',
  },
  'system.filePathChangedOpen': {
    zh: '文件路径已经变化，请重新打开',
    en: 'File path changed. Open it again.',
  },
  'system.fileChangedReloadIt': {
    zh: '文件已变化，请重新加载',
    en: 'File changed. Reload it.',
  },
  'system.anotherProgramChangedThis': {
    zh: '文件已被其他程序修改，请重新加载后再保存；当前草稿仍保留',
    en: 'Another program changed this file. Reload before saving. Your draft is preserved.',
  },
  'system.couldNotOpenProject': {
    zh: '打不开项目目录：',
    en: 'Could not open project directory:',
  },
  'system.invalidEditorName': {
    zh: '编辑器名称不正确',
    en: 'Invalid editor name',
  },
  'system.invalidOpeningMethod': {
    zh: '打开方式不正确',
    en: 'Invalid opening method',
  },
  'system.chooseEditorExecutable': {
    zh: '选择编辑器程序',
    en: 'Choose editor executable',
  },
  'system.executable': {
    zh: '程序',
    en: 'Executable',
  },
  'system.claudeCodeNotFound': {
    zh: '没找到 Claude Code。安装：在 PowerShell 运行 irm https://claude.ai/install.ps1 | iex',
    en: 'Claude Code not found. Install it in PowerShell: irm https://claude.ai/install.ps1 | iex',
  },
  'system.claudeCodeNotFound2': {
    zh: '没找到 Claude Code。安装：在终端运行 curl -fsSL https://claude.ai/install.sh | bash',
    en: 'Claude Code not found. Install it in a terminal: curl -fsSL https://claude.ai/install.sh | bash',
  },
  'system.couldNotRunClaude': {
    zh: '无法运行 Claude Code：{p0}',
    en: 'Could not run Claude Code: {p0}',
  },
  'system.versionTooOldRequires': {
    zh: '版本太低（需要 {p0} 以上）：在终端运行 claude update',
    en: 'Version too old (requires {p0} or later). Run claude update in a terminal.',
  },
  'system.notSignedInTo': {
    zh: '还没登录 Claude Code：在终端运行 claude auth login',
    en: 'Not signed in to Claude Code. Run claude auth login in a terminal.',
  },
  'system.thisConversationHasNo': {
    zh: '这个会话还没有保存记录',
    en: 'This conversation has no saved history yet',
  },
  'system.claudeCodeUnavailable': {
    zh: 'Claude Code 不可用',
    en: 'Claude Code unavailable',
  },
  'system.platformProxyUnavailableRestart': {
    zh: '平台代理不可用，请重启应用',
    en: 'Platform proxy unavailable. Restart the app.',
  },
  'system.claudeCodeNotFound3': {
    zh: '没找到 Claude Code',
    en: 'Claude Code not found',
  },
  'system.claudeCodeProcessExited': {
    zh: 'Claude Code 进程已退出',
    en: 'Claude Code process exited',
  },
  'system.requestFailed': {
    zh: '请求失败',
    en: 'Request failed',
  },
  'system.claudeCodeDidNot': {
    zh: 'Claude Code 没有回应 {p0}',
    en: 'Claude Code did not respond to {p0}',
  },
  'system.modelRequestTemporarilyFailed': {
    zh: '模型请求暂时失败',
    en: 'Model request temporarily failed',
  },
  'system.thisSubagentHasNo': {
    zh: '这个子智能体还没有保存会话',
    en: 'This subagent has no saved conversation yet',
  },
  'system.claudeCodeFailedTo': {
    zh: 'Claude Code 启动失败',
    en: 'Claude Code failed to start',
  },
  'system.unavailableForFreeAccounts': {
    zh: '免费账号不能使用',
    en: 'Unavailable for free accounts',
  },
  'system.fastModeIsNot': {
    zh: '账号没有开启 Fast 模式',
    en: 'Fast mode is not enabled for this account',
  },
  'system.extraUsageIsNot': {
    zh: '账号没有开启额外用量',
    en: 'Extra usage is not enabled for this account',
  },
  'system.networkError2': {
    zh: '网络错误',
    en: 'Network error',
  },
  'system.onlySupportedByOfficial': {
    zh: '只支持 Anthropic 官方接口',
    en: 'Only supported by the official Anthropic API',
  },
  'system.disabledByEnvironmentVariable': {
    zh: '被环境变量关闭了',
    en: 'Disabled by environment variable',
  },
  'system.notSupportedByThis': {
    zh: '当前模型不支持',
    en: 'Not supported by this model',
  },
  'system.checkingAccountStatus': {
    zh: '正在确认账号状态',
    en: 'Checking account status',
  },
  'system.unknownReason2': {
    zh: '原因未知',
    en: 'Unknown reason',
  },
  'system.couldNotStartClaude': {
    zh: '无法启动 Claude Code：{p0}',
    en: 'Could not start Claude Code: {p0}',
  },
  'system.contextDetailsAreRefreshing': {
    zh: '上下文明细正在刷新',
    en: 'Context details are refreshing',
  },
  'system.thisClaudeCodeVersion': {
    zh: '当前 Claude Code 未提供上下文诊断',
    en: 'This Claude Code version does not provide context diagnostics',
  },
  'system.contextDiagnosticsTimedOut': {
    zh: '上下文诊断超时，原会话记录保留，可重试',
    en: 'Context diagnostics timed out. Original conversation records are preserved. You can retry.',
  },
  'system.engineDidNotProvide': {
    zh: '引擎未提供结构化的上下文明细',
    en: 'Engine did not provide structured context details',
  },
  'system.conversationClosed': {
    zh: '会话已关闭',
    en: 'Conversation closed',
  },
  'system.workingDirectoryNotFound': {
    zh: '工作目录不存在：{p0}',
    en: 'Working directory not found: {p0}',
  },
  'system.couldNotRestoreClaude': {
    zh: '无法恢复 Claude Code 的会话记录，已开始新的引擎会话（之前的上下文没有带过去）',
    en: 'Could not restore Claude Code history. Started a new engine session without the previous context.',
  },
  'system.couldNotSeedClaude': {
    zh: '没能把之前的对话写进 Claude Code 的会话记录，这一轮改用文字交接',
    en: 'Could not add the previous conversation to Claude Code history; sent it as a text handoff this turn.',
  },
  'system.chatSeeded': {
    zh: '已把之前的聊天带给 {p0}（{p1} 轮）',
    en: 'Brought the previous chat to {p0} ({p1} turns)',
  },
  // 不知道是哪个引擎处理的那段（「其他引擎」写在模板里，不是 {p0}）：必须排在下面带 {p0} 的同步模板前面，
  // 否则英文的「another engine」会被当成 {p0} 配走，翻回中文变成「已把 another engine 期间…」；各档次序同下面的变体
  'system.chatSeedSyncedOtherImages': {
    zh: '已把其他引擎期间的聊天同步给 {p0}（{p1} 轮，含 {p2} 张图片）',
    en: 'Synced the chat from another engine to {p0} ({p1} turns, including {p2} image(s))',
  },
  'system.chatSeedSyncedOtherImagesPartial': {
    zh: '已把其他引擎期间的聊天同步给 {p0}（{p1} 轮，含 {p2} 张图片，{p3} 张图片未带上）',
    en: 'Synced the chat from another engine to {p0} ({p1} turns, including {p2} image(s), {p3} image(s) not carried)',
  },
  'system.chatSeedSyncedOtherImagesOmitted': {
    zh: '已把其他引擎期间的聊天同步给 {p0}（{p1} 轮，{p2} 张图片未带上）',
    en: 'Synced the chat from another engine to {p0} ({p1} turns, {p2} image(s) not carried)',
  },
  'system.chatSeedSyncedOther': {
    zh: '已把其他引擎期间的聊天同步给 {p0}（{p1} 轮）',
    en: 'Synced the chat from another engine to {p0} ({p1} turns)',
  },
  'system.progressSyncedOtherImages': {
    zh: '已把其他引擎期间的进展同步给 {p0}（含 {p1} 张图片）',
    en: 'Synced the progress from another engine to {p0} (including {p1} image(s))',
  },
  'system.progressSyncedOtherImagesPartial': {
    zh: '已把其他引擎期间的进展同步给 {p0}（含 {p1} 张图片，{p2} 张图片未带上）',
    en: 'Synced the progress from another engine to {p0} (including {p1} image(s), {p2} image(s) not carried)',
  },
  'system.progressSyncedOtherImagesOmitted': {
    zh: '已把其他引擎期间的进展同步给 {p0}（{p1} 张图片未带上）',
    en: 'Synced the progress from another engine to {p0} ({p1} image(s) not carried)',
  },
  'system.progressSyncedOther': {
    zh: '已把其他引擎期间的进展同步给 {p0}',
    en: 'Synced the progress from another engine to {p0}',
  },
  'system.chatSeedSynced': {
    zh: '已把 {p0} 期间的聊天同步给 {p1}（{p2} 轮）',
    en: 'Synced the chat from {p0} to {p1} ({p2} turns)',
  },
  // 以下是交接通知带图片说明的变体；「只有未带上」的会误配「带上 + 未带上」，所以后者必须排在前面
  'system.chatSeededImages': {
    zh: '已把之前的聊天带给 {p0}（{p1} 轮，含 {p2} 张图片）',
    en: 'Brought the previous chat to {p0} ({p1} turns, including {p2} image(s))',
  },
  'system.chatSeededImagesPartial': {
    zh: '已把之前的聊天带给 {p0}（{p1} 轮，含 {p2} 张图片，{p3} 张图片未带上）',
    en: 'Brought the previous chat to {p0} ({p1} turns, including {p2} image(s), {p3} image(s) not carried)',
  },
  'system.chatSeededImagesOmitted': {
    zh: '已把之前的聊天带给 {p0}（{p1} 轮，{p2} 张图片未带上）',
    en: 'Brought the previous chat to {p0} ({p1} turns, {p2} image(s) not carried)',
  },
  'system.chatSeedSyncedImages': {
    zh: '已把 {p0} 期间的聊天同步给 {p1}（{p2} 轮，含 {p3} 张图片）',
    en: 'Synced the chat from {p0} to {p1} ({p2} turns, including {p3} image(s))',
  },
  'system.chatSeedSyncedImagesPartial': {
    zh: '已把 {p0} 期间的聊天同步给 {p1}（{p2} 轮，含 {p3} 张图片，{p4} 张图片未带上）',
    en: 'Synced the chat from {p0} to {p1} ({p2} turns, including {p3} image(s), {p4} image(s) not carried)',
  },
  'system.chatSeedSyncedImagesOmitted': {
    zh: '已把 {p0} 期间的聊天同步给 {p1}（{p2} 轮，{p3} 张图片未带上）',
    en: 'Synced the chat from {p0} to {p1} ({p2} turns, {p3} image(s) not carried)',
  },
  // 文字交接（引擎不能注入聊天时）的通知；同步那条没有图片时不带括号，基础模板放最后以免吞掉带括号的
  'system.handoffImages': {
    zh: '已把之前的对话交接给 {p0}（{p1} 条，含 {p2} 张图片）',
    en: 'Handed the previous conversation to {p0} ({p1} messages, including {p2} image(s))',
  },
  'system.handoffImagesPartial': {
    zh: '已把之前的对话交接给 {p0}（{p1} 条，含 {p2} 张图片，{p3} 张图片未带上）',
    en: 'Handed the previous conversation to {p0} ({p1} messages, including {p2} image(s), {p3} image(s) not carried)',
  },
  'system.handoffImagesOmitted': {
    zh: '已把之前的对话交接给 {p0}（{p1} 条，{p2} 张图片未带上）',
    en: 'Handed the previous conversation to {p0} ({p1} messages, {p2} image(s) not carried)',
  },
  'system.handoff': {
    zh: '已把之前的对话交接给 {p0}（{p1} 条）',
    en: 'Handed the previous conversation to {p0} ({p1} messages)',
  },
  'system.progressSyncedImages': {
    zh: '已把 {p0} 期间的进展同步给 {p1}（含 {p2} 张图片）',
    en: 'Synced the progress from {p0} to {p1} (including {p2} image(s))',
  },
  'system.progressSyncedImagesPartial': {
    zh: '已把 {p0} 期间的进展同步给 {p1}（含 {p2} 张图片，{p3} 张图片未带上）',
    en: 'Synced the progress from {p0} to {p1} (including {p2} image(s), {p3} image(s) not carried)',
  },
  'system.progressSyncedImagesOmitted': {
    zh: '已把 {p0} 期间的进展同步给 {p1}（{p2} 张图片未带上）',
    en: 'Synced the progress from {p0} to {p1} ({p2} image(s) not carried)',
  },
  'system.progressSynced': {
    zh: '已把 {p0} 期间的进展同步给 {p1}',
    en: 'Synced the progress from {p0} to {p1}',
  },
  'system.nativeTerminal': {
    zh: '接着终端里的 Claude Code 会话 · {p0} 轮',
    en: 'Continuing the Claude Code session from the terminal · {p0} turns',
  },
  'system.nativeTerminalEarlier': {
    zh: '接着终端里的 Claude Code 会话 · {p0} 轮（更早的 {p1} 轮没有显示）',
    en: 'Continuing the Claude Code session from the terminal · {p0} turns ({p1} earlier turns not shown)',
  },
  'system.nativeOther': {
    zh: '接着 Claude Code 会话（来自其他程序）· {p0} 轮',
    en: 'Continuing a Claude Code session (from another program) · {p0} turns',
  },
  'system.nativeOtherEarlier': {
    zh: '接着 Claude Code 会话（来自其他程序）· {p0} 轮（更早的 {p1} 轮没有显示）',
    en: 'Continuing a Claude Code session (from another program) · {p0} turns ({p1} earlier turns not shown)',
  },
  'system.nativeCopyTerminal': {
    zh: '复制了终端里的 Claude Code 会话 · {p0} 轮（原会话不动，两边可以同时用）',
    en: 'Copied the Claude Code session from the terminal · {p0} turns (the original is untouched; both can be used at the same time)',
  },
  'system.nativeCopyTerminalEarlier': {
    zh: '复制了终端里的 Claude Code 会话 · {p0} 轮（原会话不动，两边可以同时用）（更早的 {p1} 轮没有显示）',
    en: 'Copied the Claude Code session from the terminal · {p0} turns (the original is untouched; both can be used at the same time) ({p1} earlier turns not shown)',
  },
  'system.nativeCopyOther': {
    zh: '复制了其他程序的 Claude Code 会话 · {p0} 轮（原会话不动，两边可以同时用）',
    en: 'Copied a Claude Code session from another program · {p0} turns (the original is untouched; both can be used at the same time)',
  },
  'system.nativeCopyOtherEarlier': {
    zh: '复制了其他程序的 Claude Code 会话 · {p0} 轮（原会话不动，两边可以同时用）（更早的 {p1} 轮没有显示）',
    en: 'Copied a Claude Code session from another program · {p0} turns (the original is untouched; both can be used at the same time) ({p1} earlier turns not shown)',
  },
  'system.nativeRelayRun': {
    zh: '以下 {p0} 轮是在像素星空里用别的引擎聊的，接力时写进了这个会话',
    en: 'The next {p0} turns were chatted with another engine in Pixel Starry Sky and were written into this session during the handoff',
  },
  'system.nativeHandoff': {
    zh: '这一轮带着像素星空的交接材料',
    en: 'This turn carried a handoff from Pixel Starry Sky',
  },
  'system.nativeGap': {
    zh: '中间还有 {p0} 轮没有显示',
    en: '{p0} turns in between are not shown',
  },
  'system.nativeImages': {
    zh: '（{p0} 张图片没有导入）',
    en: '({p0} images were not imported)',
  },
  'system.nativeSummaryOnly': {
    zh: '以上是压缩之前的轮次，模型只看到压缩摘要',
    en: 'The turns above are from before compaction; the model only sees the compaction summary',
  },
  'system.nativeNewer': {
    zh: '这个会话在终端里又聊了 {p0} 轮，显示里还没有',
    en: 'This session continued for {p0} more turns in the terminal; they are not shown here yet',
  },
  'system.nativeSynced': {
    zh: '已补上终端里的 {p0} 轮',
    en: 'Added {p0} turns from the terminal',
  },
  'system.nativeGone': {
    zh: '这个会话的记录已经不在了',
    en: 'The record of this session is gone',
  },
  'system.nativeEarlierGone': {
    zh: '这个会话的记录已经不在了，更早的没法再加载',
    en: 'The record of this session is gone, so earlier turns can’t be loaded',
  },
  'system.nativeEarlierMissing': {
    zh: '找不到要接着往前加载的位置',
    en: 'Couldn’t find where to continue loading earlier turns',
  },
  'system.nativeUnsupported': {
    zh: '这个引擎不支持接着本机会话',
    en: 'This engine can’t continue a local session',
  },
  'system.nativeCancelled': { zh: '已取消导入', en: 'Import cancelled' },
  'system.nativeRecreated': {
    zh: 'Claude Code 的会话记录不在了，已把像素星空里的聊天（{p0} 轮）写进新的引擎会话（工具调用和文件改动没有带过去）',
    en: 'The Claude Code session record is gone. The chat from Pixel Starry Sky ({p0} turns) was written into a new engine session (tool calls and file changes were not carried over)',
  },
  'system.nativeCodexUnavailable': {
    zh: 'Codex 没装好，读不到它的会话',
    en: 'Codex isn’t set up, so its sessions can’t be read',
  },
  'system.nativeCodexUnavailableReason': {
    zh: 'Codex 没装好，读不到它的会话：{p0}',
    en: 'Codex isn’t set up, so its sessions can’t be read: {p0}',
  },
  'system.nativeIdeContext': {
    zh: '这一轮带着编辑器的上下文',
    en: 'This turn carried context from the editor',
  },
  'system.nativeNotFollowing': {
    zh: '这个对话已经不接着原来的会话了，没法再复制一份',
    en: 'This conversation no longer continues the original session, so it can’t be copied again',
  },
  'system.nativeCodexReaderClosed': {
    zh: 'Codex 正在更新或已重新检测，读取被中断了，请重试',
    en: 'Codex is being updated or was re-detected, so reading was interrupted. Please try again',
  },
  'system.nativeNothingToCopy': {
    zh: '这个会话还没有聊完的一轮，没法复制',
    en: 'This session has no finished turn yet, so it can’t be copied',
  },
  'system.nativePixelskyThread': {
    zh: '这个线程以前在像素星空里用过，换引擎时带过去的聊天不会显示，模型照样看得到',
    en: 'This thread was used in Pixel Starry Sky before. Chat carried over when switching engines is not shown here, but the model still sees it',
  },
  'system.nativeRecreatedCodex': {
    zh: 'Codex 的会话记录不在了，已把像素星空里的聊天（{p0} 轮）写进新的引擎会话（工具调用和文件改动没有带过去）',
    en: 'The Codex session record is gone. The chat from Pixel Starry Sky ({p0} turns) was written into a new engine session (tool calls and file changes were not carried over)',
  },
  'system.nativeResumeLost': {
    zh: '没能接上原来的 Claude Code 会话，已改开新的引擎会话，并把像素星空里的聊天（{p0} 轮）带了过去（工具调用和文件改动没有带过去）',
    en: 'Couldn’t continue the original Claude Code session, so a new engine session was started and the chat from Pixel Starry Sky ({p0} turns) was carried over (tool calls and file changes were not)',
  },
  'system.nativeResumeLostCodex': {
    zh: '没能接上原来的 Codex 会话，已改开新的引擎会话，并把像素星空里的聊天（{p0} 轮）带了过去（工具调用和文件改动没有带过去）',
    en: 'Couldn’t continue the original Codex session, so a new engine session was started and the chat from Pixel Starry Sky ({p0} turns) was carried over (tool calls and file changes were not)',
  },
  'system.nativeCodexTerminal': {
    zh: '接着终端里的 Codex 会话 · {p0} 轮',
    en: 'Continuing the Codex session from the terminal · {p0} turns',
  },
  'system.nativeCodexTerminalEarlier': {
    zh: '接着终端里的 Codex 会话 · {p0} 轮（更早的 {p1} 轮没有显示）',
    en: 'Continuing the Codex session from the terminal · {p0} turns ({p1} earlier turns not shown)',
  },
  'system.nativeCodexOther': {
    zh: '接着 Codex 会话（来自其他程序）· {p0} 轮',
    en: 'Continuing a Codex session (from another program) · {p0} turns',
  },
  'system.nativeCodexOtherEarlier': {
    zh: '接着 Codex 会话（来自其他程序）· {p0} 轮（更早的 {p1} 轮没有显示）',
    en: 'Continuing a Codex session (from another program) · {p0} turns ({p1} earlier turns not shown)',
  },
  'system.nativeCodexCopyTerminal': {
    zh: '复制了终端里的 Codex 会话 · {p0} 轮（原会话不动，两边可以同时用）',
    en: 'Copied the Codex session from the terminal · {p0} turns (the original is untouched; both can be used at the same time)',
  },
  'system.nativeCodexCopyTerminalEarlier': {
    zh: '复制了终端里的 Codex 会话 · {p0} 轮（原会话不动，两边可以同时用）（更早的 {p1} 轮没有显示）',
    en: 'Copied the Codex session from the terminal · {p0} turns (the original is untouched; both can be used at the same time) ({p1} earlier turns not shown)',
  },
  'system.nativeCodexCopyOther': {
    zh: '复制了其他程序的 Codex 会话 · {p0} 轮（原会话不动，两边可以同时用）',
    en: 'Copied a Codex session from another program · {p0} turns (the original is untouched; both can be used at the same time)',
  },
  'system.nativeCodexCopyOtherEarlier': {
    zh: '复制了其他程序的 Codex 会话 · {p0} 轮（原会话不动，两边可以同时用）（更早的 {p1} 轮没有显示）',
    en: 'Copied a Codex session from another program · {p0} turns (the original is untouched; both can be used at the same time) ({p1} earlier turns not shown)',
  },
  'system.nativeCodexLegacyTerminal': {
    zh: '复制了终端里的 Codex 会话 · {p0} 轮（旧格式的线程不能原地回退，复制成新线程接着聊，原会话不动）',
    en: 'Copied the Codex session from the terminal · {p0} turns (legacy-format threads can’t be rewound in place, so it was copied into a new thread; the original is untouched)',
  },
  'system.nativeCodexLegacyTerminalEarlier': {
    zh: '复制了终端里的 Codex 会话 · {p0} 轮（旧格式的线程不能原地回退，复制成新线程接着聊，原会话不动）（更早的 {p1} 轮没有显示）',
    en: 'Copied the Codex session from the terminal · {p0} turns (legacy-format threads can’t be rewound in place, so it was copied into a new thread; the original is untouched) ({p1} earlier turns not shown)',
  },
  'system.nativeCodexLegacyOther': {
    zh: '复制了其他程序的 Codex 会话 · {p0} 轮（旧格式的线程不能原地回退，复制成新线程接着聊，原会话不动）',
    en: 'Copied a Codex session from another program · {p0} turns (legacy-format threads can’t be rewound in place, so it was copied into a new thread; the original is untouched)',
  },
  'system.nativeCodexLegacyOtherEarlier': {
    zh: '复制了其他程序的 Codex 会话 · {p0} 轮（旧格式的线程不能原地回退，复制成新线程接着聊，原会话不动）（更早的 {p1} 轮没有显示）',
    en: 'Copied a Codex session from another program · {p0} turns (legacy-format threads can’t be rewound in place, so it was copied into a new thread; the original is untouched) ({p1} earlier turns not shown)',
  },
  'system.fastModeTemporarilyUnavailable': {
    zh: 'Fast 模式暂时不可用',
    en: 'Fast mode temporarily unavailable',
  },
  'system.fastModeCouldNot': {
    zh: 'Fast 模式没能',
    en: 'Fast mode could not',
  },
  'system.enable': {
    zh: '打开',
    en: 'enable',
  },
  'system.disable': {
    zh: '关闭',
    en: 'disable',
  },
  'system.couldNotEnableUltracode': {
    zh: 'Ultracode 没能打开',
    en: 'Could not enable Ultracode',
  },
  'system.modelDoesNotSupport': {
    zh: '当前模型不支持 Ultracode，已关闭',
    en: 'Model does not support Ultracode. It was disabled.',
  },
  'system.contextDiagnosticProcessExited': {
    zh: '上下文诊断进程已退出',
    en: 'Context diagnostic process exited',
  },
  'system.claudeCodeExitedUnexpectedly': {
    zh: 'Claude Code 意外退出（退出码 {p0}）{p1}',
    en: 'Claude Code exited unexpectedly (exit code {p0}){p1}',
  },
  'system.unknown': {
    zh: '未知',
    en: 'Unknown',
  },
  'system.pixelStarrySkyDoes': {
    zh: '像素星空暂不支持 {p0}',
    en: 'Pixel Starry Sky does not yet support {p0}',
  },
  'system.thisRequest': {
    zh: '这个请求',
    en: 'this request',
  },
  'system.userWantsToRefine': {
    zh: '用户希望继续完善计划，先不要开始执行。',
    en: 'The user wants to refine the plan. Do not start execution yet.',
  },
  'system.userDeniedThisOperation': {
    zh: '用户拒绝了这次操作。',
    en: 'The user denied this operation.',
  },
  'system.settingsCouldNotTake': {
    zh: '设置没能立即生效：{p0}',
    en: 'Settings could not take effect immediately: {p0}',
  },
  'system.steeringHasNotBeen': {
    zh: '当前 Claude 进程尚未通过引导验证',
    en: 'Steering has not been validated for the current Claude process',
  },
  'system.engineIsNotRunning': {
    zh: '引擎没有在运行',
    en: 'Engine is not running',
  },
  'system.charactersOmitted': {
    zh: '{p0}\n…（中间省略 {p1} 个字符）…\n{p2}',
    en: '{p0} … ({p1} characters omitted) … {p2}',
  },
  'system.subtask': {
    zh: '子任务',
    en: 'Subtask',
  },
  'system.multiAgentOrchestration': {
    zh: '多智能体编排',
    en: 'Multi-agent orchestration',
  },
  'system.questionForYou': {
    zh: '向你提问',
    en: 'Question for you',
  },
  'system.submitPlan': {
    zh: '提交计划',
    en: 'Submit plan',
  },
  'system.image': {
    zh: '[图片]',
    en: '[Image]',
  },
  'system.runCommand': {
    zh: '运行命令',
    en: 'Run command',
  },
  'system.writeFile': {
    zh: '写入文件',
    en: 'Write file',
  },
  'system.editFile': {
    zh: '修改文件',
    en: 'Edit file',
  },
  'system.claudeHasQuestion': {
    zh: 'Claude 想问你',
    en: 'Claude has a question',
  },
  'system.planIsReadyStart': {
    zh: '计划已就绪，要开始执行吗？',
    en: 'The plan is ready. Start execution?',
  },
  'system.use': {
    zh: '使用 {p0}',
    en: 'Use {p0}',
  },
  'system.signInExpiredRun': {
    zh: '登录已失效：在终端运行 claude auth login 重新登录',
    en: 'Sign-in expired. Run claude auth login in a terminal to sign in again.',
  },
  'system.yourOrganizationDoesNot': {
    zh: '当前账号的组织不允许使用 Claude Code',
    en: 'Your organization does not allow Claude Code',
  },
  'system.accountSuspended': {
    zh: '账号已被暂停',
    en: 'Account suspended',
  },
  'system.accountVerificationRequired': {
    zh: '账号需要验证',
    en: 'Account verification required',
  },
  'system.accountBalanceOrBilling': {
    zh: '账户余额或账单有问题',
    en: 'Account balance or billing issue',
  },
  'system.tooManyRequestsRate': {
    zh: '请求太频繁，已触发限额',
    en: 'Too many requests. Rate limit reached.',
  },
  'system.serviceBusyTryAgain': {
    zh: '服务繁忙，请稍后再试',
    en: 'Service busy. Try again later.',
  },
  'system.invalidRequest': {
    zh: '请求无效',
    en: 'Invalid request',
  },
  'system.selectedModelNotFound': {
    zh: '找不到所选模型',
    en: 'Selected model not found',
  },
  'system.serviceError': {
    zh: '服务出错',
    en: 'Service error',
  },
  'system.serviceErrorTemporary': {
    zh: '服务出错，通常是暂时的，稍后再试',
    en: 'The service hit an error. This is usually temporary; try again shortly.',
  },
  // 报错标题带 HTTP 状态码（引擎 claude/apiError.ts 的 withStatus：状态码插在第一小句后面）
  'system.serviceErrorStatus': {
    zh: '服务出错（HTTP {status}），通常是暂时的，稍后再试',
    en: 'The service hit an error (HTTP {status}). This is usually temporary; try again shortly.',
  },
  'system.serviceBusyStatus': {
    zh: '服务繁忙（HTTP {status}），请稍后再试',
    en: 'Service busy (HTTP {status}). Try again later.',
  },
  'system.tooManyRequestsStatus': {
    zh: '请求太频繁（HTTP {status}），已触发限额',
    en: 'Too many requests (HTTP {status}). Rate limit reached.',
  },
  'system.apiKeyInvalid': {
    zh: 'API Key 无效：检查环境变量里的 ANTHROPIC_API_KEY',
    en: 'Invalid API key: check ANTHROPIC_API_KEY in your environment variables',
  },
  'system.noPermissionForModel': {
    zh: '没有权限：当前账号或 API Key 不能用这个模型或资源',
    en: 'No permission: this account or API key can’t use this model or resource',
  },
  'system.modelServiceUnreachable': {
    zh: '连不上模型服务：检查网络、代理或防火墙',
    en: 'Can’t reach the model service. Check your network, proxy or firewall.',
  },
  'system.contextTooLong': {
    zh: '上下文太长：先压缩（/compact）或开一个新会话',
    en: 'The context is too long. Compact it (/compact) or start a new conversation.',
  },
  'system.replyExceededMaximumLength': {
    zh: '回复超过了最大长度',
    en: 'Reply exceeded maximum length',
  },
  'system.cloudServiceCredentialIssue': {
    zh: '云服务凭据有问题',
    en: 'Cloud service credential issue',
  },
  'system.backgroundCommand': {
    zh: '后台命令',
    en: 'Background command',
  },
  'system.subagent': {
    zh: '子智能体',
    en: 'Subagent',
  },
  'system.monitorTask': {
    zh: '监视任务',
    en: 'Monitor task',
  },
  'system.completed': {
    zh: '已完成',
    en: 'Completed',
  },
  'system.failed': {
    zh: '失败',
    en: 'Failed',
  },
  'system.stopped': {
    zh: '已停止',
    en: 'Stopped',
  },
  'system.backgroundTask': {
    zh: '后台任务',
    en: 'Background task',
  },
  'system.ended': {
    zh: '已结束',
    en: 'Ended',
  },
  'system.contextTooLongEarlier': {
    zh: '上下文太长，已自动压缩较早的对话',
    en: 'Context too long. Earlier messages were compacted automatically.',
  },
  'system.requestError': {
    zh: '请求出错（{p0}）',
    en: 'Request error ({p0})',
  },
  'system.thisTurnFailed': {
    zh: '这一轮失败了',
    en: 'This turn failed',
  },
  'system.thisRequestRetriedTimes': {
    zh: '\n本次请求已重试 {p0} 次{p1}。',
    en: 'This request retried {p0} times{p1}.',
  },
  'system.reachingRetryLimit': {
    zh: '，达到重试上限',
    en: ', reaching the retry limit',
  },
  'system.timedOut': {
    zh: '超时',
    en: 'Timed out',
  },
  'system.invalid': {
    zh: '{p0}不正确',
    en: 'Invalid {p0}',
  },
  'system.name': {
    zh: '名称',
    en: 'name',
  },
  'system.useLettersDigitsDots': {
    zh: '名称使用字母、数字、点、下划线或短横线',
    en: 'Use letters, digits, dots, underscores or hyphens for names',
  },
  'system.projectPath': {
    zh: '项目路径',
    en: 'project path',
  },
  'system.invalidScope': {
    zh: '作用范围不正确',
    en: 'Invalid scope',
  },
  'system.argumentsMustBeString': {
    zh: '参数必须为字符串数组',
    en: 'Arguments must be a string array',
  },
  'system.environmentVariablesOrRequest': {
    zh: '环境变量或请求头必须为对象',
    en: 'Environment variables or request headers must be an object',
  },
  'system.invalidEnvironmentVariablesOr': {
    zh: '环境变量或请求头不正确',
    en: 'Invalid environment variables or request headers',
  },
  'system.command': {
    zh: '命令',
    en: 'command',
  },
  'system.supportsStdioHttpOr': {
    zh: '支持 stdio、HTTP 或 SSE',
    en: 'Supports stdio, HTTP or SSE',
  },
  'system.url': {
    zh: '地址',
    en: 'URL',
  },
  'system.useHttpSUrl': {
    zh: '使用 HTTP(S) 地址，凭据放在请求头中',
    en: 'Use an HTTP(S) URL and put credentials in request headers',
  },
  'system.unsupportedConfigurationType': {
    zh: '不支持的配置类型',
    en: 'Unsupported configuration type',
  },
  'system.skillContent': {
    zh: '技能正文',
    en: 'skill content',
  },
  'system.pathIsOutsideManaged': {
    zh: '路径超出管理目录',
    en: 'Path is outside the managed directory',
  },
  'system.configurationFileTooLarge': {
    zh: '配置文件过大',
    en: 'Configuration file too large',
  },
  'system.skillContentTooLarge': {
    zh: '技能正文过大',
    en: 'Skill content too large',
  },
  'system.directoryNestingTooDeep': {
    zh: '目录层级过深',
    en: 'Directory nesting too deep',
  },
  'system.importDirectoryContainsLinks': {
    zh: '导入目录包含链接，请先使用实际文件：{p0}',
    en: 'Import directory contains links. Use the actual file: {p0}',
  },
  'system.importDirectoryTooLarge': {
    zh: '导入目录过大',
    en: 'Import directory too large',
  },
  'system.pluginComponentsMustBe': {
    zh: '插件组件必须位于包内',
    en: 'Plugin components must be inside the package',
  },
  'system.enabledWithPlugin': {
    zh: '随插件启用',
    en: 'Enabled with plugin',
  },
  'system.pluginExecutable': {
    zh: '插件可执行程序',
    en: 'Plugin executable',
  },
  'system.newConversation': {
    zh: '新会话',
    en: 'New conversation',
  },
  'system.invalidEnvironmentVariableName': {
    zh: '环境变量名不对：{p0}',
    en: 'Invalid environment variable name: {p0}',
  },
  'system.invalidValueForEnvironment': {
    zh: '环境变量 {p0} 的值不对',
    en: 'Invalid value for environment variable {p0}',
  },
  'system.outputStyleNameToo': {
    zh: '输出风格名字太长',
    en: 'Output style name too long',
  },
  'system.invalidValueForAllow': {
    zh: '「允许中途向我提问」的值不对',
    en: 'Invalid value for Allow questions during tasks',
  },
  'system.invalidAutocompactThreshold': {
    zh: '自动压缩触发点不对',
    en: 'Invalid autocompact threshold',
  },
  'system.invalidValueForShow': {
    zh: '「在菜单中显示」的值不对',
    en: 'Invalid value for Show in menu',
  },
  'system.defaultEngineCannotBe': {
    zh: '默认引擎不能隐藏，先换一个默认引擎',
    en: 'The default engine cannot be hidden. Choose another default first.',
  },
  'system.thisEngineIsNot': {
    zh: '这个引擎暂不支持',
    en: 'This engine is not supported yet',
  },
  'system.engineUpdateInProgress': {
    zh: '正在更新，请稍候',
    en: 'Already updating, please wait',
  },
  'system.engineUpdateBusy': {
    zh: '有这个引擎的任务正在运行，等它们结束后再更新',
    en: 'Tasks are running on this engine. Update after they finish',
  },
  'system.codexNotNpmInstall': {
    zh: '这个 Codex 不是用 npm 全局安装的，请用原来安装它的方式更新',
    en: 'This Codex was not installed globally with npm. Update it the way you installed it',
  },
  'system.codexNpmNotFound': {
    zh: '没找到 node / npm，请在终端运行 npm i -g @openai/codex@latest',
    en: 'node / npm not found. Run npm i -g @openai/codex@latest in a terminal',
  },
  'system.codexNotFound': {
    zh: '没找到 Codex',
    en: 'Codex not found',
  },
  'system.settingsSyncCloudDown': {
    zh: '云端服务暂时连不上，稍后自动重试',
    en: 'The cloud service is unreachable right now. Retrying later',
  },
  'system.settingsSyncFailed': {
    zh: '设置同步失败（{p0}）',
    en: 'Settings sync failed ({p0})',
  },
  'system.settingsSyncBadArgs': {
    zh: '同步参数不对',
    en: 'Invalid sync request',
  },
  'system.settingsSyncTooMany': {
    zh: '一次同步的设置太多',
    en: 'Too many settings in one sync',
  },
  'system.settingsSyncBadKey': {
    zh: '设置名不对：{p0}',
    en: 'Invalid setting name: {p0}',
  },
  'system.settingsSyncBadValue': {
    zh: '设置 {p0} 的值不能同步',
    en: 'Setting {p0} cannot be synced',
  },
  'system.settingsSyncTooBig': {
    zh: '设置 {p0} 太大',
    en: 'Setting {p0} is too large',
  },
  'system.settingsSyncNotEngine': {
    zh: '不是引擎设置',
    en: 'Not an engine setting',
  },
  'system.thisEngineCannotUpdate': {
    zh: '这个引擎不支持在软件里更新',
    en: 'This engine cannot update within the app',
  },
  'system.directoryNotFound': {
    zh: '目录不存在：{p0}',
    en: 'Directory not found: {p0}',
  },
  'system.projectNotFound': {
    zh: '项目不存在',
    en: 'Project not found',
  },
  'system.conversationNotFound': {
    zh: '会话不存在',
    en: 'Conversation not found',
  },
  'system.taskExecutionFailed': {
    zh: '任务执行失败',
    en: 'Task execution failed',
  },
  'system.engineExitedBeforeConfirming': {
    zh: '引擎退出前未确认是否采纳，请核对后重试',
    en: 'Engine exited before confirming adoption. Check before retrying.',
  },
  'system.applicationIsQuitting': {
    zh: '应用正在退出',
    en: 'Application is quitting',
  },
  'system.waitForCurrentTask': {
    zh: '等待当前任务和排队消息结束后刷新明细',
    en: 'Wait for the current task and queued messages to finish before refreshing details',
  },
  'system.runConversationFirstOr': {
    zh: '先运行会话，或升级到支持上下文诊断的 Claude Code',
    en: 'Run a conversation first, or update to a Claude Code version with context diagnostics',
  },
  'system.waitForCurrentTask2': {
    zh: '等待当前任务和排队消息结束后压缩',
    en: 'Wait for the current task and queued messages to finish before compacting',
  },
  'system.engineDoesNotSupport': {
    zh: '当前引擎不支持原生压缩，或会话尚未开始',
    en: 'Engine does not support native compaction, or the conversation has not started',
  },
  'system.messageProcessingStartedOr': {
    zh: '这条消息已开始处理或已经撤回',
    en: 'Message processing started or the message was withdrawn',
  },
  'system.messageDeliveryStartedIt': {
    zh: '这条消息已开始交付，无法撤回',
    en: 'Message delivery started; it cannot be withdrawn',
  },
  'system.onlyQueuedMessagesCan': {
    zh: '只有排队中的消息可以调序',
    en: 'Only queued messages can be reordered',
  },
  'system.stoppingCurrentTaskContinue': {
    zh: '正在停止当前任务，请稍后继续',
    en: 'Stopping the current task. Continue later.',
  },
  'system.retryOrWithdrawFailed': {
    zh: '请先重试或撤回失败及待核对的消息',
    en: 'Retry or withdraw failed and unverified messages first',
  },
  'system.stoppingCurrentTaskRetry': {
    zh: '正在停止当前任务，请稍后重试',
    en: 'Stopping the current task. Retry later.',
  },
  'system.messageDeliveryAlreadyStarted': {
    zh: '这条消息已经开始交付',
    en: 'Message delivery already started',
  },
  'system.messageProcessingAlreadyStarted': {
    zh: '这条消息已经开始处理',
    en: 'Message processing already started',
  },
  'system.currentTaskHasNot': {
    zh: '当前任务还没有停止，请稍后重试',
    en: 'Current task has not stopped yet. Retry later.',
  },
  'system.currentTurnEndedOr': {
    zh: '当前一轮已结束或正在等待审批',
    en: 'Current turn ended or approval is pending',
  },
  'system.liveSteeringHasNot': {
    zh: '当前引擎尚未通过运行中引导验证，可等待或插队',
    en: 'Live steering has not been validated for this engine. Wait or run next.',
  },
  'system.settingsDifferFromCurrent': {
    zh: '设置与当前任务不同，可等待或插队',
    en: 'Settings differ from the current task. Wait or run next.',
  },
  'system.steeringDeliveryNeedsVerification': {
    zh: '引导交付结果待核对：{p0}',
    en: 'Steering delivery needs verification: {p0}',
  },
  'system.unavailable': {
    zh: '{p0} 不可用',
    en: '{p0} unavailable',
  },
  'system.contextDiagnosticsAreRefreshing': {
    zh: '上下文诊断正在刷新，完成后再修改会话设置',
    en: 'Context diagnostics are refreshing. Wait before changing session settings.',
  },
  'system.switchCreditSourceAfter': {
    zh: '这一轮结束后再切换额度来源',
    en: 'Switch credit source after this turn finishes',
  },
  'system.cannotSwitchEnginesFor': {
    zh: '已经开始对话或有排队任务的会话不能换引擎，请新建会话',
    en: 'Cannot switch engines for conversations that have started or have queued tasks. Create a new conversation.',
  },
  'system.thisEngineDoesNot': {
    zh: '这个引擎没有智能体追踪',
    en: 'This engine does not provide agent activity',
  },
  'system.invalidDefaultModel': {
    zh: '默认模型不对',
    en: 'Invalid default model',
  },
  'system.invalidDefaultReasoningEffort': {
    zh: '默认推理强度不对',
    en: 'Invalid default reasoning effort',
  },
  'system.invalidDefaultPermissions': {
    zh: '默认权限不对',
    en: 'Invalid default permissions',
  },
  'system.invalidValueForDefault': {
    zh: '默认设置 {p0} 的值不对',
    en: 'Invalid value for default setting {p0}',
  },
  'system.messageCannotBeEmpty': {
    zh: '消息不能为空',
    en: 'Message cannot be empty',
  },
  'system.messageTooLongSplit': {
    zh: '消息过长，请拆分后发送',
    en: 'Message too long. Split it before sending.',
  },
  'system.invalidMessageId': {
    zh: '消息 ID 无效',
    en: 'Invalid message ID',
  },
  'system.invalidModelOrEffort': {
    zh: '排队消息的模型或强度无效',
    en: 'Invalid model or effort for queued message',
  },
  'system.invalidCreditSourceFor': {
    zh: '排队消息的额度来源无效',
    en: 'Invalid credit source for queued message',
  },
  'system.comingSoon': {
    zh: '即将支持',
    en: 'Coming soon',
  },
  'system.retryCountMustBe': {
    zh: '重试次数必须是 0～15 的整数',
    en: 'Retry count must be an integer from 0 to 15',
  },
  'system.invalidSearchParameters': {
    zh: '搜索参数无效',
    en: 'Invalid search parameters',
  },
  'system.removedProject': {
    zh: '已移除的项目',
    en: 'Removed project',
  },
  'system.recentConversations': {
    zh: '最近会话',
    en: 'Recent conversations',
  },
  'system.projects': {
    zh: '项目',
    en: 'Projects',
  },
  'system.invalidConversationId': {
    zh: '会话 id 不合法：{p0}',
    en: 'Invalid conversation ID: {p0}',
  },
  'system.deliveryBeganBeforePrevious': {
    zh: '上次退出前已开始交付，请核对后再重试',
    en: 'Delivery began before the previous exit. Check before retrying.',
  },
  'nav.workbench': {
    zh: '工作台',
    en: 'Workbench',
  },
  'nav.machines': {
    zh: '云主机',
    en: 'Cloud machines',
  },
  'nav.channels': {
    zh: '协作频道',
    en: 'Channels',
  },
  'nav.skills': {
    zh: '技能与插件',
    en: 'Skills & plugins',
  },
  'panel.copies': {
    zh: '副本',
    en: 'Copies',
  },
  'panel.sandbox': {
    zh: '环境',
    en: 'Environment',
  },
  'panel.browser': {
    zh: '浏览器',
    en: 'Browser',
  },
  'panel.tasks': {
    zh: '任务清单',
    en: 'Tasks',
  },
  'composer.placeholder': {
    zh: '描述你要做的事，@ 添加文件，/ 输入命令',
    en: 'Describe your task, @ add files, / enter commands',
  },
  'composer.machine': {
    zh: '这台电脑',
    en: 'This computer',
  },
  'system.rewindRunning': {
    zh: '请先停止当前任务再回退',
    en: 'Stop the current task before rewinding',
  },
  'system.rewindReconnecting': {
    zh: '正在自动重连，请先停止再回退',
    en: 'Auto-reconnecting. Stop it before rewinding',
  },
  'system.reconnectOriginalGone': {
    zh: '原消息已不在对话里，请重试或撤回',
    en: 'The original message is no longer in the conversation. Retry or withdraw it',
  },
  'system.rewindUnsupported': {
    zh: '当前引擎暂不支持回退',
    en: 'The current engine does not support rewinding yet',
  },
  'system.rewindOwnOnly': {
    zh: '只能回退到自己发送的消息',
    en: 'You can only rewind to messages you sent',
  },
  'system.rewindAnchorMissing': {
    zh: '无法在 {p0} 记录中回退到这条消息，已开始新的引擎会话（之前的上下文没有带过去）',
    en: 'Could not rewind to this message in {p0} history. Started a new engine session without the previous context.',
  },
  'system.programNotFound': {
    zh: '找不到程序：{p0}',
    en: 'Program not found: {p0}',
  },
  'system.noBackgroundTasks': {
    zh: '这个引擎没有后台任务',
    en: 'This engine has no background tasks',
  },
  'system.engineInstallUnsupported': {
    zh: '这个引擎不支持在软件里安装',
    en: "This engine can't be installed from the app",
  },
  'system.engineAlreadyInstalled': { zh: '已经装好了，请刷新', en: 'Already installed. Refresh to see it' },
  'system.engineCannotInstallHere': {
    zh: '这台电脑上没法一键安装，请按提示在终端安装',
    en: "One-click install isn't available on this computer. Install it from a terminal as shown",
  },
  'system.engineInstallInProgress': { zh: '正在安装，请稍候', en: 'Already installing, please wait' },
  'system.claudeInstallerMissing': {
    zh: '没找到 PowerShell / curl，请按提示在终端安装 Claude Code',
    en: 'PowerShell / curl not found. Install Claude Code from a terminal as shown',
  },
  'system.engineJobNoSuccess': { zh: '没有成功，请看输出', en: "It didn't succeed. See the output" },
  'system.onlyFailedCanBeDismissed': {
    zh: '只有失败或待核对的消息可以关掉',
    en: 'Only failed or unconfirmed messages can be dismissed',
  },
  'system.notSentRetryOrWithdraw': {
    zh: '这条消息还没发出去，请重试或撤回',
    en: "This message hasn't been sent yet. Retry or withdraw it",
  },
  'system.connectionLost': { zh: '连接中断', en: 'Connection lost' },
  'system.storeRefreshFirst': { zh: '请先刷新套餐信息', en: 'Refresh the plan info first' },
  'system.storeNoPanelUrl': { zh: '没有可用的面板地址', en: 'No usable panel address' },
  'system.storeLoadFailedHttp': { zh: '暂时读不到订阅套餐和充值信息（HTTP {p0}）', en: 'Could not read plans and top-up info (HTTP {p0})' },
  'system.storeInvalidData': { zh: '服务返回的套餐数据异常', en: 'Invalid plan data returned by service' },
  'system.storeInvalidPage': { zh: '无效的面板页', en: 'Invalid panel page' },
  'system.storePanelCredentials': { zh: '面板地址带有用户名或密码，已拒绝打开', en: 'The panel address contains a username or password, so it was not opened' },
  'system.storePanelNotHttps': { zh: '面板地址不是 https，已拒绝打开', en: 'The panel address is not https, so it was not opened' },
  'system.storePanelUntrusted': { zh: '面板地址不在可信域名内，已拒绝打开', en: 'The panel address is not on a trusted domain, so it was not opened' },
  'system.checkoutInvalidRequest': { zh: '请求参数不正确', en: 'Invalid request' },
  'system.checkoutBusy': { zh: '已有一笔订单正在创建，请稍候', en: 'Another order is being created. Please wait' },
  'system.checkoutInvalidData': { zh: '服务返回的付款数据异常', en: 'Invalid payment data returned by service' },
  'system.checkoutFailedHttp': { zh: '付款服务暂时不可用（HTTP {p0}）', en: 'The payment service is unavailable (HTTP {p0})' },
  'system.checkoutOrderNotFound': { zh: '找不到这笔订单，请重新下单', en: 'Order not found. Please place a new order' },
  'system.checkoutPanelUrlUntrusted': { zh: '确认地址不在可信域名内，已拒绝打开', en: 'The confirmation URL is not trusted and was not opened' },
  'system.checkoutNoPayPage': { zh: '这笔订单没有可以打开的支付页', en: 'This order has no payment page to open' },
  'system.checkoutNetwork': { zh: '连不上付款服务，请检查网络后重试', en: 'Cannot reach the payment service. Check your network and try again' },
  'system.checkoutTimeout': { zh: '付款服务响应超时，请稍后重试', en: 'The payment service timed out. Try again later' },
  'system.checkoutCreateTimeout': { zh: '下单超时：请稍后在「继续付款」里查看，不会重复下单', en: 'Placing the order timed out. Check "Continue payment" later; no duplicate order will be created' },
  'system.checkoutAccountChanged': { zh: '登录状态已变化，请重试', en: 'The sign-in state changed. Please try again' },
  'system.checkoutNoOwnerWindow': { zh: '找不到发起请求的窗口', en: 'The window that made the request was not found' },
  // 付款窗口标题：带上当前页面的主机名，让用户看得出页面来自哪里；支付方式认不出时（英文界面只认 alipay / wxpay）用通用写法
  'system.checkoutPayWindowTitle': { zh: '{p0}付款页面 · {p1}', en: '{p0} payment page · {p1}' },
  'system.checkoutPayWindowTitleGeneric': { zh: '付款页面 · {p0}', en: 'Payment page · {p0}' },
  // 账号额度（docs/ui/account-quota.md §5.4）：引擎包抛的是中文原文，界面用 translateMessage 反查
  'system.quotaTimeout': { zh: '读取额度超时', en: 'Timed out reading usage limits' },
  'system.quotaNetwork': { zh: '连不上 {p0}', en: 'Couldn’t reach {p0}' },
  'system.quotaEngineUnavailable': { zh: '{p0} 现在不可用', en: '{p0} is unavailable right now' },
  'system.quotaFailed': { zh: '读取额度失败：{p0}', en: 'Failed to read usage limits: {p0}' },
  'system.quotaNoData': { zh: '没有拿到额度数据', en: 'No usage data was returned' },
} as const
