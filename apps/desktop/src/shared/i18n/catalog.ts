// 固定界面词典。key 保持稳定，新增语言补齐同一组条目。
export const catalog = {
  "account.format.justNow": {
    "zh": "刚刚",
    "en": "Just now"
  },
  "account.format.minutesAgo": {
    "zh": "{p0} 分钟前",
    "en": "{p0} minutes ago"
  },
  "account.format.hours": {
    "zh": "小时",
    "en": "hours"
  },
  "account.format.days": {
    "zh": "天",
    "en": "days"
  },
  "account.format.balanceBilling": {
    "zh": "按余额计费",
    "en": "Balance billing"
  },
  "account.format.subscriptionBilling": {
    "zh": "订阅计费",
    "en": "Subscription billing"
  },
  "account.platform.insufficientBalanceAddCredits": {
    "zh": "余额不足：按余额计费的线路要先充值，才能读取模型和调用",
    "en": "Insufficient balance. Add credits to load and use models on balance-billed routes."
  },
  "account.platform.couldNotLoadModels": {
    "zh": "模型读取失败：{p0}",
    "en": "Could not load models: {p0}"
  },
  "account.platform.noModelsAvailableOn": {
    "zh": "这条线路暂时没有可用模型",
    "en": "No models available on this route yet"
  },
  "account.platform.noRoutesAvailableAsk": {
    "zh": "暂无可用线路：请管理员在后台公开分组并分配使用权限",
    "en": "No routes available. Ask an administrator to publish groups and grant access."
  },
  "account.platform.insufficientBalanceAllAvailable": {
    "zh": "余额不足：可用的线路都按余额计费，余额为 0 时读不到模型，也不能调用。充值后点「重试」，或改用自有",
    "en": "Insufficient balance. All available routes bill your balance. Add credits and retry, or use your own account."
  },
  "account.platform.noModelsAvailableOn2": {
    "zh": "线路里暂时没有可用模型",
    "en": "No models available on these routes yet"
  },
  "account.platform.subscriptionCredits": {
    "zh": "订阅额度",
    "en": "Subscription credits"
  },
  "account.platform.balanceBilling": {
    "zh": "余额计费",
    "en": "Balance billing"
  },
  "account.platform.failedToLoad": {
    "zh": "读取失败",
    "en": "Failed to load"
  },
  "account.platform.noModelsAvailableIn": {
    "zh": "分组里暂时没有可用模型",
    "en": "No models available in this group yet"
  },
  "account.useAccount.couldNotLoadAccount": {
    "zh": "无法读取账号状态",
    "en": "Could not load account status"
  },
  "account.useAccount.signInFailedPlease": {
    "zh": "登录失败，请重试",
    "en": "Sign-in failed. Please retry."
  },
  "account.useAccount.couldNotCancelSign": {
    "zh": "取消登录失败",
    "en": "Could not cancel sign-in"
  },
  "account.useAccount.couldNotSignOut": {
    "zh": "退出登录失败",
    "en": "Could not sign out"
  },
  "account.useAccount.refreshFailedTryAgain": {
    "zh": "刷新失败，请稍后再试",
    "en": "Refresh failed. Try again later."
  },
  "App.resizeSidebar": {
    "zh": "调整侧边栏宽度",
    "en": "Resize sidebar"
  },
  "appearance.wallpaper.supportedImagesPngJpg": {
    "zh": "只支持图片（png / jpg / webp / gif / avif）或视频（mp4 / webm）",
    "en": "Supported images: png / jpg / webp / gif / avif. Supported videos: mp4 / webm."
  },
  "appearance.wallpaper.fileTooLargeMaximum": {
    "zh": "文件太大，最大 200 MB",
    "en": "File too large. Maximum size is 200 MB."
  },
  "appearance.wallpaper.couldNotSaveWallpaper": {
    "zh": "保存壁纸失败，请再试一次",
    "en": "Could not save wallpaper. Please retry."
  },
  "account.AccountMenu.loadingAccount": {
    "zh": "正在读取账号…",
    "en": "Loading account…"
  },
  "account.AccountMenu.signInToPixel": {
    "zh": "登录像素星空账号",
    "en": "Sign in to Pixel Starry Sky"
  },
  "account.AccountMenu.signInToAccess": {
    "zh": "登录后可以使用账号下的模型，并在这里查看余额和额度。用自己的 Claude Code / Codex 不需要登录。",
    "en": "Sign in to access your models and view your balance and credits here. You don't need to sign in to use your own Claude Code or Codex."
  },
  "account.AccountMenu.signIn": {
    "zh": "登录",
    "en": "Sign in"
  },
  "account.AccountMenu.waitingForAuthorization": {
    "zh": "等待授权",
    "en": "Waiting for authorization"
  },
  "account.AccountMenu.authorizationPageIsOpen": {
    "zh": "已在浏览器中打开授权页，完成后会自动回来。",
    "en": "The authorization page is open in your browser. Sign-in will complete automatically."
  },
  "account.AccountMenu.cancel": {
    "zh": "取消",
    "en": "Cancel"
  },
  "account.AccountMenu.accountSettings": {
    "zh": "账号设置…",
    "en": "Account settings…"
  },
  "account.AccountMenu.today": {
    "zh": "今日",
    "en": "Today"
  },
  "account.AccountMenu.thisWeek": {
    "zh": "本周",
    "en": "This week"
  },
  "account.AccountMenu.thisMonth": {
    "zh": "本月",
    "en": "This month"
  },
  "account.AccountMenu.balance": {
    "zh": "余额",
    "en": "Balance"
  },
  "account.AccountMenu.balanceIsTemporarilyUnavailable": {
    "zh": "余额暂时获取不到",
    "en": "Balance is temporarily unavailable"
  },
  "account.AccountMenu.updating": {
    "zh": "正在更新…",
    "en": "Updating…"
  },
  "account.AccountMenu.updated": {
    "zh": "更新于 {p0}",
    "en": "Updated {p0}"
  },
  "account.AccountMenu.expires": {
    "zh": "到期",
    "en": "Expires"
  },
  "account.AccountMenu.limit": {
    "zh": "限额",
    "en": "Limit"
  },
  "account.AccountMenu.resetsByTimeWindow": {
    "zh": "按时间窗口重置",
    "en": "Resets by time window"
  },
  "account.AccountMenu.every": {
    "zh": "每 {p0}",
    "en": "Every {p0}"
  },
  "account.AccountMenu.refreshCredits": {
    "zh": "刷新额度",
    "en": "Refresh credits"
  },
  "account.AccountMenu.refresh": {
    "zh": "刷新",
    "en": "Refresh"
  },
  "account.AccountMenu.signOut": {
    "zh": "退出",
    "en": "Sign out"
  },
  "account.LogoutConfirm.confirmSignOut": {
    "zh": "确认退出登录",
    "en": "Confirm sign out"
  },
  "account.LogoutConfirm.signOut": {
    "zh": "确定退出登录？",
    "en": "Sign out?"
  },
  "account.LogoutConfirm.youWillNeedTo": {
    "zh": "退出后需要重新在浏览器中授权才能使用账号下的模型。",
    "en": "You will need to authorize again in your browser to use your account's models."
  },
  "account.LogoutConfirm.signOut2": {
    "zh": "退出登录",
    "en": "Sign out"
  },
  "account.QuotaBar.unlimited": {
    "zh": "不限",
    "en": "Unlimited"
  },
  "account.QuotaBar.usage": {
    "zh": "{p0}用量",
    "en": "{p0} usage"
  },
  "code.CodeBlock.code": {
    "zh": "代码",
    "en": "Code"
  },
  "code.CodeBlock.copyCode": {
    "zh": "复制代码",
    "en": "Copy code"
  },
  "code.CodeBlock.copied": {
    "zh": "已复制",
    "en": "Copied"
  },
  "code.CodeBlock.copyFailed": {
    "zh": "复制失败",
    "en": "Copy failed"
  },
  "code.CodeBlock.copy": {
    "zh": "复制",
    "en": "Copy"
  },
  "code.highlight.plainText": {
    "zh": "纯文本",
    "en": "Plain text"
  },
  "nav.TopNav.usage": {
    "zh": "用量",
    "en": "Usage"
  },
  "nav.WindowControls.twoColumns": {
    "zh": "左右两列",
    "en": "Two columns"
  },
  "nav.WindowControls.threeColumns": {
    "zh": "三列",
    "en": "Three columns"
  },
  "nav.WindowControls.largeLeftTwoRight": {
    "zh": "左大右上下",
    "en": "Large left, two right"
  },
  "nav.WindowControls.twoLeftLargeRight": {
    "zh": "左上下右大",
    "en": "Two left, large right"
  },
  "nav.WindowControls.fourQuadrants": {
    "zh": "四宫格",
    "en": "Four quadrants"
  },
  "nav.WindowControls.wideCenter": {
    "zh": "中间宽列",
    "en": "Wide center"
  },
  "nav.WindowControls.restore": {
    "zh": "还原",
    "en": "Restore"
  },
  "nav.WindowControls.maximize": {
    "zh": "最大化",
    "en": "Maximize"
  },
  "nav.WindowControls.windowControls": {
    "zh": "窗口操作",
    "en": "Window controls"
  },
  "nav.WindowControls.minimize": {
    "zh": "最小化",
    "en": "Minimize"
  },
  "nav.WindowControls.closeWindow": {
    "zh": "关闭窗口",
    "en": "Close window"
  },
  "nav.WindowControls.windows11WindowLayouts": {
    "zh": "Windows 11 窗口布局",
    "en": "Windows 11 window layouts"
  },
  "nav.WindowControls.zone": {
    "zh": "区域",
    "en": "Zone"
  },
  "nav.WindowControls.notEnoughDisplaySpace": {
    "zh": "当前显示器空间不足",
    "en": "Not enough display space"
  },
  "nav.WindowControls.restorePreviousWindowSize": {
    "zh": "恢复原窗口大小和位置",
    "en": "Restore previous window size and position"
  },
  "panel.PanelTabs.closeTab": {
    "zh": "关闭标签",
    "en": "Close tab"
  },
  "panel.RightPanel.comingSoon": {
    "zh": "即将推出",
    "en": "Coming soon"
  },
  "session.CacheMissAlerts.couldNotStop": {
    "zh": "停止失败：{p0}",
    "en": "Could not stop: {p0}"
  },
  "session.CacheMissAlerts.cacheNotice": {
    "zh": "缓存提醒",
    "en": "Cache notice"
  },
  "session.CacheMissAlerts.cacheMiss": {
    "zh": "缓存未命中",
    "en": "Cache miss"
  },
  "session.CacheMissAlerts.lowCacheHitRate": {
    "zh": "缓存命中偏低",
    "en": "Low cache hit rate"
  },
  "session.CacheMissAlerts.currentInputTokensCache": {
    "zh": "本次输入 {p0} Token，缓存读取 {p1} Token；前次输入 {p2} Token",
    "en": "Current input: {p0} tokens, cache read: {p1} tokens; previous input: {p2} tokens"
  },
  "session.CacheMissAlerts.currentInput": {
    "zh": "本次输入",
    "en": "Current input"
  },
  "session.CacheMissAlerts.cacheRead": {
    "zh": "，缓存读取",
    "en": ", cache read"
  },
  "session.CacheMissAlerts.previousInput": {
    "zh": "；前次输入",
    "en": "; previous input"
  },
  "session.CacheMissAlerts.youCanAlsoStop": {
    "zh": "，也可在输入框手动停止。",
    "en": ". You can also stop from the composer."
  },
  "session.CacheMissAlerts.stoppingThisTurn": {
    "zh": "正在停止这一轮…",
    "en": "Stopping this turn…"
  },
  "session.CacheMissAlerts.stopManuallyFromComposer": {
    "zh": "请在输入框手动停止",
    "en": "Stop manually from the composer"
  },
  "session.CacheMissAlerts.taskIsRunningCloses": {
    "zh": "任务仍在运行 · {p0} 秒后关闭",
    "en": "Task is running · closes in {p0}s"
  },
  "session.CacheMissAlerts.keepRunning": {
    "zh": "继续运行",
    "en": "Keep running"
  },
  "session.CacheMissAlerts.stopping": {
    "zh": "正在停止…",
    "en": "Stopping…"
  },
  "session.CacheMissAlerts.stopThisTurn": {
    "zh": "停止本轮",
    "en": "Stop this turn"
  },
  "session.ChangedFilesCard.editedFile": {
    "zh": "编辑了 {n} 个文件",
    "en": "Edited {n} file"
  },
  "session.ChangedFilesCard.editedFiles": {
    "zh": "编辑了 {n} 个文件",
    "en": "Edited {n} files"
  },
  "session.ChangedFilesCard.undo": {
    "zh": "撤销",
    "en": "Undo"
  },
  "session.ChangedFilesCard.review": {
    "zh": "审查",
    "en": "Review"
  },
  "session.ChangedFilesCard.openFileInPixel": {
    "zh": "在像素星空中打开文件",
    "en": "Open file in Pixel Starry Sky"
  },
  "session.ChangedFilesCard.openInEditor": {
    "zh": "在编辑器中打开",
    "en": "Open in editor"
  },
  "session.ChangedFilesCard.showChanges": {
    "zh": "展开改动",
    "en": "Show changes"
  },
  "session.ChangedFilesCard.hideChanges": {
    "zh": "收起改动",
    "en": "Hide changes"
  },
  "session.process.title": {
    "zh": "执行",
    "en": "Worked"
  },
  "session.process.running": {
    "zh": "正在执行",
    "en": "Working"
  },
  "session.process.steps": {
    "zh": "{n} 步",
    "en": "{n} steps"
  },
  "session.process.joiner": {
    "zh": "，",
    "en": ", "
  },
  "session.process.commands": {
    "zh": "运行 {n} 条命令",
    "en": "ran {n} commands"
  },
  "session.process.commandsOne": {
    "zh": "运行 {n} 条命令",
    "en": "ran {n} command"
  },
  "session.process.edits": {
    "zh": "修改 {n} 个文件",
    "en": "edited {n} files"
  },
  "session.process.editsOne": {
    "zh": "修改 {n} 个文件",
    "en": "edited {n} file"
  },
  "session.process.reads": {
    "zh": "读取 {n} 次",
    "en": "{n} reads"
  },
  "session.process.readsOne": {
    "zh": "读取 {n} 次",
    "en": "{n} read"
  },
  "session.process.searches": {
    "zh": "搜索 {n} 次",
    "en": "{n} searches"
  },
  "session.process.searchesOne": {
    "zh": "搜索 {n} 次",
    "en": "{n} search"
  },
  "session.process.web": {
    "zh": "网页 {n} 次",
    "en": "{n} web requests"
  },
  "session.process.webOne": {
    "zh": "网页 {n} 次",
    "en": "{n} web request"
  },
  "session.process.mcp": {
    "zh": "MCP {n} 次",
    "en": "{n} MCP calls"
  },
  "session.process.mcpOne": {
    "zh": "MCP {n} 次",
    "en": "{n} MCP call"
  },
  "session.process.agents": {
    "zh": "子智能体 {n} 个",
    "en": "{n} subagents"
  },
  "session.process.agentsOne": {
    "zh": "子智能体 {n} 个",
    "en": "{n} subagent"
  },
  "session.process.other": {
    "zh": "其它工具 {n} 次",
    "en": "{n} other tools"
  },
  "session.process.otherOne": {
    "zh": "其它工具 {n} 次",
    "en": "{n} other tool"
  },
  "session.process.failed": {
    "zh": "{n} 个失败",
    "en": "{n} failed"
  },
  "session.process.expand": {
    "zh": "展开执行过程",
    "en": "Show steps"
  },
  "settings.shortcuts.hint": {
    "zh": "点组合键可以修改：按下新的组合键就保存，Esc 取消。要带 Ctrl 或 Alt（macOS 上是 ⌘ 或 ⌥），也可以用 F1–F12。",
    "en": "Click a shortcut to change it: press the new combination to save, Esc to cancel. Include Ctrl or Alt (⌘ or ⌥ on macOS), or use F1–F12."
  },
  "settings.shortcuts.recording": {
    "zh": "按下新的快捷键…",
    "en": "Press new shortcut…"
  },
  "settings.shortcuts.edit": {
    "zh": "修改「{name}」的快捷键",
    "en": "Change shortcut for “{name}”"
  },
  "settings.shortcuts.reset": {
    "zh": "恢复默认",
    "en": "Reset to default"
  },
  "settings.shortcuts.resetAll": {
    "zh": "全部恢复默认",
    "en": "Reset all"
  },
  "settings.shortcuts.fixed": {
    "zh": "固定的快捷键",
    "en": "Fixed shortcuts"
  },
  "settings.shortcuts.fixedHint": {
    "zh": "一组键和终端里的复制粘贴不能修改。",
    "en": "Key groups and terminal copy / paste can’t be changed."
  },
  "settings.shortcuts.needsModifier": {
    "zh": "要带 Ctrl 或 Alt（macOS 上是 ⌘ 或 ⌥），或者用 F1–F12，否则会挡住打字",
    "en": "Include Ctrl or Alt (⌘ or ⌥ on macOS), or use F1–F12, so it doesn’t block typing"
  },
  "settings.shortcuts.reserved": {
    "zh": "这是复制、粘贴等编辑用的组合，换一个",
    "en": "That’s an editing shortcut (copy, paste…). Choose another"
  },
  "settings.shortcuts.conflict": {
    "zh": "和「{name}」冲突，换一个",
    "en": "Conflicts with “{name}”. Choose another"
  },
  "session.process.collapse": {
    "zh": "收起执行过程",
    "en": "Hide steps"
  },
  "session.Composer.send": {
    "zh": "发送",
    "en": "Send"
  },
  "session.Composer.resizeComposerHeight": {
    "zh": "调整输入框高度",
    "en": "Resize composer height"
  },
  "session.Composer.addMoreInstructionsEnter": {
    "zh": "继续补充要求，Enter 加入队列…",
    "en": "Add more instructions. Enter to queue…"
  },
  "session.Composer.tabToInsert": {
    "zh": "按 Tab 填入",
    "en": "Tab to insert"
  },
  "session.Composer.stop": {
    "zh": "停止",
    "en": "Stop"
  },
  "session.Composer.stopThisTaskAnd": {
    "zh": "停止当前任务并暂停队列",
    "en": "Stop this task and pause the queue"
  },
  "session.Composer.stopThisTaskAndEsc": {
    "zh": "停止当前任务并暂停队列（Esc）",
    "en": "Stop this task and pause the queue (Esc)"
  },
  "session.Composer.queueMessage": {
    "zh": "加入队列",
    "en": "Queue message"
  },
  "session.Composer.queueMessageEnter": {
    "zh": "加入队列（Enter）",
    "en": "Queue message (Enter)"
  },
  "session.Composer.sendEnter": {
    "zh": "发送（Enter）",
    "en": "Send (Enter)"
  },
  "session.Composer.add": {
    "zh": "添加",
    "en": "Add"
  },
  "session.Composer.permissionMode": {
    "zh": "权限模式",
    "en": "Permission mode"
  },
  "session.Composer.reasoningEffort": {
    "zh": "推理强度",
    "en": "Reasoning effort"
  },
  "session.Composer.voiceInput": {
    "zh": "语音输入",
    "en": "Voice input"
  },
  "session.ComposerArea.resizeLeftComposerEdge": {
    "zh": "调整输入框左侧宽度",
    "en": "Resize left composer edge"
  },
  "session.ComposerArea.resizeRightComposerEdge": {
    "zh": "调整输入框右侧宽度",
    "en": "Resize right composer edge"
  },
  "session.ComposerMenus.reasoningEffort": {
    "zh": "推理强度 {p0}",
    "en": "Reasoning effort {p0}"
  },
  "session.ComposerMenus.modesOn": {
    "zh": "已开启：{p0}",
    "en": "On: {p0}"
  },
  "session.ComposerMenus.resetToDefault": {
    "zh": "恢复默认（{p0}）",
    "en": "Reset to default ({p0})"
  },
  "session.ComposerMenus.notSupportedByThis": {
    "zh": "当前模型不支持",
    "en": "Not supported by this model"
  },
  "session.ComposerMenus.orchestrateMultipleSubagentsFor": {
    "zh": "每个任务都编排多个子智能体，消耗显著增加",
    "en": "Orchestrate multiple subagents for each task. Usage increases significantly."
  },
  "session.ComposerMenus.fastMode": {
    "zh": "Fast 模式",
    "en": "Fast mode"
  },
  "session.ComposerMenus.temporarilyUnavailable": {
    "zh": "暂时不可用：{p0}",
    "en": "Temporarily unavailable: {p0}"
  },
  "session.ComposerMenus.unknownReason": {
    "zh": "原因未知",
    "en": "Unknown reason"
  },
  "session.ComposerMenus.fasterOutputAtHigher": {
    "zh": "更快的输出速度，按更高价格计费",
    "en": "Faster output at a higher price"
  },
  "session.ComposerMenus.showThinkingSummaries": {
    "zh": "显示思考摘要",
    "en": "Show thinking summaries"
  },
  "session.ComposerMenus.showSummaryOfModel": {
    "zh": "在回复前展示模型思考过程的摘要",
    "en": "Show a summary of model reasoning before the reply"
  },
  "session.ComposerMenus.permissions": {
    "zh": "权限：{p0}",
    "en": "Permissions: {p0}"
  },
  "session.ComposerMenus.notSupportedByThis2": {
    "zh": "当前引擎暂不支持",
    "en": "Not supported by this engine yet"
  },
  "session.ComposerMenus.modelHasNoEffortLevels": {
    "zh": "当前模型不支持调节推理强度",
    "en": "This model does not support reasoning effort"
  },
  "session.ComposerStatusBar.chooseProjectFolder": {
    "zh": "选择项目文件夹",
    "en": "Choose project folder"
  },
  "session.ComposerStatusBar.chooseProject": {
    "zh": "选择项目",
    "en": "Choose project"
  },
  "session.ComposerStatusBar.chooseProjectToStart": {
    "zh": "在哪个项目里开始",
    "en": "Choose a project to start in"
  },
  "session.contextData.systemPrompt": {
    "zh": "系统提示",
    "en": "System prompt"
  },
  "session.contextData.systemTools": {
    "zh": "系统工具",
    "en": "System tools"
  },
  "session.contextData.systemToolsDeferred": {
    "zh": "系统工具（延迟加载，不占用）",
    "en": "System tools (deferred, not loaded)"
  },
  "session.contextData.mcpToolsDeferred": {
    "zh": "MCP 工具（延迟加载，不占用）",
    "en": "MCP tools (deferred, not loaded)"
  },
  "session.contextData.mcpTools": {
    "zh": "MCP 工具",
    "en": "MCP tools"
  },
  "session.contextData.memoryFiles": {
    "zh": "记忆文件",
    "en": "Memory files"
  },
  "session.contextData.customAgents": {
    "zh": "自定义智能体",
    "en": "Custom agents"
  },
  "session.contextData.agents": {
    "zh": "智能体",
    "en": "Agents"
  },
  "session.contextData.conversationMessages": {
    "zh": "对话消息",
    "en": "Conversation messages"
  },
  "session.contextData.autocompactReserve": {
    "zh": "自动压缩预留",
    "en": "Autocompact reserve"
  },
  "session.contextData.availableSpace": {
    "zh": "可用空间",
    "en": "Available space"
  },
  "session.contextData.uncachedInput": {
    "zh": "普通输入",
    "en": "Uncached input"
  },
  "session.contextData.cacheRead": {
    "zh": "缓存读取",
    "en": "Cache read"
  },
  "session.contextData.cacheWrite": {
    "zh": "缓存写入",
    "en": "Cache write"
  },
  "session.contextData.remainingCapacity": {
    "zh": "剩余容量",
    "en": "Remaining capacity"
  },
  "session.ContextWindowButton.engineActionsAreUnavailable": {
    "zh": "演示模式不执行引擎操作",
    "en": "Engine actions are unavailable in demo mode"
  },
  "session.ContextWindowButton.startConversationFirst": {
    "zh": "先开始一个会话",
    "en": "Start a conversation first"
  },
  "session.ContextWindowButton.waitForCurrentTask": {
    "zh": "等待当前任务与排队消息结束",
    "en": "Wait for the current task and queued messages to finish"
  },
  "session.ContextWindowButton.thisEngineDoesNot": {
    "zh": "当前引擎尚未提供此能力",
    "en": "This engine does not provide this capability yet"
  },
  "session.ContextWindowButton.contextWindow": {
    "zh": "上下文窗口",
    "en": "Context window"
  },
  "session.ContextWindowButton.compactingContext": {
    "zh": "正在压缩上下文",
    "en": "Compacting context"
  },
  "session.ContextWindowButton.context": {
    "zh": "上下文 {p0} / {p1}（{p2}%）",
    "en": "Context {p0} / {p1} ({p2}%)"
  },
  "session.ContextWindowButton.viewContextWindow": {
    "zh": "查看上下文窗口",
    "en": "View context window"
  },
  "session.ContextWindowButton.compacting": {
    "zh": "压缩中",
    "en": "Compacting"
  },
  "session.ContextWindowButton.context2": {
    "zh": "上下文",
    "en": "Context"
  },
  "session.ContextWindowButton.contextWindowDetails": {
    "zh": "上下文窗口详情",
    "en": "Context window details"
  },
  "session.ContextWindowButton.waitingForUpdate": {
    "zh": "等待更新",
    "en": "Waiting for update"
  },
  "session.ContextWindowButton.closeContextDetails": {
    "zh": "关闭上下文窗口详情",
    "en": "Close context details"
  },
  "session.ContextWindowButton.contextUsage": {
    "zh": "上下文占用",
    "en": "Context usage"
  },
  "session.ContextWindowButton.compactingConversation": {
    "zh": "正在压缩对话…",
    "en": "Compacting conversation…"
  },
  "session.ContextWindowButton.dataIsStaleWaiting": {
    "zh": "数据已过期，等待下一次请求或刷新诊断",
    "en": "Data is stale. Waiting for the next request or refreshed diagnostics."
  },
  "session.ContextWindowButton.highContextUsage": {
    "zh": "上下文占用较高",
    "en": "High context usage"
  },
  "session.ContextWindowButton.waitingForFirstRequest": {
    "zh": "等待首次请求",
    "en": "Waiting for the first request"
  },
  "session.ContextWindowButton.windowCapacityUnavailable": {
    "zh": "窗口大小未提供",
    "en": "Window capacity unavailable"
  },
  "session.ContextWindowButton.tokensRemaining": {
    "zh": "剩余 {p0} Token",
    "en": "{p0} tokens remaining"
  },
  "session.ContextWindowButton.compactingCallsModelAnd": {
    "zh": "压缩会调用模型，可能产生费用",
    "en": "Compacting calls the model and may incur charges"
  },
  "session.ContextWindowButton.compactConversation": {
    "zh": "压缩对话",
    "en": "Compact conversation"
  },
  "session.ContextWindowButton.engineReserve": {
    "zh": "引擎预留",
    "en": "Engine reserve"
  },
  "session.ContextWindowButton.tokensUsableUpTo": {
    "zh": "Token；可用至",
    "en": "tokens; usable up to"
  },
  "session.ContextWindowButton.compactingCallsModelAnd2": {
    "zh": "压缩会调用模型，可能产生费用。对话和草稿会保留。",
    "en": "Compacting calls the model and may incur charges. Your conversation and draft are preserved."
  },
  "session.ContextWindowButton.startCompaction": {
    "zh": "开始压缩",
    "en": "Start compaction"
  },
  "session.ContextWindowButton.viewDetailedUsage": {
    "zh": "查看详细占用",
    "en": "View detailed usage"
  },
  "session.ContextWindowButton.engineDiagnosticEstimate": {
    "zh": "引擎诊断估算{p0}",
    "en": "Engine diagnostic estimate{p0}"
  },
  "session.ContextWindowButton.engineSummaryEstimate": {
    "zh": "引擎快速估算{p0}",
    "en": "Engine quick estimate{p0}"
  },
  "session.ContextWindowButton.refreshNeeded": {
    "zh": "（待刷新）",
    "en": "(refresh needed)"
  },
  "session.ContextWindowButton.latestMainRequestCount": {
    "zh": "最近主请求计数",
    "en": "Latest main request count"
  },
  "session.ContextWindowButton.engineDiagnosticsMayQuery": {
    "zh": "引擎诊断可查询 Token 计数接口，不生成模型回复",
    "en": "Engine diagnostics may query token counting APIs without generating a reply"
  },
  "session.ContextWindowButton.refreshing": {
    "zh": "刷新中…",
    "en": "Refreshing…"
  },
  "session.ContextWindowButton.refreshDetails": {
    "zh": "刷新明细",
    "en": "Refresh details"
  },
  "session.step.command": {
    "zh": "运行 {text}",
    "en": "Running {text}"
  },
  "session.step.edit": {
    "zh": "修改 {name}",
    "en": "Editing {name}"
  },
  "session.step.create": {
    "zh": "新建 {name}",
    "en": "Creating {name}"
  },
  "session.step.files": {
    "zh": "修改 {n} 个文件",
    "en": "Editing {n} files"
  },
  "session.step.read": {
    "zh": "读取 {text}",
    "en": "Reading {text}"
  },
  "session.step.search": {
    "zh": "搜索 {text}",
    "en": "Searching {text}"
  },
  "session.step.web": {
    "zh": "浏览 {text}",
    "en": "Browsing {text}"
  },
  "session.step.mcp": {
    "zh": "MCP {text}",
    "en": "MCP {text}"
  },
  "session.step.agent": {
    "zh": "子智能体：{text}",
    "en": "Subagent: {text}"
  },
  "session.step.tool": {
    "zh": "{name} {text}",
    "en": "{name} {text}"
  },
  "session.step.thinking": {
    "zh": "思考中",
    "en": "Thinking"
  },
  "session.step.more": {
    "zh": "等 {n} 项",
    "en": "+{n} more"
  },
  "session.step.seconds": {
    "zh": "{n}s",
    "en": "{n}s"
  },
  "session.wait.result": {
    "zh": "正在看结果…",
    "en": "Reading the result…"
  },
  "session.wait.next": {
    "zh": "正在准备下一步…",
    "en": "Preparing the next step…"
  },
  "session.wait.thinking": {
    "zh": "正在思考…",
    "en": "Thinking…"
  },
  "session.ContextWindowButton.refreshed": {
    "zh": "已刷新",
    "en": "Refreshed"
  },
  "session.ContextWindowButton.openMemoryFile": {
    "zh": "打开 {p0}",
    "en": "Open {p0}"
  },
  "session.ContextWindowButton.revealMemoryFile": {
    "zh": "在文件夹中显示",
    "en": "Show in folder"
  },
  "session.ContextWindowButton.demoLocalFile": {
    "zh": "演示模式不会打开本机文件",
    "en": "Demo mode doesn't open files on this computer"
  },
  "session.ContextWindowButton.remoteMemoryFile": {
    "zh": "远程机器上项目外的文件打不开",
    "en": "Files outside the project can't be opened on a remote machine"
  },
  "session.ContextWindowButton.contentCategoriesAreNot": {
    "zh": "内容分类尚未获取；可在会话空闲后刷新引擎诊断。",
    "en": "Content categories are not available yet. Refresh engine diagnostics when the conversation is idle."
  },
  "session.ContextWindowButton.latestOutputExcludedFrom": {
    "zh": "最近请求输出（不计入占用）",
    "en": "Latest output (excluded from usage)"
  },
  "session.ContextWindowButton.diagnosticsEstimateNewlyAdded": {
    "zh": "引擎诊断包含新增消息的估算，可能高于最近请求占用。",
    "en": "Diagnostics estimate newly added messages and may exceed the latest request's usage."
  },
  "session.ContextWindowButton.summaryEstimateNote": {
    "zh": "快速估算按最近一次请求的计数和本地估算分类，不调接口；点「刷新明细」用 Token 计数接口逐类统计。",
    "en": "The quick estimate splits the latest request's count with local estimates and calls no API; Refresh details counts each category with the token counting API."
  },
  "session.ContextWindowButton.usageIsSumOf": {
    "zh": "占用为最近一次主请求的三种输入总和，缓存已包含在输入内。",
    "en": "Usage is the sum of three input categories from the latest main request, including cached input."
  },
  "session.ContextWindowButton.modelNotReportedYet": {
    "zh": "模型尚未报告",
    "en": "Model not reported yet"
  },
  "session.ContextWindowButton.updated": {
    "zh": "· 更新于 {p0}",
    "en": "· Updated {p0}"
  },
  "session.ContextWindowButton.demoData": {
    "zh": "· 演示数据",
    "en": "· Demo data"
  },
  "session.live.agentTrace.running": {
    "zh": "运行中",
    "en": "Running"
  },
  "session.live.agentTrace.completed": {
    "zh": "已完成",
    "en": "Completed"
  },
  "session.live.agentTrace.failed": {
    "zh": "失败",
    "en": "Failed"
  },
  "session.live.agentTrace.stopped": {
    "zh": "已停止",
    "en": "Stopped"
  },
  "session.live.agentTrace.queued": {
    "zh": "排队中",
    "en": "Queued"
  },
  "session.live.agentTrace.n0s": {
    "zh": "0 秒",
    "en": "0s"
  },
  "session.live.agentTrace.s": {
    "zh": "{p0} 秒",
    "en": "{p0}s"
  },
  "session.live.agentTrace.mS": {
    "zh": "{p0} 分 {p1} 秒",
    "en": "{p0}m {p1}s"
  },
  "session.live.agentTrace.hM": {
    "zh": "{p0} 小时 {p1} 分",
    "en": "{p0}h {p1}m"
  },
  "session.live.AgentTracePanel.queued": {
    "zh": "（排队中）",
    "en": "(queued)"
  },
  "session.live.AgentTracePanel.timeline": {
    "zh": "时间线",
    "en": "Timeline"
  },
  "session.live.AgentTracePanel.duration": {
    "zh": "耗时",
    "en": "Duration"
  },
  "session.live.AgentTracePanel.tools": {
    "zh": "工具",
    "en": "Tools"
  },
  "session.live.AgentTracePanel.agents": {
    "zh": "{done}/{total} 个智能体",
    "en": "{done}/{total} agents"
  },
  "session.live.AgentTracePanel.toolCall": {
    "zh": "{n} 次工具调用",
    "en": "{n} tool call"
  },
  "session.live.AgentTracePanel.toolCalls": {
    "zh": "{n} 次工具调用",
    "en": "{n} tool calls"
  },
  "session.live.AgentTracePanel.noAgentsDispatchedYet": {
    "zh": "还没有派出智能体",
    "en": "No agents dispatched yet"
  },
  "session.live.AgentTracePanel.backToList": {
    "zh": "返回列表",
    "en": "Back to list"
  },
  "session.live.AgentTracePanel.task": {
    "zh": "任务",
    "en": "Task"
  },
  "session.live.AgentTracePanel.result": {
    "zh": "结果：",
    "en": "Result:"
  },
  "session.live.AgentTracePanel.loadingConversation": {
    "zh": "读取会话中",
    "en": "Loading conversation"
  },
  "session.live.AgentTracePanel.noOutputYet": {
    "zh": "还没有输出",
    "en": "No output yet"
  },
  "session.live.AgentTracePanel.agentActivity": {
    "zh": "智能体追踪",
    "en": "Agent activity"
  },
  "session.live.AgentTracePanel.orchestration": {
    "zh": "{n} 个编排",
    "en": "{n} orchestration"
  },
  "session.live.AgentTracePanel.orchestrations": {
    "zh": "{n} 个编排",
    "en": "{n} orchestrations"
  },
  "session.live.AgentTracePanel.subagent": {
    "zh": "{n} 个子智能体",
    "en": "{n} subagent"
  },
  "session.live.AgentTracePanel.subagents": {
    "zh": "{n} 个子智能体",
    "en": "{n} subagents"
  },
  "session.live.AgentTracePanel.tokensTotal": {
    "zh": "共 {tokens} tokens",
    "en": "{tokens} tokens total"
  },
  "session.live.AgentTracePanel.closeEsc": {
    "zh": "关闭（Esc）",
    "en": "Close (Esc)"
  },
  "session.live.AgentTracePanel.float": {
    "zh": "浮动",
    "en": "Float"
  },
  "session.live.AgentTracePanel.dockRight": {
    "zh": "停靠回右侧",
    "en": "Dock to the right"
  },
  "session.live.AgentTracePanel.resizeWidth": {
    "zh": "调整追踪窗口宽度",
    "en": "Resize trace panel width"
  },
  "session.live.AgentTracePanel.moveWindow": {
    "zh": "移动追踪窗口（方向键移动，Shift + 方向键调整大小，双击停靠）",
    "en": "Move trace window (arrows move, Shift + arrows resize, double-click to dock)"
  },
  "session.live.AgentTracePanel.noSubagentsRunningYet": {
    "zh": "还没有子智能体运行",
    "en": "No subagents running yet"
  },
  "session.live.AgentTracePanel.enableUltracodeOrAsk": {
    "zh": "开启 Ultracode，或让 Claude 调用 Agent 工具后，这里会显示每个智能体的运行轨迹、耗时和 token 消耗。",
    "en": "Enable Ultracode, or ask Claude to use the Agent tool, to view each agent's activity, duration and token usage."
  },
  "session.live.AgentTracePanel.subagentsAgentTool": {
    "zh": "子智能体（Agent 工具）",
    "en": "Subagents (Agent tool)"
  },
  "session.live.ApprovalCard.thisSession": {
    "zh": "本会话",
    "en": "This session"
  },
  "session.live.ApprovalCard.expiresWhenThisSession": {
    "zh": "关闭会话后失效",
    "en": "Expires when this session closes"
  },
  "session.live.ApprovalCard.thisProject": {
    "zh": "本项目",
    "en": "This project"
  },
  "session.live.ApprovalCard.saveToProjectsClaude": {
    "zh": "保存到项目的 .claude/settings.local.json",
    "en": "Save to the project's .claude/settings.local.json"
  },
  "session.live.ApprovalCard.allProjects": {
    "zh": "所有项目",
    "en": "All projects"
  },
  "session.live.ApprovalCard.saveToClaudeSettings": {
    "zh": "保存到 ~/.claude/settings.json",
    "en": "Save to ~/.claude/settings.json"
  },
  "session.live.ApprovalCard.alwaysAllow": {
    "zh": "始终允许",
    "en": "Always allow"
  },
  "session.live.ApprovalCard.alwaysAllow2": {
    "zh": "始终允许…",
    "en": "Always allow…"
  },
  "session.live.ApprovalCard.alwaysAllowScope": {
    "zh": "始终允许，范围",
    "en": "Always allow, scope"
  },
  "session.live.ApprovalCard.waitingForYourDecision": {
    "zh": "等你决定",
    "en": "Waiting for your decision"
  },
  "session.live.ApprovalCard.noPlanContent": {
    "zh": "（没有计划内容）",
    "en": "(No plan content)"
  },
  "session.live.ApprovalCard.selectMultiple": {
    "zh": "（可多选）",
    "en": "(Select multiple)"
  },
  "session.live.ApprovalCard.submitAnswers": {
    "zh": "提交回答",
    "en": "Submit answers"
  },
  "session.live.ApprovalCard.userSkippedThisQuestion": {
    "zh": "用户跳过了这个问题。",
    "en": "The user skipped this question."
  },
  "session.live.ApprovalCard.skip": {
    "zh": "跳过",
    "en": "Skip"
  },
  "session.live.ApprovalCard.startExecution": {
    "zh": "开始执行",
    "en": "Start execution"
  },
  "session.live.ApprovalCard.refinePlan": {
    "zh": "继续完善计划",
    "en": "Refine the plan"
  },
  "session.live.ApprovalCard.allowOnce": {
    "zh": "允许一次",
    "en": "Allow once"
  },
  "session.live.ApprovalCard.deny": {
    "zh": "拒绝",
    "en": "Deny"
  },
  "session.live.errorKind.platformSignInExpired": {
    "zh": "平台登录已失效或已切换账号：请重新登录像素星空账号，或改用自有继续",
    "en": "Platform sign-in expired or the account changed. Sign in to Pixel Starry Sky again, or continue with your own account."
  },
  "session.live.ItemRows.steered": {
    "zh": "已引导",
    "en": "Steered"
  },
  "session.live.UserBody.expand": {
    "zh": "展开全文",
    "en": "Show all"
  },
  "session.live.UserBody.collapse": {
    "zh": "收起",
    "en": "Show less"
  },
  "session.live.ItemRows.thinking": {
    "zh": "思考中…",
    "en": "Thinking…"
  },
  "session.live.ItemRows.thinking2": {
    "zh": "思考过程",
    "en": "Thinking"
  },
  "session.live.ItemRows.noChangesToDisplay": {
    "zh": "没有可显示的改动内容",
    "en": "No changes to display"
  },
  "session.live.ItemRows.denied": {
    "zh": "已拒绝",
    "en": "Denied"
  },
  "session.live.ItemRows.interrupted": {
    "zh": "已中断",
    "en": "Interrupted"
  },
  "session.live.ItemRows.read": {
    "zh": "读取",
    "en": "Read"
  },
  "session.live.ItemRows.search": {
    "zh": "搜索",
    "en": "Search"
  },
  "session.live.ItemRows.web": {
    "zh": "网页",
    "en": "Web"
  },
  "session.live.ItemRows.subtask": {
    "zh": "子任务",
    "en": "Subtask"
  },
  "session.live.ItemRows.subagentCall": {
    "zh": "子智能体「{p0}」调用",
    "en": "Subagent \"{p0}\" call"
  },
  "session.live.ItemRows.create": {
    "zh": "新建",
    "en": "Create"
  },
  "session.live.ItemRows.edit": {
    "zh": "编辑",
    "en": "Edit"
  },
  "session.live.ItemRows.running": {
    "zh": "正在运行",
    "en": "Running"
  },
  "session.live.ItemRows.ran": {
    "zh": "运行了",
    "en": "Ran"
  },
  "session.live.ItemRows.openInPixelStarry": {
    "zh": "在像素星空中打开 {p0}",
    "en": "Open {p0} in Pixel Starry Sky"
  },
  "session.live.ItemRows.collapseFileChanges": {
    "zh": "收起文件改动",
    "en": "Collapse file changes"
  },
  "session.live.ItemRows.expandFileChanges": {
    "zh": "展开文件改动",
    "en": "Expand file changes"
  },
  "session.live.ItemRows.orchestration": {
    "zh": "编排",
    "en": "Orchestration"
  },
  "session.live.ItemRows.viewActivity": {
    "zh": "查看追踪",
    "en": "View activity"
  },
  "session.live.ItemRows.toDo": {
    "zh": "待办",
    "en": "To-do"
  },
  "session.live.LiveTranscript.openingConversation": {
    "zh": "正在打开会话…",
    "en": "Opening conversation…"
  },
  "session.live.LiveTranscript.working": {
    "zh": "正在处理…",
    "en": "Working…"
  },
  "session.live.LiveTranscript.jumpToLatest": {
    "zh": "回到最新",
    "en": "Jump to latest"
  },
  "session.live.LiveTranscript.newContent": {
    "zh": "新内容",
    "en": "New content"
  },
  "session.live.NoticeActions.retry": {
    "zh": "重试",
    "en": "Try again"
  },
  "session.live.NoticeActions.retryMessage": {
    "zh": "继续",
    "en": "Try again"
  },
  "session.live.NoticeActions.compactRetry": {
    "zh": "压缩后重试",
    "en": "Compact and retry"
  },
  "session.live.NoticeActions.changeRoute": {
    "zh": "换线路",
    "en": "Change route"
  },
  "session.live.NoticeActions.continueWithOwnAccount": {
    "zh": "改用自有继续",
    "en": "Continue with own account"
  },
  "session.live.NoticeActions.continueWithPlatform": {
    "zh": "改用平台继续",
    "en": "Continue with platform"
  },
  "session.live.NoticeActions.viewAccount": {
    "zh": "查看账户",
    "en": "View account"
  },
  "session.live.NoticeActions.signInAgain": {
    "zh": "重新登录",
    "en": "Sign in again"
  },
  "session.live.RetryStatus.requestRetryProgress": {
    "zh": "请求重试进度",
    "en": "Request retry progress"
  },
  "session.live.RetryStatus.retrying": {
    "zh": "，正在重试",
    "en": ", retrying"
  },
  "session.live.RetryStatus.resumingInAboutS": {
    "zh": "· 约 {p0} 秒后继续",
    "en": "· Resuming in about {p0}s"
  },
  "session.live.RetryStatus.retryingRequest": {
    "zh": "· 正在重新请求…",
    "en": "· Retrying request…"
  },
  "session.live.SessionStrips.viewSubagentConversation": {
    "zh": "查看子智能体会话",
    "en": "View subagent conversation"
  },
  "session.live.SessionStrips.collapseOutput": {
    "zh": "收起输出",
    "en": "Collapse output"
  },
  "session.live.SessionStrips.output": {
    "zh": "输出",
    "en": "Output"
  },
  "session.live.SessionStrips.loading": {
    "zh": "读取中…",
    "en": "Loading…"
  },
  "session.live.SessionStrips.showingLastPortionOnly": {
    "zh": "只显示最后一段",
    "en": "Showing the last portion only"
  },
  "session.live.SessionStrips.noOutputYet": {
    "zh": "暂无输出",
    "en": "No output yet"
  },
  "session.ModelSourceMenu.platform": {
    "zh": "平台",
    "en": "Platform"
  },
  "session.ModelSourceMenu.ownAccount": {
    "zh": "自有",
    "en": "Own account"
  },
  "session.ModelSourceMenu.chooseModel": {
    "zh": "选择模型",
    "en": "Choose model"
  },
  "session.ModelSourceMenu.platform2": {
    "zh": "平台 {p0}",
    "en": "Platform {p0}"
  },
  "session.ModelSourceMenu.engine": {
    "zh": "引擎",
    "en": "Engine"
  },
  "session.ModelSourceMenu.comingSoon": {
    "zh": "{p0} · 即将支持",
    "en": "{p0} · Coming soon"
  },
  "session.ModelSourceMenu.comingSoon2": {
    "zh": "即将支持",
    "en": "Coming soon"
  },
  "session.ModelSourceMenu.creditSource": {
    "zh": "额度来源",
    "en": "Credit source"
  },
  "session.ModelSourceMenu.platformCreditsCurrentlySupport": {
    "zh": "平台额度目前只支持 Claude Code",
    "en": "Platform credits currently support Claude Code only"
  },
  "session.ModelSourceMenu.appliesToThisConversation": {
    "zh": "只改这个会话；平台和自有之间切换会重启引擎并接上原对话",
    "en": "Applies to this conversation only. Switching credit sources restarts the engine and resumes your conversation."
  },
  "session.ModelSourceMenu.model": {
    "zh": "模型",
    "en": "Model"
  },
  "session.ModelSourceMenu.allModelsAreHidden": {
    "zh": "所有模型都隐藏了",
    "en": "All models are hidden"
  },
  "session.ModelSourceMenu.searchModels": {
    "zh": "搜索模型",
    "en": "Search models"
  },
  "session.ModelSourceMenu.noMatchingModels": {
    "zh": "没有匹配的模型",
    "en": "No matching models"
  },
  "session.ModelSourceMenu.routes": {
    "zh": "{p0}{p1} · {p2} 条线路",
    "en": "{p0}{p1} · {p2} routes"
  },
  "session.ModelSourceMenu.modelsAppearAfterRoutes": {
    "zh": "读取线路后显示模型",
    "en": "Models appear after routes load"
  },
  "session.ModelSourceMenu.signInToView": {
    "zh": "登录后显示平台模型",
    "en": "Sign in to view platform models"
  },
  "session.ModelSourceMenu.modelUsedByThis": {
    "zh": "当前会话使用的模型",
    "en": "Model used by this conversation"
  },
  "session.ModelSourceMenu.manageModels": {
    "zh": "管理模型…",
    "en": "Manage models…"
  },
  "session.ModelSourceMenu.hidden": {
    "zh": "（已隐藏",
    "en": "(hidden:"
  },
  "session.ModelSourceMenu.text": {
    "zh": "个）",
    "en": ")"
  },
  "session.ModelSourceMenu.useThisConversationsCredit": {
    "zh": "把这个会话的额度来源、线路和模型设为新任务的默认",
    "en": "Use this conversation's credit source, route and model as defaults for new tasks"
  },
  "session.ModelSourceMenu.setAsDefault": {
    "zh": "设为默认",
    "en": "Set as default"
  },
  "session.ModelSourceMenu.refreshing": {
    "zh": "正在刷新…",
    "en": "Refreshing…"
  },
  "session.ModelSourceMenu.signInToPixel": {
    "zh": "登录像素星空账号后使用平台额度",
    "en": "Sign in to Pixel Starry Sky to use platform credits"
  },
  "session.ModelSourceMenu.loadingRoutes": {
    "zh": "正在读取线路…",
    "en": "Loading routes…"
  },
  "session.ModelSourceMenu.retry": {
    "zh": "重试",
    "en": "Retry"
  },
  "session.ModelSourceMenu.chooseRoute": {
    "zh": "选择线路",
    "en": "Choose route"
  },
  "session.ModelSourceMenu.route": {
    "zh": "线路",
    "en": "Route"
  },
  "session.ModelSourceMenu.thisAccountsBillingMultiplier": {
    "zh": "当前账号在这条线路上的计费倍率",
    "en": "This account's billing multiplier for this route"
  },
  "session.ModelSourceMenu.localSignIn": {
    "zh": "本机登录",
    "en": "Local sign-in"
  },
  "session.ModelSourceMenu.version": {
    "zh": "· 版本 {p0}",
    "en": "· Version {p0}"
  },
  "session.ModelSourceMenu.signInToFirst": {
    "zh": "需要先登录 {p0}",
    "en": "Sign in to {p0} first"
  },
  "session.ModelSourceMenu.isTemporarilyUnavailable": {
    "zh": "{p0} 暂时不可用",
    "en": "{p0} is temporarily unavailable"
  },
  "session.ModelSourceMenu.collapse": {
    "zh": "收起",
    "en": "Collapse"
  },
  "session.ModelSourceMenu.howToSignIn": {
    "zh": "怎么登录",
    "en": "How to sign in"
  },
  "session.ModelSourceMenu.viewReason": {
    "zh": "查看原因",
    "en": "View reason"
  },
  "session.ModelSourceMenu.available": {
    "zh": "可用）",
    "en": "available)"
  },
  "session.ModelSourceMenu.insufficientBalance": {
    "zh": "· 余额不足",
    "en": "· Insufficient balance"
  },
  "session.ModelSourceMenu.onlyRoutesSupportingThis": {
    "zh": "不含这个模型的线路不列出；按倍率从低到高排",
    "en": "Only routes supporting this model are shown, ordered by billing multiplier"
  },
  "session.QueuedMessages.messageQueue": {
    "zh": "消息队列",
    "en": "Message queue"
  },
  "session.QueuedMessages.queuePaused": {
    "zh": "队列已暂停",
    "en": "Queue paused"
  },
  "session.QueuedMessages.resumeQueue": {
    "zh": "继续队列",
    "en": "Resume queue"
  },
  "session.QueuedMessages.expandAll": {
    "zh": "展开全部",
    "en": "Expand all"
  },
  "session.QueuedMessages.steeringHasNotBeen": {
    "zh": "当前引擎尚未通过引导验证，可等待或插队",
    "en": "Steering has not been validated for this engine. Wait or run this message next."
  },
  "session.QueuedMessages.noTaskCanAccept": {
    "zh": "当前没有可接收引导的任务，或正在等待审批",
    "en": "No task can accept steering right now, or approval is pending"
  },
  "session.QueuedMessages.settingsDifferFromCurrent": {
    "zh": "设置与当前任务不同，可等待或插队",
    "en": "Settings differ from the current task. Wait or run this message next."
  },
  "session.QueuedMessages.sendAdditionalInstructionsTo": {
    "zh": "不中断，将补充要求交给当前任务",
    "en": "Send additional instructions to the current task without interrupting it"
  },
  "session.QueuedMessages.executionFailed": {
    "zh": "执行失败",
    "en": "Execution failed"
  },
  "session.QueuedMessages.deliveryNeedsVerification": {
    "zh": "交付待核对",
    "en": "Delivery needs verification"
  },
  "session.QueuedMessages.waitingForAdoption": {
    "zh": "等待采纳",
    "en": "Waiting for adoption"
  },
  "session.QueuedMessages.starting": {
    "zh": "正在启动",
    "en": "Starting"
  },
  "session.QueuedMessages.moveMessageUp": {
    "zh": "上移消息（Alt+↑）",
    "en": "Move message up (Alt+↑)"
  },
  "session.QueuedMessages.moveMessageDown": {
    "zh": "下移消息（Alt+↓）",
    "en": "Move message down (Alt+↓)"
  },
  "session.QueuedMessages.steer": {
    "zh": "引导",
    "en": "Steer"
  },
  "session.QueuedMessages.runAgainAfterChecking": {
    "zh": "已核对后重新执行；可能重复上次已发生的操作",
    "en": "Run again after checking. Previously completed actions may be repeated."
  },
  "session.QueuedMessages.interruptCurrentTaskAnd": {
    "zh": "中断当前任务，优先执行这条消息",
    "en": "Interrupt the current task and run this message first"
  },
  "session.QueuedMessages.runNext": {
    "zh": "插队",
    "en": "Run next"
  },
  "session.QueuedMessages.withdraw": {
    "zh": "撤回",
    "en": "Withdraw"
  },
  "session.QueuedMessages.modelEffortAndCredit": {
    "zh": "模型、强度与额度来源按入队时的选择执行；权限和会话开关按执行时读取",
    "en": "Model, effort and credit source are saved when queued; permissions and session switches are read at execution time"
  },
  "session.QueuedMessages.engineDefaultModel": {
    "zh": "引擎默认模型",
    "en": "Engine default model"
  },
  "session.QueuedMessages.platformRoute": {
    "zh": "平台线路 {p0}",
    "en": "Platform route {p0}"
  },
  "session.QueuedMessages.ownCredits": {
    "zh": "自有额度",
    "en": "Own credits"
  },
  "session.QueuedMessages.viewFullMessage": {
    "zh": "查看完整消息",
    "en": "View full message"
  },
  "session.message.copy": {
    "zh": "复制消息",
    "en": "Copy message"
  },
  "session.message.copyReply": {
    "zh": "复制回复",
    "en": "Copy reply"
  },
  "session.message.rewind": {
    "zh": "回退到这里",
    "en": "Rewind to here"
  },
  "session.message.rewindHint": {
    "zh": "移除这条消息及之后的对话，原文放回输入框",
    "en": "Remove this message and everything after it, and put the text back in the input box"
  },
  "session.message.rewindBusy": {
    "zh": "请先停止当前任务再回退",
    "en": "Stop the current task before rewinding"
  },
  "session.message.rewindUnsupported": {
    "zh": "当前引擎暂不支持回退",
    "en": "The current engine does not support rewinding yet"
  },
  "session.message.rewindTitle": {
    "zh": "回退到这条消息？",
    "en": "Rewind to this message?"
  },
  "session.message.rewindDesc": {
    "zh": "这条消息及之后的对话会被移除，模型上下文回到这条消息之前，原文和图片会放回输入框。项目里的文件改动不会恢复；发下一条消息之前可以撤销。",
    "en": "This message and everything after it will be removed, and the model context returns to before this message. The text and images go back to the input box. File changes in the project are not reverted. You can undo this until you send the next message."
  },
  "session.message.rewindConfirm": {
    "zh": "回退",
    "en": "Rewind"
  },
  "session.message.cancel": {
    "zh": "取消",
    "en": "Cancel"
  },
  "session.message.rewindSkip": {
    "zh": "以后不再提示",
    "en": "Don't ask again"
  },
  "session.QueuedMessages.held": {
    "zh": "已暂停",
    "en": "Paused"
  },
  "session.QueuedMessages.heldHint": {
    "zh": "之前暂停的消息保持暂停，新消息会直接发送",
    "en": "Earlier paused messages stay paused; new messages are sent directly"
  },
  "session.SessionHeader.expandSidebar": {
    "zh": "展开侧边栏",
    "en": "Expand sidebar"
  },
  "session.SessionHeader.more": {
    "zh": "更多",
    "en": "More"
  },
  "session.SessionHeader.terminal": {
    "zh": "终端",
    "en": "Terminal"
  },
  "session.SessionHeader.commandPalette": {
    "zh": "命令面板",
    "en": "Command palette"
  },
  "session.SessionHeader.switchComputer": {
    "zh": "切换机器",
    "en": "Switch computer"
  },
  "session.SessionHeader.local": {
    "zh": "本机",
    "en": "Local"
  },
  "session.SessionHeader.collapseRightPanel": {
    "zh": "收起右侧面板",
    "en": "Collapse right panel"
  },
  "session.SessionHeader.expandRightPanel": {
    "zh": "展开右侧面板",
    "en": "Expand right panel"
  },
  "session.SourceHintBar.switchTo": {
    "zh": "改用{p0}",
    "en": "Switch to {p0}"
  },
  "session.SourceHintBar.switchTo2": {
    "zh": "换到",
    "en": "Switch to"
  },
  "session.SourceHintBar.toContinueThisConversation": {
    "zh": "继续这段对话？",
    "en": "to continue this conversation?"
  },
  "session.SourceHintBar.futureRequestsAreBilled": {
    "zh": "之后的调用由本机 {p0} 的登录付费。",
    "en": "Future requests are billed to your local {p0} account."
  },
  "session.SourceHintBar.futureRequestsUsePlatform": {
    "zh": "之后的调用走平台{p0}，从像素星空账号扣费。",
    "en": "Future requests use platform{p0} and are billed to your Pixel Starry Sky account."
  },
  "session.SourceHintBar.route": {
    "zh": "线路「{p0}」",
    "en": "route \"{p0}\""
  },
  "session.SourceHintBar.engineRestartsAndResumes": {
    "zh": "引擎会重启并接上原来的对话，从下一条消息生效。",
    "en": "The engine restarts and resumes this conversation. Takes effect on the next message."
  },
  "session.SourceHintBar.useOwnAccount": {
    "zh": "改用自有",
    "en": "Use own account"
  },
  "session.SourceHintBar.usePlatform": {
    "zh": "改用平台",
    "en": "Use platform"
  },
  "session.SourceHintBar.signInToPixel": {
    "zh": "平台额度需要先登录像素星空账号",
    "en": "Sign in to Pixel Starry Sky to use platform credits"
  },
  "session.SourceHintBar.thisConversationUses": {
    "zh": "这个会话用的是",
    "en": "This conversation uses"
  },
  "session.SourceHintBar.sPlatformCreditsSigned": {
    "zh": "的平台额度，当前登录的不是这个账号",
    "en": "'s platform credits. The signed-in account does not match."
  },
  "session.SourceHintBar.insufficientBalanceThisRoute": {
    "zh": "余额不足，这条线路按余额计费，发送可能会失败",
    "en": "Insufficient balance. This route uses balance billing and sending may fail."
  },
  "session.SourceHintBar.detectAgain": {
    "zh": "重新检测",
    "en": "Detect again"
  },
  "session.ToolRow.expandToolOutput": {
    "zh": "展开工具输出",
    "en": "Expand tool output"
  },
  "session.TurnStats.replyStatistics": {
    "zh": "回复统计",
    "en": "Reply statistics"
  },
  "session.turnStatsData.uncachedInputCacheRead": {
    "zh": "{p0}：普通输入 {p1} · 缓存读 {p2} · 缓存写 {p3} · 输出 {p4} · {p5} 次请求 · {p6}",
    "en": "{p0}: Uncached input {p1} · Cache read {p2} · Cache write {p3} · Output {p4} · {p5} requests · {p6}"
  },
  "session.turnStatsData.totalDuration": {
    "zh": "总耗时",
    "en": "Total duration"
  },
  "session.turnStatsData.inputIncludingCacheReads": {
    "zh": "输入（含缓存读取、写入） / 输出 Token",
    "en": "Input (including cache reads and writes) / output tokens"
  },
  "session.turnStatsData.costEngineEstimate": {
    "zh": "费用（引擎报告的估算）",
    "en": "Cost (engine estimate)"
  },
  "session.turnStatsData.input": {
    "zh": "输入",
    "en": "Input"
  },
  "session.turnStatsData.uncachedInputTokensExcluding": {
    "zh": "普通输入 Token（不含缓存读取和写入）",
    "en": "Uncached input tokens (excluding cache reads and writes)"
  },
  "session.turnStatsData.outputTokens": {
    "zh": "输出 Token",
    "en": "Output tokens"
  },
  "session.turnStatsData.total": {
    "zh": "总计",
    "en": "Total"
  },
  "session.turnStatsData.totalTokensUncachedInput": {
    "zh": "总 Token（普通输入 + 缓存读取 + 缓存写入 + 输出）",
    "en": "Total tokens (uncached input + cache read + cache write + output)"
  },
  "session.turnStatsData.cacheRead": {
    "zh": "缓存读",
    "en": "Cache read"
  },
  "session.turnStatsData.cacheReadTokens": {
    "zh": "缓存读取 Token",
    "en": "Cache read tokens"
  },
  "session.turnStatsData.cacheWrite": {
    "zh": "缓存写",
    "en": "Cache write"
  },
  "session.turnStatsData.cacheWriteTokens": {
    "zh": "缓存写入 Token",
    "en": "Cache write tokens"
  },
  "session.turnStatsData.cacheHit": {
    "zh": "缓存命中 {p0}%",
    "en": "Cache hit {p0}%"
  },
  "session.turnStatsData.cacheReadAllInput": {
    "zh": "缓存读取 / 全部输入 Token（含缓存读取和写入）",
    "en": "Cache read / all input tokens (including cache reads and writes)"
  },
  "session.turnStatsData.requests": {
    "zh": "请求 {p0} 次",
    "en": "{p0} requests"
  },
  "session.turnStatsData.sumOfRequestCounts": {
    "zh": "各模型请求次数之和，沿用引擎统计口径",
    "en": "Sum of request counts across models, as reported by the engine"
  },
  "session.WelcomeView.howCanIHelp": {
    "zh": "有什么可以帮你？",
    "en": "How can I help?"
  },
  "session.WelcomeView.chooseProjectFolderThen": {
    "zh": "先选择一个项目文件夹，然后描述你要做的事",
    "en": "Choose a project folder, then describe what you want to do"
  },
  "session.WelcomeView.startNewTaskOn": {
    "zh": "在这台电脑上开始一个新任务",
    "en": "Start a new task on this computer"
  },
  "session.WelcomeView.starters": {
    "zh": "从这里开始",
    "en": "Starting points"
  },
  "session.WelcomeView.reviewChanges": {
    "zh": "看看未提交的改动（{n} 个文件）",
    "en": "Review uncommitted changes ({n} files)"
  },
  "session.WelcomeView.reviewChangesPrompt": {
    "zh": "看看当前未提交的改动：说说改了什么，有没有明显的问题。",
    "en": "Look at the current uncommitted changes: summarize what changed and point out any obvious problems."
  },
  "session.WelcomeView.explainProject": {
    "zh": "介绍这个项目",
    "en": "Explain this project"
  },
  "session.WelcomeView.explainProjectPrompt": {
    "zh": "介绍一下这个项目：它是做什么的、目录结构、怎么运行和测试。",
    "en": "Give me an overview of this project: what it does, how it is organized, and how to run and test it."
  },
  "session.WelcomeView.runTests": {
    "zh": "跑一遍测试",
    "en": "Run the tests"
  },
  "session.WelcomeView.runTestsPrompt": {
    "zh": "跑一遍这个项目的测试；有失败的话找出原因，先说明再改。",
    "en": "Run this project's tests. If anything fails, find the cause and explain it before changing any code."
  },
  "sidebar.NewTaskButton.newTask": {
    "zh": "新建任务",
    "en": "New task"
  },
  "sidebar.ProjectTree.noConversationsYet": {
    "zh": "暂无会话",
    "en": "No conversations yet"
  },
  "sidebar.RunStatusPill.newReply": {
    "zh": "新回复",
    "en": "New reply"
  },
  "sidebar.Sidebar.addProject": {
    "zh": "添加项目",
    "en": "Add project"
  },
  "sidebar.Sidebar.pinned": {
    "zh": "置顶",
    "en": "Pinned"
  },
  "sidebar.Sidebar.projects": {
    "zh": "项目",
    "en": "Projects"
  },
  "sidebar.Sidebar.noProjectsYet": {
    "zh": "还没有项目",
    "en": "No projects yet"
  },
  "sidebar.Sidebar.addProjectFolder": {
    "zh": "添加项目文件夹",
    "en": "Add project folder"
  },
  "sidebar.Sidebar.recentTasks": {
    "zh": "最近任务",
    "en": "Recent tasks"
  },
  "sidebar.SidebarFooter.balance": {
    "zh": "余额 {p0}",
    "en": "Balance {p0}"
  },
  "sidebar.SidebarFooter.signingIn": {
    "zh": "登录中…",
    "en": "Signing in…"
  },
  "sidebar.SidebarFooter.notSignedIn": {
    "zh": "未登录",
    "en": "Not signed in"
  },
  "sidebar.SidebarFooter.settings": {
    "zh": "设置",
    "en": "Settings"
  },
  "sidebar.SidebarHeader.switchWorkspace": {
    "zh": "切换工作区",
    "en": "Switch workspace"
  },
  "sidebar.SidebarHeader.collapseSidebar": {
    "zh": "收起侧边栏",
    "en": "Collapse sidebar"
  },
  "ui.Chip.remove": {
    "zh": "移除",
    "en": "Remove"
  },
  "ui.ComingSoon.isComingSoon": {
    "zh": "「{p0}」即将推出",
    "en": "\"{p0}\" is coming soon"
  },
  "ui.Logo.pixelStarrySky": {
    "zh": "像素星空",
    "en": "Pixel Starry Sky"
  },
  "ui.ResizeHandle.doubleClickOrEnter": {
    "zh": "{p0}；双击或 Enter 恢复默认；方向键微调",
    "en": "{p0}; double-click or Enter to reset; arrow keys to adjust"
  },
  "editor.code.positions.spaces": {
    "zh": "空格: {p0}",
    "en": "Spaces: {p0}"
  },
  "editor.code.theme.find": {
    "zh": "查找",
    "en": "Find"
  },
  "editor.code.theme.replace": {
    "zh": "替换",
    "en": "Replace"
  },
  "editor.code.theme.replaceAll": {
    "zh": "全部替换",
    "en": "Replace all"
  },
  "editor.code.theme.next": {
    "zh": "下一个",
    "en": "Next"
  },
  "editor.code.theme.previous": {
    "zh": "上一个",
    "en": "Previous"
  },
  "editor.code.theme.all": {
    "zh": "全部",
    "en": "All"
  },
  "editor.code.theme.matchCase": {
    "zh": "区分大小写",
    "en": "Match case"
  },
  "editor.code.theme.regularExpression": {
    "zh": "正则表达式",
    "en": "Regular expression"
  },
  "editor.code.theme.wholeWords": {
    "zh": "全词匹配",
    "en": "Whole words"
  },
  "editor.code.theme.close": {
    "zh": "关闭",
    "en": "Close"
  },
  "editor.code.theme.goToLine": {
    "zh": "跳到行",
    "en": "Go to line"
  },
  "editor.code.theme.go": {
    "zh": "跳转",
    "en": "Go"
  },
  "editor.code.theme.foldLine": {
    "zh": "折叠行",
    "en": "Fold line"
  },
  "editor.code.theme.unfoldLine": {
    "zh": "展开行",
    "en": "Unfold line"
  },
  "editor.code.theme.replaceWith": {
    "zh": "替换为",
    "en": "Replace with"
  },
  "editor.code.theme.noMatches": {
    "zh": "没有匹配项",
    "en": "No matches"
  },
  "editor.EditorButton.demoModeCannotOpen": {
    "zh": "演示模式不打开本机编辑器",
    "en": "Demo mode cannot open local editors"
  },
  "editor.EditorButton.requestedToOpenProject": {
    "zh": "已请求 {p0} 打开项目",
    "en": "Requested {p0} to open the project"
  },
  "editor.EditorButton.externalEditor": {
    "zh": "外部编辑器",
    "en": "External editor"
  },
  "editor.EditorButton.chooseProjectFirst": {
    "zh": "先选择项目",
    "en": "Choose a project first"
  },
  "editor.EditorButton.unavailable": {
    "zh": "（不可用）",
    "en": "(unavailable)"
  },
  "editor.EditorIcon.shortcut": {
    "zh": "快捷方式",
    "en": "Shortcut"
  },
  "editor.EditorIcon.defaultLocation": {
    "zh": "默认位置",
    "en": "Default location"
  },
  "editor.EditorIcon.manuallySpecified": {
    "zh": "手动指定",
    "en": "Manually specified"
  },
  "editor.ExternalFileButton.openFileInExternal": {
    "zh": "用外部编辑器打开文件（定位当前行）",
    "en": "Open file in external editor at the current line"
  },
  "editor.ExternalFileButton.noEditorDetectedSpecify": {
    "zh": "未检测到编辑器，请在设置中指定程序路径",
    "en": "No editor detected. Specify its executable in settings."
  },
  "editor.FileEditor.loadingFile": {
    "zh": "读取文件…",
    "en": "Loading file…"
  },
  "editor.FileEditor.backToMarkdownEditor": {
    "zh": "返回 Markdown 编辑",
    "en": "Back to Markdown editor"
  },
  "editor.FileEditor.previewMarkdown": {
    "zh": "预览 Markdown",
    "en": "Preview Markdown"
  },
  "editor.FileEditor.saveFileCtrlS": {
    "zh": "保存文件（Ctrl+S）",
    "en": "Save file (Ctrl+S)"
  },
  "editor.FileEditor.reloadFile": {
    "zh": "重新加载文件",
    "en": "Reload file"
  },
  "editor.FileEditor.loadNewVersion": {
    "zh": "载入新版本",
    "en": "Load new version"
  },
  "editor.FileEditor.fileChangedExternallyYour": {
    "zh": "文件已被修改，你的未保存内容仍保留。",
    "en": "The file changed externally. Your unsaved edits are preserved."
  },
  "editor.FileEditor.keepMyChanges": {
    "zh": "保留我的修改",
    "en": "Keep my changes"
  },
  "editor.FileEditor.dismissFileNotice": {
    "zh": "关闭文件提示",
    "en": "Dismiss file notice"
  },
  "editor.FileEditor.thisFileExceeds2": {
    "zh": "文件超过 2MiB，以只读纯文本打开。可用外部编辑器编辑。",
    "en": "This file exceeds 2 MiB and opens as read-only plain text. Use an external editor to edit it."
  },
  "editor.FileEditor.saving": {
    "zh": "保存中…",
    "en": "Saving…"
  },
  "editor.FileEditor.unsaved": {
    "zh": "未保存",
    "en": "Unsaved"
  },
  "editor.FileEditor.ln": {
    "zh": "行",
    "en": "Ln"
  },
  "editor.FileEditor.col": {
    "zh": "，列",
    "en": ", Col"
  },
  "editor.FileEditor.couldNotReadThis": {
    "zh": "无法读取此文件",
    "en": "Could not read this file"
  },
  "editor.FileEditor.useExternalEditorButton": {
    "zh": "请用工具栏的外部编辑器打开。",
    "en": "Use the external editor button in the toolbar."
  },
  "engine.hooks.newConversation": {
    "zh": "新会话",
    "en": "New conversation"
  },
  "engine.hooks.isNotSignedIn": {
    "zh": "{p0} 还没登录",
    "en": "{p0} is not signed in"
  },
  "engine.hooks.isUnavailable": {
    "zh": "{p0} 不可用",
    "en": "{p0} is unavailable"
  },
  "engine.hooks.signInToPixel": {
    "zh": "请先登录像素星空账号",
    "en": "Sign in to Pixel Starry Sky first"
  },
  "engine.hooks.noRouteSupportsThis": {
    "zh": "没有包含这个模型的线路",
    "en": "No route supports this model"
  },
  "engine.hooks.conversationNotFound": {
    "zh": "会话不存在",
    "en": "Conversation not found"
  },
  "engine.hooks.noTaskIsCurrently": {
    "zh": "当前没有运行中的任务",
    "en": "No task is currently running"
  },
  "engine.hooks.signInToPixel2": {
    "zh": "平台额度需要先登录像素星空账号，或改用自有",
    "en": "Sign in to Pixel Starry Sky to use platform credits, or use your own account"
  },
  "engine.hooks.thisConversationUsesS": {
    "zh": "这个会话用的是 {p0} 的平台额度，请登录该账号或改用自有",
    "en": "This conversation uses {p0}'s platform credits. Sign in to that account or use your own account."
  },
  "engine.hooks.platformRoutesAreLoading": {
    "zh": "正在读取平台线路，请稍后再发",
    "en": "Platform routes are loading. Please wait before sending."
  },
  "engine.hooks.chooseProjectFolderFirst": {
    "zh": "请先选择一个项目文件夹",
    "en": "Choose a project folder first"
  },
  "engine.labels.unavailableForFreeAccounts": {
    "zh": "免费账号不能使用",
    "en": "Unavailable for free accounts"
  },
  "engine.labels.fastModeIsNot": {
    "zh": "账号没有开启 Fast 模式",
    "en": "Fast mode is not enabled for this account"
  },
  "engine.labels.extraUsageIsNot": {
    "zh": "账号没有开启额外用量",
    "en": "Extra usage is not enabled for this account"
  },
  "engine.labels.networkError": {
    "zh": "网络错误",
    "en": "Network error"
  },
  "engine.labels.onlySupportedByOfficial": {
    "zh": "只支持 Anthropic 官方接口",
    "en": "Only supported by the official Anthropic API"
  },
  "engine.labels.disabledByEnvironmentVariable": {
    "zh": "被环境变量关闭了",
    "en": "Disabled by an environment variable"
  },
  "engine.labels.checkingAccountStatus": {
    "zh": "正在确认账号状态",
    "en": "Checking account status"
  },
  "engine.labels.temporarilyUnavailable": {
    "zh": "暂时不可用",
    "en": "Temporarily unavailable"
  },
  "engine.labels.multiAgentOrchestration": {
    "zh": "多智能体编排",
    "en": "Multi-agent orchestration"
  },
  "engine.labels.backgroundCommand": {
    "zh": "后台命令",
    "en": "Background command"
  },
  "engine.labels.subagent": {
    "zh": "子智能体",
    "en": "Subagent"
  },
  "engine.labels.monitorTask": {
    "zh": "监视任务",
    "en": "Monitor task"
  },
  "engine.labels.backgroundTask": {
    "zh": "后台任务",
    "en": "Background task"
  },
  "engine.labels.askEveryTime": {
    "zh": "每次询问",
    "en": "Ask every time"
  },
  "engine.labels.askBeforeEditingFiles": {
    "zh": "改文件、运行命令前都先问你",
    "en": "Ask before editing files or running commands"
  },
  "engine.labels.autoEdit": {
    "zh": "自动编辑",
    "en": "Auto-edit"
  },
  "engine.labels.editProjectFilesAutomatically": {
    "zh": "项目里改文件不问，运行命令要问",
    "en": "Edit project files automatically; ask before running commands"
  },
  "engine.labels.planMode": {
    "zh": "计划模式",
    "en": "Plan mode"
  },
  "engine.labels.readOnlyProposePlan": {
    "zh": "只读，先出方案，你同意后再动手",
    "en": "Read-only. Propose a plan and wait for approval before acting."
  },
  "engine.labels.fullAccess": {
    "zh": "完全放行",
    "en": "Full access"
  },
  "engine.labels.executeWithoutAskingUse": {
    "zh": "什么都不问，直接执行，请小心",
    "en": "Execute without asking. Use with care."
  },
  "engine.labels.m": {
    "zh": "{p0}分钟",
    "en": "{p0}m"
  },
  "engine.labels.h": {
    "zh": "{p0}小时",
    "en": "{p0}h"
  },
  "engine.labels.d": {
    "zh": "{p0}天",
    "en": "{p0}d"
  },
  "engine.labels.default": {
    "zh": "默认",
    "en": "Default"
  },
  "engine.labels.useClaudeCodeSettings": {
    "zh": "跟随 Claude Code 的设置",
    "en": "Use Claude Code settings"
  },
  "engine.labels.latestOpus": {
    "zh": "最新 Opus",
    "en": "Latest Opus"
  },
  "engine.labels.latestSonnet": {
    "zh": "最新 Sonnet",
    "en": "Latest Sonnet"
  },
  "engine.labels.latestHaiku": {
    "zh": "最新 Haiku",
    "en": "Latest Haiku"
  },
  "engine.labels.useCodexSettings": {
    "zh": "跟随 Codex 的设置",
    "en": "Use Codex settings"
  },
  "engine.openRequests.thisConversationWasDeleted": {
    "zh": "这个会话已经删除",
    "en": "This conversation was deleted"
  },
  "files.FileConfirm.filesHaveUnsavedChanges": {
    "zh": "文件有未保存修改",
    "en": "Files have unsaved changes"
  },
  "files.FileConfirm.hasUnsavedChanges": {
    "zh": "{p0} 有未保存的修改",
    "en": "{p0} has unsaved changes"
  },
  "files.FileConfirm.filesHaveUnsavedChanges2": {
    "zh": "{p0} 个文件有未保存的修改",
    "en": "{p0} files have unsaved changes"
  },
  "files.FileConfirm.chooseHowToHandle": {
    "zh": "之前，请选择如何处理这些修改。",
    "en": ": choose how to handle these changes."
  },
  "files.FileConfirm.discardChanges": {
    "zh": "放弃修改",
    "en": "Discard changes"
  },
  "files.FileConfirm.saveDidNotComplete": {
    "zh": "保存未完成，请重试",
    "en": "Save did not complete. Please retry."
  },
  "files.FileConfirm.newEditsWereMade": {
    "zh": "保存期间有新的修改，请再次保存",
    "en": "New edits were made while saving. Save again."
  },
  "files.FileConfirm.quitApplication": {
    "zh": "退出应用",
    "en": "Quit application"
  },
  "files.FileConfirm.saveAll": {
    "zh": "保存全部",
    "en": "Save all"
  },
  "files.FileConfirm.save": {
    "zh": "保存",
    "en": "Save"
  },
  "files.FileTree.files": {
    "zh": "文件",
    "en": "Files"
  },
  "files.FileTree.refreshFilesAndGit": {
    "zh": "刷新文件与 Git 状态",
    "en": "Refresh files and Git status"
  },
  "files.FileTree.filterFilesByName": {
    "zh": "按名称筛选文件",
    "en": "Filter files by name"
  },
  "files.FileTree.filterFilesByName2": {
    "zh": "按名过滤…",
    "en": "Filter by name…"
  },
  "files.FileTree.clearFileFilter": {
    "zh": "清空文件筛选",
    "en": "Clear file filter"
  },
  "files.FileTree.clear": {
    "zh": "清空",
    "en": "Clear"
  },
  "files.FileTree.noProjectYetAdd": {
    "zh": "还没有项目，先在左侧添加项目文件夹",
    "en": "No project yet. Add a project folder in the sidebar."
  },
  "files.FileTree.project": {
    "zh": "{p0}项目 {p1}",
    "en": "{p0} project {p1}"
  },
  "files.FileTree.expand": {
    "zh": "展开",
    "en": "Expand"
  },
  "files.FileTree.filtering": {
    "zh": "筛选中…",
    "en": "Filtering…"
  },
  "files.FileTree.noMatchingFiles": {
    "zh": "没有匹配的文件",
    "en": "No matching files"
  },
  "files.FileTree.showingPartialResultsNarrow": {
    "zh": "只显示部分结果，请缩小筛选范围",
    "en": "Showing partial results. Narrow your filter."
  },
  "files.FileTree.filterByNameSkips": {
    "zh": "按名称筛选，跳过 .git 与 node_modules",
    "en": "Filter by name; skips .git and node_modules"
  },
  "files.FileTree.emptyFolder": {
    "zh": "空文件夹",
    "en": "Empty folder"
  },
  "files.FileTree.largeDirectoryShowingFirst": {
    "zh": "目录过大，显示前 500 项；可按名称筛选",
    "en": "Large directory. Showing the first 500 entries; filter by name to narrow results."
  },
  "files.FileTree.collapseFolder": {
    "zh": "收起文件夹",
    "en": "Collapse folder"
  },
  "files.FileTree.expandFolder": {
    "zh": "展开文件夹",
    "en": "Expand folder"
  },
  "files.FileTree.openFile": {
    "zh": "打开文件",
    "en": "Open file"
  },
  "files.FileTree.link": {
    "zh": "（链接）",
    "en": "(link)"
  },
  "files.FileTree.gitStatus": {
    "zh": "Git 状态 {p0}",
    "en": "Git status {p0}"
  },
  "files.FileTree.copyFilePath": {
    "zh": "复制文件路径 {p0}",
    "en": "Copy file path {p0}"
  },
  "files.FileTree.copyPath": {
    "zh": "复制路径",
    "en": "Copy path"
  },
  "files.FileTree.demoModeCannotCopy": {
    "zh": "演示模式不复制本机路径",
    "en": "Demo mode cannot copy local paths"
  },
  "files.store.demoModeCannotSave": {
    "zh": "演示模式不保存本机文件",
    "en": "Demo mode cannot save local files"
  },
  "panes.drag.splitToLeft": {
    "zh": "移到左侧分屏",
    "en": "Split to the left"
  },
  "panes.drag.splitToRight": {
    "zh": "移到右侧分屏",
    "en": "Split to the right"
  },
  "panes.drag.splitAbove": {
    "zh": "移到上方分屏",
    "en": "Split above"
  },
  "panes.drag.splitBelow": {
    "zh": "移到下方分屏",
    "en": "Split below"
  },
  "panes.drag.moveHere": {
    "zh": "移到这里",
    "en": "Move here"
  },
  "panes.drag.moveIntoThisPane": {
    "zh": "移入这个窗格",
    "en": "Move into this pane"
  },
  "panes.drag.dragToTabBar": {
    "zh": "拖到标签栏或窗格边缘，Esc 取消",
    "en": "Drag to the tab bar or a pane edge. Esc to cancel."
  },
  "panes.drop.conversationOrTargetPane": {
    "zh": "会话或目标窗格已关闭",
    "en": "The conversation or target pane closed"
  },
  "panes.drop.openAnotherConversationBefore": {
    "zh": "先打开另一个对话，再拖到边缘分屏",
    "en": "Open another conversation before splitting at an edge"
  },
  "panes.drop.notEnoughSpaceCollapse": {
    "zh": "空间不足，收起侧边栏或面板后再分屏",
    "en": "Not enough space. Collapse the sidebar or panel before splitting."
  },
  "panes.PaneView.emptyPane": {
    "zh": "空窗格",
    "en": "Empty pane"
  },
  "panes.PaneView.waitingForConfirmation": {
    "zh": "待你确认",
    "en": "Waiting for confirmation"
  },
  "panes.PaneView.newReply": {
    "zh": "有新回复",
    "en": "New reply"
  },
  "panes.PaneView.restorePane": {
    "zh": "还原窗格",
    "en": "Restore pane"
  },
  "panes.PaneView.expandPane": {
    "zh": "放大窗格",
    "en": "Expand pane"
  },
  "panes.PaneView.splitRight": {
    "zh": "向右拆分（",
    "en": "Split right ("
  },
  "panes.PaneView.splitDown": {
    "zh": "向下拆分（",
    "en": "Split down ("
  },
  "panes.PaneView.closePane": {
    "zh": "关闭窗格",
    "en": "Close pane"
  },
  "panes.PaneView.closePaneConversationContinues": {
    "zh": "关闭窗格（会话继续在后台运行）",
    "en": "Close pane (conversation continues in the background)"
  },
  "panes.PaneView.conversationTabsDragTo": {
    "zh": "会话标签（可拖动排序或分屏）",
    "en": "Conversation tabs (drag to reorder or split)"
  },
  "panes.PaneView.newConversationInThis": {
    "zh": "在这个窗格新建会话",
    "en": "New conversation in this pane"
  },
  "panes.PaneView.dragToReorderMove": {
    "zh": "{p0}（拖动排序、移入窗格或拖到边缘分屏；右键查看更多操作）",
    "en": "{p0} (drag to reorder, move between panes, or split at an edge; right-click for more)"
  },
  "panes.PaneView.unsavedChanges": {
    "zh": "未保存修改",
    "en": "Unsaved changes"
  },
  "panes.PaneView.close": {
    "zh": "关闭「{p0}」",
    "en": "Close \"{p0}\""
  },
  "panes.PaneView.moveTabLeft": {
    "zh": "标签向左移动",
    "en": "Move tab left"
  },
  "panes.PaneView.moveTabRight": {
    "zh": "标签向右移动",
    "en": "Move tab right"
  },
  "panes.PaneView.moveToPane": {
    "zh": "移到窗格 {p0}",
    "en": "Move to pane {p0}"
  },
  "panes.PaneView.moveConversationTab": {
    "zh": "移动会话标签",
    "en": "Move conversation tab"
  },
  "panes.PaneView.revealInFileTree": {
    "zh": "在文件树中显示",
    "en": "Reveal in file tree"
  },
  "panes.PaneView.copyFilePath": {
    "zh": "复制文件路径",
    "en": "Copy file path"
  },
  "panes.PaneView.openWithExternalEditor": {
    "zh": "用外部编辑器打开",
    "en": "Open with external editor"
  },
  "panes.PaneView.openConversationFromSidebar": {
    "zh": "点左侧的会话打开到这里，或新建任务",
    "en": "Open a conversation from the sidebar, or create a new task"
  },
  "panes.PaneView.splitRight2": {
    "zh": "向右拆分 ·",
    "en": "Split right ·"
  },
  "panes.PaneView.splitDown2": {
    "zh": "向下拆分",
    "en": "Split down"
  },
  "panes.store.moveTab": {
    "zh": "移动标签",
    "en": "Move tab"
  },
  "panes.store.closedRunning": {
    "zh": "{p0} 个对话还在后台运行，可以在侧栏里打开",
    "en": "{p0} conversations are still running in the background; open them from the sidebar"
  },
  "panes.PaneView.moveTo": {
    "zh": "移动到…",
    "en": "Move to…"
  },
  "panes.PaneView.closeOtherTabs": {
    "zh": "关闭其他标签页",
    "en": "Close other tabs"
  },
  "panes.PaneView.closeTabsToRight": {
    "zh": "关闭右侧标签页",
    "en": "Close tabs to the right"
  },
  "panes.PaneView.closeAllTabs": {
    "zh": "关闭所有标签页",
    "en": "Close all tabs"
  },
  "panes.PaneView.closeInactiveTabs": {
    "zh": "关闭不活跃的标签页",
    "en": "Close inactive tabs"
  },
  "panes.PaneView.closeInactiveHint": {
    "zh": "留下正在运行、等你确认、有新回复的对话，没保存的文件，和当前标签",
    "en": "Keeps running, waiting and unread conversations, unsaved files and the current tab"
  },
  "panes.store.notEnoughSpaceFor": {
    "zh": "窗口放不下更多窗格了，关掉一个，或收起侧边栏腾出位置",
    "en": "Not enough space for more panes. Close a pane or collapse the sidebar."
  },
  "panes.Workspace.dragToResizePanes": {
    "zh": "拖动调整窗格大小，拖到头放大另一边，双击均分",
    "en": "Drag to resize panes, drag all the way to maximize the other pane, double-click to distribute evenly"
  },
  "panes.Workspace.releaseToMaximize": {
    "zh": "松开放大这个窗格",
    "en": "Release to maximize this pane"
  },
  "search.ProjectFilter.filterProjects": {
    "zh": "筛选项目：{p0}",
    "en": "Filter projects: {p0}"
  },
  "search.ProjectFilter.projectFilterOptions": {
    "zh": "项目筛选选项",
    "en": "Project filter options"
  },
  "search.SearchDialog.allContent": {
    "zh": "全部内容",
    "en": "All content"
  },
  "search.SearchDialog.conversationTitles": {
    "zh": "会话标题",
    "en": "Conversation titles"
  },
  "search.SearchDialog.messages": {
    "zh": "对话内容",
    "en": "Messages"
  },
  "search.SearchDialog.toolContent": {
    "zh": "工具内容",
    "en": "Tool content"
  },
  "search.SearchDialog.projectFiles": {
    "zh": "项目文件",
    "en": "Project files"
  },
  "search.SearchDialog.fileName": {
    "zh": "文件名",
    "en": "File name"
  },
  "search.SearchDialog.fileLine": {
    "zh": "第 {line} 行",
    "en": "Line {line}"
  },
  "search.SearchDialog.openAProjectFirst": {
    "zh": "先在窗格里打开一个项目，或在右上角选择项目，再搜索文件",
    "en": "Open a project in the pane, or pick one at the top right, to search its files"
  },
  "search.SearchDialog.typeToSearchFiles": {
    "zh": "输入文件名或文件里的文字",
    "en": "Type a file name or text inside files"
  },
  "search.SearchDialog.fileResultsPartial": {
    "zh": "文件太多，只显示了一部分结果，请输入更具体的内容",
    "en": "Too many files; showing partial results. Try a more specific search"
  },
  "search.SearchDialog.localConversationSearchIs": {
    "zh": "本机会话搜索暂不可用",
    "en": "Local conversation search is unavailable"
  },
  "search.SearchDialog.searchConversationsAndContent": {
    "zh": "搜索会话与内容",
    "en": "Search conversations and content"
  },
  "search.SearchDialog.closeSearchEsc": {
    "zh": "关闭搜索（Esc）",
    "en": "Close search (Esc)"
  },
  "search.SearchDialog.searchTitlesMessagesCommands": {
    "zh": "搜索标题、消息、命令或路径…",
    "en": "Search titles, messages, commands or paths…"
  },
  "search.SearchDialog.searchTerms": {
    "zh": "搜索关键词",
    "en": "Search terms"
  },
  "search.SearchDialog.searchScope": {
    "zh": "搜索范围",
    "en": "Search scope"
  },
  "search.SearchDialog.searchResults": {
    "zh": "搜索结果",
    "en": "Search results"
  },
  "search.SearchDialog.searching": {
    "zh": "正在搜索…",
    "en": "Searching…"
  },
  "search.SearchDialog.noConversationsYetStart": {
    "zh": "还没有会话，开始一个任务后就可以搜索",
    "en": "No conversations yet. Start a task to enable search."
  },
  "search.SearchDialog.noMatchingContentTry": {
    "zh": "没有找到匹配内容，试试其他关键词",
    "en": "No matching content. Try different search terms."
  },
  "search.SearchDialog.noConversationsInThis": {
    "zh": "这个项目还没有会话",
    "en": "No conversations in this project yet"
  },
  "search.SearchDialog.someConversationRecordsCould": {
    "zh": "部分会话记录未能读取",
    "en": "Some conversation records could not be read"
  },
  "search.SearchDialog.tooManyResultsNarrow": {
    "zh": "结果较多，请缩小关键词或选择项目",
    "en": "Too many results. Narrow your search or choose a project."
  },
  "search.SearchDialog.localSearch": {
    "zh": "本机搜索",
    "en": "Local search"
  },
  "search.SearchDialog.recentConversations": {
    "zh": "最近会话",
    "en": "Recent conversations"
  },
  "search.SearchDialog.select": {
    "zh": "↑↓ 选择",
    "en": "↑↓ Select"
  },
  "search.SearchDialog.expandHint": {
    "zh": "→ 展开",
    "en": "→ Expand"
  },
  "search.SearchDialog.moreMatches": {
    "zh": "另有 {n} 处",
    "en": "{n} more"
  },
  "search.SearchDialog.showMatches": {
    "zh": "展开这个会话的其它命中",
    "en": "Show other matches in this conversation"
  },
  "search.SearchDialog.hideMatches": {
    "zh": "收起这个会话的其它命中",
    "en": "Hide other matches in this conversation"
  },
  "search.SearchDialog.unlistedMatches": {
    "zh": "还有 {n} 处没列出，打开会话后按 Ctrl+F 查找",
    "en": "{n} more not listed. Open the conversation and press Ctrl+F to find them."
  },
  "search.SearchDialog.enterOpen": {
    "zh": "Enter 打开",
    "en": "Enter Open"
  },
  "search.SearchDialog.escClose": {
    "zh": "Esc 关闭",
    "en": "Esc Close"
  },
  "search.SearchProvider.searchMustBeUsed": {
    "zh": "搜索入口必须位于 SearchProvider 内",
    "en": "Search must be used within SearchProvider"
  },
  "search.useItemLocation.thisContentNoLonger": {
    "zh": "这条内容已不存在，或尚未能定位",
    "en": "This content no longer exists or cannot be located yet"
  },
  "settings.AboutSection.developmentMode": {
    "zh": "开发模式",
    "en": "Development mode"
  },
  "settings.AboutSection.portable": {
    "zh": "便携版",
    "en": "Portable"
  },
  "settings.AboutSection.installed": {
    "zh": "安装版",
    "en": "Installed"
  },
  "settings.AboutSection.applicationInformationIsUnavailable": {
    "zh": "当前环境拿不到应用信息",
    "en": "Application information is unavailable in this environment"
  },
  "settings.AboutSection.copyFailedSelectAnd": {
    "zh": "复制失败，请手动选择文字复制",
    "en": "Copy failed. Select and copy the text manually."
  },
  "settings.AboutSection.signedIn": {
    "zh": "已登录 · {p0}",
    "en": "Signed in · {p0}"
  },
  "settings.AboutSection.version": {
    "zh": "版本 {p0} · {p1}",
    "en": "Version {p0} · {p1}"
  },
  "settings.AboutSection.version2": {
    "zh": "版本 —",
    "en": "Version —"
  },
  "settings.AboutSection.checkForUpdates": {
    "zh": "检查更新",
    "en": "Check for updates"
  },
  "settings.AboutSection.copyVersionInformation": {
    "zh": "复制版本信息",
    "en": "Copy version information"
  },
  "settings.AboutSection.runtimeEnvironment": {
    "zh": "运行环境",
    "en": "Runtime environment"
  },
  "settings.AboutSection.applicationVersion": {
    "zh": "应用版本",
    "en": "Version"
  },
  "settings.AboutSection.system": {
    "zh": "系统",
    "en": "System"
  },
  "settings.AboutSection.accountAndData": {
    "zh": "账号与数据",
    "en": "Account and data"
  },
  "settings.AboutSection.account": {
    "zh": "账号",
    "en": "Account"
  },
  "settings.AboutSection.manage": {
    "zh": "管理",
    "en": "Manage"
  },
  "settings.AboutSection.authenticationService": {
    "zh": "认证服务",
    "en": "Sign-in service"
  },
  "settings.AboutSection.openAuthenticationServiceIn": {
    "zh": "在浏览器中打开认证服务",
    "en": "Open authentication service in browser"
  },
  "settings.AboutSection.dataDirectory": {
    "zh": "数据目录",
    "en": "Data folder"
  },
  "settings.AboutSection.openDataDirectory": {
    "zh": "打开数据目录",
    "en": "Open data directory"
  },
  "settings.AboutSection.links": {
    "zh": "链接",
    "en": "Links"
  },
  "settings.AboutSection.sourceRepository": {
    "zh": "代码仓库",
    "en": "Source code"
  },
  "settings.AboutSection.openSourceRepositoryIn": {
    "zh": "在浏览器中打开代码仓库",
    "en": "Open source repository in browser"
  },
  "settings.AboutSection.builtWith": {
    "zh": "基于",
    "en": "Built with"
  },
  "settings.AboutSection.andOtherOpenSource": {
    "zh": "等开源项目构建。",
    "en": "and other open-source projects."
  },
  "settings.AboutSection.authenticationService2": {
    "zh": "认证服务 {p0}",
    "en": "Authentication service {p0}"
  },
  "settings.account.AccountOverview.groups": {
    "zh": "分组",
    "en": "Groups"
  },
  "settings.account.AccountOverview.manageRoutesInModels": {
    "zh": "在「模型与额度」里管理线路",
    "en": "Manage routes in Models & credits"
  },
  "settings.account.AccountOverview.addCredits": {
    "zh": "充值",
    "en": "Add credits"
  },
  "settings.account.AccountOverview.currentPlan": {
    "zh": "当前套餐",
    "en": "Current plan"
  },
  "settings.account.AccountOverview.changePlan": {
    "zh": "更换套餐",
    "en": "Change plan"
  },
  "settings.account.AccountOverview.noSubscription": {
    "zh": "未订阅",
    "en": "No subscription"
  },
  "settings.account.AccountOverview.subscriptionsIncludeDailyAnd": {
    "zh": "订阅套餐后每天、每月有固定额度，用完再从余额扣除。",
    "en": "Subscriptions include daily and monthly credits. Additional usage is charged to your balance."
  },
  "settings.account.AccountOverview.viewPlans": {
    "zh": "查看套餐",
    "en": "View plans"
  },
  "settings.account.AccountOverview.refreshBalanceAndCredits": {
    "zh": "刷新余额和额度",
    "en": "Refresh balance and credits"
  },
  "settings.account.AccountOverview.updating": {
    "zh": "更新中…",
    "en": "Updating…"
  },
  "settings.account.AccountSection.overview": {
    "zh": "概览",
    "en": "Overview"
  },
  "settings.account.AccountSection.subscriptionPlans": {
    "zh": "订阅套餐",
    "en": "Subscription plans"
  },
  "settings.account.AccountSection.accountPage": {
    "zh": "账号页面",
    "en": "Account page"
  },
  "settings.account.AccountSection.signInToPixel": {
    "zh": "登录像素星空账号后，可以使用账号下的模型，查看余额和额度，购买订阅或充值。",
    "en": "Sign in to Pixel Starry Sky to use your models, view balance and credits, subscribe or add credits."
  },
  "settings.account.AccountSection.accountServices": {
    "zh": "账号服务",
    "en": "Account services"
  },
  "settings.account.AccountSection.manageInBrowser": {
    "zh": "在浏览器中管理",
    "en": "Manage in browser"
  },
  "settings.account.PlanStore.month": {
    "zh": "月",
    "en": "month"
  },
  "settings.account.PlanStore.quarter": {
    "zh": "季",
    "en": "quarter"
  },
  "settings.account.PlanStore.year": {
    "zh": "年",
    "en": "year"
  },
  "settings.account.PlanStore.daily": {
    "zh": "每日",
    "en": "Daily"
  },
  "settings.account.PlanStore.weekly": {
    "zh": "每周",
    "en": "Weekly"
  },
  "settings.account.PlanStore.monthly": {
    "zh": "每月",
    "en": "Monthly"
  },
  "settings.account.PlanStore.plansWillAppearHere": {
    "zh": "套餐上架后会显示在这里。",
    "en": "Plans will appear here when published."
  },
  "settings.account.PlanStore.renew": {
    "zh": "续费",
    "en": "Renew"
  },
  "settings.account.PlanStore.current": {
    "zh": "当前",
    "en": "Current"
  },
  "settings.account.PlanStore.credits": {
    "zh": "额度",
    "en": "Credits"
  },
  "settings.account.TopUp.enterAmountWithUp": {
    "zh": "请输入金额，最多两位小数",
    "en": "Enter an amount with up to two decimal places"
  },
  "settings.account.TopUp.custom": {
    "zh": "自定义",
    "en": "Custom"
  },
  "settings.account.TopUp.anyAmount": {
    "zh": "任意金额",
    "en": "Any amount"
  },
  "settings.account.TopUp.range": {
    "zh": "范围 {p0} – {p1}",
    "en": "Range: {p0} – {p1}"
  },
  "settings.account.TopUp.paymentMethod": {
    "zh": "支付方式",
    "en": "Payment method"
  },
  "settings.account.TopUp.creditsReceived": {
    "zh": "到账额度",
    "en": "Credits received"
  },
  "settings.account.TopUp.includingBonusAmount": {
    "zh": "（含赠送 {p0}）",
    "en": "(incl. {p0} bonus)"
  },
  "settings.account.TopUp.amountDue": {
    "zh": "预计应付",
    "en": "Estimated amount due"
  },
  "settings.account.TopUp.pay": {
    "zh": "去支付",
    "en": "Pay"
  },
  "settings.account.PlanStore.fiveHour": {
    "zh": "5 小时",
    "en": "5-hour"
  },
  "settings.account.PlanStore.days": {
    "zh": "{p0} 天",
    "en": "{p0} days"
  },
  "settings.account.PlanStore.oneDay": {
    "zh": "1 天",
    "en": "1 day"
  },
  "settings.account.PlanStore.purchase": {
    "zh": "购买",
    "en": "Buy"
  },
  "settings.account.PlanStore.group": {
    "zh": "分组",
    "en": "Group"
  },
  "settings.account.PlanStore.noPlansOnPanel": {
    "zh": "Sub2api 还没有上架套餐",
    "en": "Sub2api has no plans on sale yet"
  },
  "settings.account.Store.loading": {
    "zh": "正在读取套餐和充值信息…",
    "en": "Loading plans and top-up info…"
  },
  "settings.account.Store.loadFailed": {
    "zh": "读取套餐和充值信息失败",
    "en": "Could not load plans and top-up info"
  },
  "settings.account.Store.retry": {
    "zh": "重试",
    "en": "Retry"
  },
  "settings.account.Store.staleHint": {
    "zh": "刷新失败，显示的是上次读到的内容。",
    "en": "Refresh failed. Showing the last loaded data."
  },
  "settings.account.Store.openPanel": {
    "zh": "打开网页面板",
    "en": "Open web panel"
  },
  "settings.account.Store.openFailed": {
    "zh": "无法打开面板页",
    "en": "Could not open the panel page"
  },
  "settings.account.Store.opening": {
    "zh": "正在打开支付页…",
    "en": "Opening the payment page…"
  },
  "settings.account.Store.paidHint": {
    "zh": "在浏览器里完成付款后回到这里",
    "en": "Finish paying in the browser, then come back here"
  },
  "settings.account.Store.paidRefresh": {
    "zh": "我已付款，刷新",
    "en": "I have paid, refresh"
  },
  "settings.account.Store.accountCheck": {
    "zh": "请确认浏览器里面板登录的是 {p0}",
    "en": "Make sure the panel in your browser is signed in as {p0}"
  },
  "settings.account.Store.accountCheckHint": {
    "zh": "付款到账的是面板里登录的账号；如果浏览器登录的是别的账号，钱会进到别人的号上。",
    "en": "Payments go to the account signed in on the panel. If the browser is signed in as someone else, the money goes to that account."
  },
  "settings.account.Store.balanceNow": {
    "zh": "当前余额 {p0}",
    "en": "Balance {p0}"
  },
  "settings.account.Store.planNow": {
    "zh": "套餐 {p0}",
    "en": "Plan {p0}"
  },
  "settings.account.Store.planNone": {
    "zh": "暂无套餐",
    "en": "No plan"
  },
  "settings.account.Store.planExpires": {
    "zh": "到期 {p0}",
    "en": "expires {p0}"
  },
  "settings.account.Store.watching": {
    "zh": "付款后会自动检查到账（2 分钟内每 15 秒一次）。",
    "en": "After payment, arrival is checked automatically (every 15 seconds for 2 minutes)."
  },
  "settings.account.Store.arrived": {
    "zh": "已到账",
    "en": "Payment received"
  },
  "settings.account.Store.balanceChange": {
    "zh": "余额 {p0} → {p1}",
    "en": "Balance {p0} → {p1}"
  },
  "settings.account.Store.planChange": {
    "zh": "套餐 {p0} → {p1}",
    "en": "Plan {p0} → {p1}"
  },
  "settings.account.Store.expiresChange": {
    "zh": "到期时间 {p0} → {p1}",
    "en": "Expiry {p0} → {p1}"
  },
  "settings.account.Store.noValue": {
    "zh": "无",
    "en": "none"
  },
  "settings.account.Store.notArrived": {
    "zh": "暂未到账：可能有几秒延迟；如果一直没到，请到面板确认登录的账号和订单",
    "en": "Not received yet: it can take a few seconds. If it never arrives, check the signed-in account and the order on the panel"
  },
  "settings.account.Store.refreshFailed": {
    "zh": "刷新失败：{p0}",
    "en": "Refresh failed: {p0}"
  },
  "settings.account.Store.demoNoOpen": {
    "zh": "演示模式不会打开支付页",
    "en": "Demo mode does not open the payment page"
  },
  "settings.account.TopUp.reenterAmount": {
    "zh": "需在面板里重新输入金额",
    "en": "Enter the amount again in the panel"
  },
  "settings.account.TopUp.copyAmount": {
    "zh": "复制金额",
    "en": "Copy amount"
  },
  "settings.account.TopUp.amountCopied": {
    "zh": "已复制",
    "en": "Copied"
  },
  "settings.account.TopUp.currencyUnsure": {
    "zh": "支付币种无法确认，请以面板显示的金额为准",
    "en": "The payment currency cannot be confirmed. Use the amount shown on the panel"
  },
  "settings.account.TopUp.rechargeClosed": {
    "zh": "Sub2api 没有开放在线充值",
    "en": "Sub2api has not opened online top-up"
  },
  "settings.account.TopUp.rechargeClosedHint": {
    "zh": "可以在网页面板里查看，或用兑换码充值。",
    "en": "Check the web panel, or top up with a redeem code."
  },
  "settings.account.TopUp.redeemCode": {
    "zh": "使用兑换码",
    "en": "Use a redeem code"
  },
  "settings.account.TopUp.payAmount": {
    "zh": "充值金额（支付）",
    "en": "Top-up amount (to pay)"
  },
  "settings.account.TopUp.minAmount": {
    "zh": "最低 {p0}",
    "en": "Minimum {p0}"
  },
  "settings.account.TopUp.maxAmount": {
    "zh": "最高 {p0}",
    "en": "Maximum {p0}"
  },
  "settings.account.TopUp.multiplier": {
    "zh": "每付 {p0} 到账 {p1} 额度",
    "en": "Every {p0} paid credits {p1}"
  },
  "settings.account.TopUp.bonusRules": {
    "zh": "赠送规则",
    "en": "Bonus rules"
  },
  "settings.account.TopUp.discountRules": {
    "zh": "折扣规则",
    "en": "Discount rules"
  },
  "settings.account.TopUp.bonusTier": {
    "zh": "单笔满 {p0}，多送 {p1}% 额度",
    "en": "Pay {p0} or more: {p1}% extra credits"
  },
  "settings.account.TopUp.discountTier": {
    "zh": "单笔满 {p0}，实付立减 {p1}%",
    "en": "Pay {p0} or more: {p1}% off"
  },
  "settings.account.TopUp.chooseInBrowser": {
    "zh": "支付方式和金额在浏览器里的面板中确认。",
    "en": "Confirm the payment method and amount in the browser panel."
  },
  "settings.account.TopUp.includingFee": {
    "zh": "（含手续费 {p0}）",
    "en": "(incl. {p0} fee)"
  },
  "settings.CacheMissSettings.cacheMissAlerts": {
    "zh": "缓存未命中提醒",
    "en": "Cache miss alerts"
  },
  "settings.CacheMissSettings.getAlertWhenConsecutive": {
    "zh": "连续请求的缓存命中明显降低时提醒，可在 5 秒内停止本轮；不操作则继续运行。",
    "en": "Get an alert when consecutive requests show a significant drop in cache hits. Stop this turn within 5 seconds, or let it continue."
  },
  "settings.CacheMissSettings.noAlertsOnFirst": {
    "zh": "首次请求、模型或线路切换、上下文压缩及长时间停顿后不提醒。提醒出现时，请求已经开始。",
    "en": "No alerts on first requests, model or route changes, compaction, or long pauses. The request has already started when the alert appears."
  },
  "settings.PaletteSettings.palette": {
    "zh": "配色主题",
    "en": "Color theme"
  },
  "settings.PaletteSettings.description": {
    "zh": "整套界面颜色：底色、边框、文字和主色。每套都有浅色和深色，跟上面的主题一起切换；代码高亮和终端的 16 色不变。",
    "en": "A full set of interface colors: backgrounds, borders, text and accent. Each has a light and a dark version that follows the theme above; code highlighting and the terminal's 16 colors stay the same."
  },
  "settings.PaletteSettings.choosePalette": {
    "zh": "选择配色主题：{p0}",
    "en": "Choose color theme: {p0}"
  },
  "settings.PaletteSettings.default": {
    "zh": "暖灰（默认）",
    "en": "Warm gray (default)"
  },
  "settings.AccentSettings.accent": {
    "zh": "强调色",
    "en": "Accent color"
  },
  "settings.AccentSettings.description": {
    "zh": "按钮、选中项、链接和进度条用的主色。「跟随配色」用配色主题自带的主色（默认配色是墨绿）。",
    "en": "The main color for buttons, selections, links and progress bars. Match palette uses the color theme's own accent (green for the default palette)."
  },
  "settings.AccentSettings.chooseAccent": {
    "zh": "选择强调色：{p0}",
    "en": "Choose accent color: {p0}"
  },
  "settings.AccentSettings.theme": {
    "zh": "跟随配色",
    "en": "Match palette"
  },
  "settings.AccentSettings.blue": {
    "zh": "海蓝",
    "en": "Blue"
  },
  "settings.AccentSettings.violet": {
    "zh": "靛紫",
    "en": "Violet"
  },
  "settings.AccentSettings.teal": {
    "zh": "青碧",
    "en": "Teal"
  },
  "settings.AccentSettings.amber": {
    "zh": "琥珀",
    "en": "Amber"
  },
  "settings.AccentSettings.rose": {
    "zh": "玫红",
    "en": "Rose"
  },
  "settings.AccentSettings.graphite": {
    "zh": "石墨",
    "en": "Graphite"
  },
  "settings.ComposerStyleSettings.composerStyle": {
    "zh": "对话框风格",
    "en": "Composer style"
  },
  "settings.ComposerStyleSettings.chatgptPlacesToolsInside": {
    "zh": "ChatGPT 将工具放在输入框内；Claude 将设置工具放在框外。两种风格都保留上下文窗口功能。",
    "en": "ChatGPT places tools inside the composer; Claude places settings outside. Both styles include context window tools."
  },
  "settings.ComposerStyleSettings.chooseComposerStyle": {
    "zh": "选择 {p0} 对话框风格",
    "en": "Choose {p0} composer style"
  },
  "settings.ComposerStyleSettings.typeMessage": {
    "zh": "输入内容…",
    "en": "Type a message…"
  },
  "settings.ComposerStyleSettings.toolsAndSendButton": {
    "zh": "工具与发送按钮在框内",
    "en": "Tools and send button inside"
  },
  "settings.ComposerStyleSettings.settingsOutsideSendButton": {
    "zh": "设置工具在框外，发送按钮在框内",
    "en": "Settings outside, send button inside"
  },
  "settings.ComposerStyleSettings.effort": {
    "zh": "强度",
    "en": "Effort"
  },
  "settings.editor.EditorSection.customEditor": {
    "zh": "自定义编辑器",
    "en": "Custom editor"
  },
  "settings.editor.EditorSection.demoModeCannotChange": {
    "zh": "演示模式不更改本机编辑器设置",
    "en": "Demo mode cannot change local editor settings"
  },
  "settings.editor.EditorSection.editor": {
    "zh": "编辑器",
    "en": "Editor"
  },
  "settings.editor.EditorSection.viewAndEditFiles": {
    "zh": "文件可在像素星空内查看和编辑，也可以使用本机编辑器。",
    "en": "View and edit files in Pixel Starry Sky, or use a local editor."
  },
  "settings.editor.EditorSection.defaultOpeningMethod": {
    "zh": "默认打开方式",
    "en": "Default opening method"
  },
  "settings.editor.EditorSection.toolbarOpensBuiltIn": {
    "zh": "顶栏主按钮默认打开软件内文件树，文件在工作区中编辑；也可以选择本机编辑器。",
    "en": "The toolbar opens the built-in file tree by default, with files edited in the workspace. You can also choose a local editor."
  },
  "settings.editor.EditorSection.defaultExternalEditor": {
    "zh": "默认外部编辑器",
    "en": "Default external editor"
  },
  "settings.editor.EditorSection.editorToolbarsExternalEditor": {
    "zh": "编辑器工具栏的「用外部编辑器打开」使用此选择，不改变顶栏的默认打开方式。",
    "en": "The editor toolbar's external editor button uses this choice without changing the main toolbar default."
  },
  "settings.editor.EditorSection.noEditorDetectedChoose": {
    "zh": "未检测到编辑器，可在下方选择程序路径",
    "en": "No editor detected. Choose an executable path below."
  },
  "settings.editor.EditorSection.windowMode": {
    "zh": "打开窗口",
    "en": "Window mode"
  },
  "settings.editor.EditorSection.vsCodeCompatibleEditors": {
    "zh": "VS Code 兼容编辑器支持复用窗口；普通自定义程序按自身方式打开。",
    "en": "VS Code-compatible editors support window reuse. Other programs use their own behavior."
  },
  "settings.editor.EditorSection.editorWindowMode": {
    "zh": "编辑器窗口方式",
    "en": "Editor window mode"
  },
  "settings.editor.EditorSection.reuseWindow": {
    "zh": "复用窗口",
    "en": "Reuse window"
  },
  "settings.editor.EditorSection.newWindow": {
    "zh": "新窗口",
    "en": "New window"
  },
  "settings.editor.EditorSection.localEditors": {
    "zh": "本机编辑器",
    "en": "Local editors"
  },
  "settings.editor.EditorSection.available": {
    "zh": "可用",
    "en": "Available"
  },
  "settings.editor.EditorSection.invalidPath": {
    "zh": "路径失效",
    "en": "Invalid path"
  },
  "settings.editor.EditorSection.removeConfiguration": {
    "zh": "移除配置",
    "en": "Remove configuration"
  },
  "settings.editor.EditorSection.restoreAutomaticDetection": {
    "zh": "恢复自动检测",
    "en": "Restore automatic detection"
  },
  "settings.editor.EditorSection.detectedAt": {
    "zh": "检测于",
    "en": "Detected at"
  },
  "settings.editor.EditorSection.executablePath": {
    "zh": "指定程序路径",
    "en": "Executable path"
  },
  "settings.editor.EditorSection.choose": {
    "zh": "选择",
    "en": "Choose"
  },
  "settings.editor.EditorSection.executable": {
    "zh": "程序…",
    "en": "executable…"
  },
  "settings.editor.EditorSection.name": {
    "zh": "名称",
    "en": "Name"
  },
  "settings.editor.EditorSection.customEditorName": {
    "zh": "自定义编辑器名称",
    "en": "Custom editor name"
  },
  "settings.editor.EditorSection.customEditorOpeningMethod": {
    "zh": "自定义编辑器打开方式",
    "en": "Custom editor opening method"
  },
  "settings.editor.EditorSection.folderArgument": {
    "zh": "普通文件夹参数",
    "en": "Folder argument"
  },
  "settings.editor.EditorSection.jetbrainsHint": {
    "zh": "JetBrains IDE 选 bin 里的启动程序（idea64.exe、pycharm64.exe 这类，macOS 选 .app）。打开文件时会跳到所在行。",
    "en": "For a JetBrains IDE, choose the launcher in its bin folder (idea64.exe, pycharm64.exe and the like; the .app on macOS). Files open at their line."
  },
  "settings.editor.EditorSection.vsCodeCompatible": {
    "zh": "VS Code 兼容",
    "en": "VS Code compatible"
  },
  "settings.editor.EditorSection.chooseExecutableAndAdd": {
    "zh": "选择程序并添加…",
    "en": "Choose executable and add…"
  },
  "settings.engines.EngineDetail.allEngines": {
    "zh": "全部引擎",
    "en": "All engines"
  },
  "settings.engines.EngineDetail.changesTakeEffectImmediately": {
    "zh": "改了立刻生效。除「新会话默认值」外，对已经开始的会话也生效：下一条消息开始前会用新设置重启 {p0}，对话会接上。",
    "en": "Changes take effect immediately. Except for new conversation defaults, they also apply to existing conversations: {p0} restarts with the new settings before your next message and resumes the conversation."
  },
  "settings.engines.EngineDetail.newConversationDefaults": {
    "zh": "新会话默认值",
    "en": "New conversation defaults"
  },
  "settings.engines.EngineDetail.appliesToNewConversations": {
    "zh": "对之后新建的会话生效；已开始的会话在输入框里单独改。会话里改过的选择也会记到这里。",
    "en": "Applies to new conversations. Change existing conversations in the composer; those selections are also saved here."
  },
  "settings.engines.EngineDetail.higherEffortSpendsMore": {
    "zh": "越高想得越久，用量也越大。",
    "en": "Higher effort spends more time thinking and uses more credits."
  },
  "settings.engines.EngineDetail.defaultReasoningEffort": {
    "zh": "默认推理强度",
    "en": "Default reasoning effort"
  },
  "settings.engines.EngineDetail.default": {
    "zh": "{p0} 默认",
    "en": "{p0} default"
  },
  "settings.engines.EngineDetail.permissions": {
    "zh": "权限",
    "en": "Permissions"
  },
  "settings.engines.EngineDetail.defaultPermissions": {
    "zh": "默认权限",
    "en": "Default permissions"
  },
  "settings.engines.EngineDetail.defaultModelsForPlatform": {
    "zh": "平台额度和自有额度的默认模型都在「模型与额度」里选。",
    "en": "Default models for platform and own-account credits are set in Models & credits."
  },
  "settings.engines.EngineDetail.manageModels": {
    "zh": "管理模型 →",
    "en": "Manage models →"
  },
  "settings.engines.EngineDetail.fasterRepliesWithHigher": {
    "zh": "回复更快，用量也更大。",
    "en": "Faster replies with higher usage."
  },
  "settings.engines.EngineDetail.enableFastModeBy": {
    "zh": "默认开启 Fast 模式",
    "en": "Enable Fast mode by default"
  },
  "settings.engines.EngineDetail.orchestrateMultipleSubagentsFor": {
    "zh": "每个任务都编排多个子智能体分头完成，更彻底，用量也更大。",
    "en": "Orchestrate multiple subagents for each task. More thorough, with higher usage."
  },
  "settings.engines.EngineDetail.enableUltracodeByDefault": {
    "zh": "默认开启 Ultracode",
    "en": "Enable Ultracode by default"
  },
  "settings.engines.EngineDetail.showThinking": {
    "zh": "显示思考过程",
    "en": "Show thinking"
  },
  "settings.engines.EngineDetail.onRequestAndShow": {
    "zh": "开：请求并显示思考摘要（计入输出 token）；关：不请求也不显示。",
    "en": "On: request and show thinking summaries (counted as output tokens). Off: do not request or show them."
  },
  "settings.engines.EngineDetail.showThinkingByDefault": {
    "zh": "默认显示思考过程",
    "en": "Show thinking by default"
  },
  "settings.engines.EngineDetail.conversation": {
    "zh": "对话",
    "en": "Conversation"
  },
  "settings.engines.EngineDetail.allowQuestionsDuringTasks": {
    "zh": "允许中途向我提问",
    "en": "Allow questions during tasks"
  },
  "settings.engines.EngineDetail.onPauseToAsk": {
    "zh": "开：遇到该你定的选择会停下来问你；关：自己拿主意，并在回复里说明做了哪些假设。",
    "en": "On: pause to ask when you need to decide. Off: make decisions and explain assumptions in the reply."
  },
  "settings.engines.EngineDetail.autocompactThreshold": {
    "zh": "自动压缩触发点",
    "en": "Autocompact threshold"
  },
  "settings.engines.EngineDetail.automaticallyCompactAtThis": {
    "zh": "上下文用到窗口的这个比例时自动压缩，越低压缩越早、越省用量，但较早的细节丢得也越多。默认由引擎按模型决定。",
    "en": "Automatically compact at this percentage of the context window. Lower values reduce usage but lose earlier details sooner. The default depends on the engine and model."
  },
  "settings.engines.EngineDetail.defaultBuiltInThreshold": {
    "zh": "默认（内置阈值）",
    "en": "Default (built-in threshold)"
  },
  "settings.engines.EngineDetail.atUsage": {
    "zh": "用到 {p0}% 时",
    "en": "At {p0}% usage"
  },
  "settings.engines.EngineDetail.advanced": {
    "zh": "高级",
    "en": "Advanced"
  },
  "settings.engines.EngineDetail.showInEngineMenu": {
    "zh": "在引擎菜单中显示",
    "en": "Show in engine menu"
  },
  "settings.engines.EngineDetail.hideThisEngineFrom": {
    "zh": "关掉后输入框的引擎菜单里不再列出它；已经在用它的会话不受影响。",
    "en": "Hide this engine from the composer menu. Existing conversations using it are unaffected."
  },
  "settings.engines.EngineDetail.defaultEngineCannotBe": {
    "zh": "默认引擎不能隐藏，先把别的引擎设为默认。",
    "en": "The default engine cannot be hidden. Set another engine as default first."
  },
  "settings.engines.engineUpdate.newVersion": {
    "zh": "有新版本 {p0}",
    "en": "Update {p0}"
  },
  "settings.engines.engineUpdate.newVersionAvailable": {
    "zh": "有新版本 {p0}（当前 {p1}），点「更新」就会自动下载安装，不用自己输命令。",
    "en": "Version {p0} is available (you have {p1}). Click Update to download and install it — no commands needed."
  },
  "settings.engines.engineUpdate.update": {
    "zh": "更新",
    "en": "Update"
  },
  "settings.engines.engineUpdate.updateTo": {
    "zh": "更新到 {p0}",
    "en": "Update to {p0}"
  },
  "settings.engines.engineUpdate.updating": {
    "zh": "正在更新，可能要一两分钟…",
    "en": "Updating, this may take a minute or two…"
  },
  "settings.engines.engineUpdate.updatingShort": {
    "zh": "更新中",
    "en": "Updating"
  },
  "settings.engines.engineUpdate.runningNpmUpdate": {
    "zh": "正在用 npm 更新 Codex，可能要一两分钟；空闲的 Codex 会话已先关掉进程，发下一条消息时会接上原对话…",
    "en": "Updating Codex with npm. This may take a minute or two; idle Codex sessions were stopped first and resume with your next message…"
  },
  "settings.engines.EngineDetail.demoModeCannotUpdate": {
    "zh": "演示模式不更新本机程序",
    "en": "Demo mode cannot update local programs"
  },
  "settings.engines.EngineDetail.executableNotDetected": {
    "zh": "未检测到程序",
    "en": "Executable not detected"
  },
  "settings.engines.EngineDetail.detecting": {
    "zh": "检测中…",
    "en": "Detecting…"
  },
  "settings.engines.EngineDetail.checkingForUpdates": {
    "zh": "正在检查更新…",
    "en": "Checking for updates…"
  },
  "settings.engines.EngineDetail.runningClaudeUpdateThis": {
    "zh": "正在运行 claude update，可能要一两分钟，期间不影响正在进行的对话…",
    "en": "Running claude update. This may take a minute or two. Existing conversations continue normally…"
  },
  "settings.engines.EngineDetail.updateDidNotComplete": {
    "zh": "更新没有完成",
    "en": "Update did not complete"
  },
  "settings.engines.EngineDetail.updatedToPreviously": {
    "zh": "已更新到 {p0}（原来是 {p1}）",
    "en": "Updated to {p0} (previously {p1})"
  },
  "settings.engines.EngineDetail.alreadyUpToDate": {
    "zh": "已是最新版本{p0}",
    "en": "Already up to date{p0}"
  },
  "settings.engines.EngineDetail.newConversationsUseUpdated": {
    "zh": "新开的会话用新版本；已经开始的会话下一次启动引擎时换成新版本。",
    "en": "New conversations use the updated version. Existing conversations use it the next time their engine starts."
  },
  "settings.engines.EngineDetail.useEngineSettings": {
    "zh": "跟随引擎设置（{p0}）",
    "en": "Use engine settings ({p0})"
  },
  "settings.engines.EngineDetail.useEngineSettings2": {
    "zh": "跟随引擎设置",
    "en": "Use engine settings"
  },
  "settings.engines.EngineDetail.outputStyle": {
    "zh": "输出风格",
    "en": "Output style"
  },
  "settings.engines.EngineDetail.changesWritingStyleNot": {
    "zh": "回答的行文风格，不影响做事的认真程度。列表来自 {p0}，包括 ~/.claude/output-styles 里自己写的风格。",
    "en": "Changes the writing style, not task thoroughness. Styles come from {p0}, including your own ~/.claude/output-styles."
  },
  "settings.engines.EngineDetail.couldNotLoadS": {
    "zh": "没读到 {p0} 的输出风格列表（引擎不可用或版本太旧）。",
    "en": "Could not load {p0}'s output styles. The engine may be unavailable or outdated."
  },
  "settings.engines.EngineDetail.loading": {
    "zh": "正在读取…",
    "en": "Loading…"
  },
  "settings.engines.EngineDetail.notFound": {
    "zh": "{p0}（没找到）",
    "en": "{p0} (not found)"
  },
  "settings.engines.EngineDetail.contextCompactionModel": {
    "zh": "压缩上下文用的模型",
    "en": "Context compaction model"
  },
  "settings.engines.EngineDetail.platformConversationsOnlyUse": {
    "zh": "只对平台会话生效：压缩请求改用这个模型（当前线路没有它时仍用会话模型）。建议选上下文窗口不小于会话模型的。自有会话由 {p0} 自己决定。",
    "en": "Platform conversations only: use this model for compaction, falling back to the session model if the route does not support it. Choose at least the session model's context capacity. Own-account conversations are managed by {p0}."
  },
  "settings.engines.EngineDetail.contextCompactionModel2": {
    "zh": "{p0} 压缩上下文用的模型",
    "en": "{p0} context compaction model"
  },
  "settings.engines.EngineDetail.useConversationModel": {
    "zh": "跟随会话模型",
    "en": "Use conversation model"
  },
  "settings.engines.EngineDetail.thisLineIsNot": {
    "zh": "这一行不是 KEY=VALUE：{p0}",
    "en": "This line is not KEY=VALUE: {p0}"
  },
  "settings.engines.EngineDetail.environmentVariables": {
    "zh": "环境变量",
    "en": "Environment variables"
  },
  "settings.engines.EngineDetail.oneKeyValuePer": {
    "zh": "KEY=VALUE 每行一条，在系统环境之上追加。平台会话的网关地址和凭据仍以平台为准，这里的同名变量不生效。",
    "en": "One KEY=VALUE per line, added to system variables. Platform gateway URLs and credentials take precedence over matching values here."
  },
  "settings.engines.LaunchCard.title": {
    "zh": "启动",
    "en": "Launch"
  },
  "settings.engines.LaunchCard.modified": {
    "zh": "已修改",
    "en": "Modified"
  },
  "settings.engines.LaunchCard.stock": {
    "zh": "自带程序",
    "en": "Stock executable"
  },
  "settings.engines.LaunchCard.replaced": {
    "zh": "已替换",
    "en": "Replaced"
  },
  "settings.engines.LaunchCard.unknownVersion": {
    "zh": "版本未知",
    "en": "Unknown version"
  },
  "settings.engines.LaunchCard.notFound": {
    "zh": "找不到「{p0}」",
    "en": "Can’t find “{p0}”"
  },
  "settings.engines.LaunchCard.extraArgs": {
    "zh": "追加参数",
    "en": "Extra arguments"
  },
  "settings.engines.LaunchCard.edit": {
    "zh": "修改",
    "en": "Edit"
  },
  "settings.engines.LaunchCard.done": {
    "zh": "完成",
    "en": "Done"
  },
  "settings.engines.LaunchCard.cancel": {
    "zh": "取消",
    "en": "Cancel"
  },
  "settings.engines.LaunchCard.checking": {
    "zh": "正在检查…",
    "en": "Checking…"
  },
  "settings.engines.LaunchCard.command": {
    "zh": "命令",
    "en": "Command"
  },
  "settings.engines.LaunchCard.arguments": {
    "zh": "参数",
    "en": "Arguments"
  },
  "settings.engines.LaunchCard.note": {
    "zh": "替换要启动的程序：填绝对路径或 PATH 上的命令名，留空用自带程序。参数追加在每次启动的命令后面；像素星空自己控制的参数（输出格式、权限、模型、推理强度、会话恢复等）不能填。替换后的程序如果自己改了模型请求的去向，平台线路和用量统计会失效。",
    "en": "Replaces the executable to launch: an absolute path or a command on PATH. Leave it empty to use the stock executable. Arguments are appended every time the engine starts; arguments Pixel Starry Sky controls (output format, permissions, model, reasoning effort, session resume and so on) aren’t allowed. If the replacement redirects model traffic on its own, platform routing and usage metering stop working."
  },
  "settings.engines.LaunchCard.unbalancedQuotes": {
    "zh": "参数里的引号没有配对",
    "en": "The quotes in the arguments don’t match"
  },
  "settings.engines.LaunchCard.testFailed": {
    "zh": "试启动失败：{p0}",
    "en": "Test launch failed: {p0}"
  },
  "settings.engines.EnginesSection.localEngines": {
    "zh": "本机引擎",
    "en": "Local engines"
  },
  "settings.engines.EnginesSection.localProgramsThatExecute": {
    "zh": "执行工具的本机程序。自有额度用它们自己的登录；平台额度也由它们执行，只是模型请求改走平台。点一个引擎设置它的新会话默认值、输出风格、压缩等。",
    "en": "Local programs that execute tools. Own-account mode uses their sign-in; platform mode routes model requests through the platform. Select an engine to configure defaults, styles, compaction and more."
  },
  "settings.engines.EnginesSection.detectingLocalEngines": {
    "zh": "正在检测本机引擎…",
    "en": "Detecting local engines…"
  },
  "settings.engines.EnginesSection.settings": {
    "zh": "{p0} 设置",
    "en": "{p0} settings"
  },
  "settings.engines.EnginesSection.hiddenFromMenu": {
    "zh": "菜单中已隐藏",
    "en": "Hidden from menu"
  },
  "settings.engines.parts.notInstalled": {
    "zh": "未安装",
    "en": "Not installed"
  },
  "settings.engines.parts.outdatedVersion": {
    "zh": "版本过旧",
    "en": "Outdated version"
  },
  "settings.engines.parts.detectionFailed": {
    "zh": "检测出错",
    "en": "Detection failed"
  },
  "settings.engines.parts.anthropicsOfficialCodingCli": {
    "zh": "Anthropic 官方的编码 CLI。像素星空通过它读写文件、运行命令；长链路的工具调用稳定可靠。",
    "en": "Anthropic's official coding CLI. Pixel Starry Sky uses it to read and edit files and run commands, with reliable tool execution across long tasks."
  },
  "settings.engines.parts.openaisCodingCliSupport": {
    "zh": "OpenAI 的编码 CLI。即将支持。",
    "en": "OpenAI's coding CLI. Support coming soon."
  },
  "settings.FontPicker.chooseFromInstalledFonts": {
    "zh": "从本机字体中选择{p0}",
    "en": "Choose {p0} from installed fonts"
  },
  "settings.FontPicker.searchFonts": {
    "zh": "搜索字体",
    "en": "Search fonts"
  },
  "settings.FontPicker.searchInstalledFonts": {
    "zh": "搜索本机字体",
    "en": "Search installed fonts"
  },
  "settings.FontPicker.systemDefault": {
    "zh": "系统默认",
    "en": "System default"
  },
  "settings.FontPicker.loadingInstalledFonts": {
    "zh": "正在读取本机字体…",
    "en": "Loading installed fonts…"
  },
  "settings.FontPicker.couldNotLoadInstalled": {
    "zh": "读取不到本机字体列表，可以直接在输入框里输入字体名",
    "en": "Could not load installed fonts. Enter a font name directly instead."
  },
  "settings.FontPicker.noMatchingFonts": {
    "zh": "没有匹配的字体",
    "en": "No matching fonts"
  },
  "settings.FontSettings.on": {
    "zh": "开启",
    "en": "On"
  },
  "settings.FontSettings.interfaceFont": {
    "zh": "界面字体",
    "en": "Interface font"
  },
  "settings.FontSettings.usedInSidebarButtons": {
    "zh": "侧边栏、按钮、菜单和对话内容。可以从本机字体里选，也可以直接输入字体名（多个用逗号分隔，回车生效）。",
    "en": "Used in the sidebar, buttons, menus and conversations. Choose an installed font or enter names separated by commas, then press Enter."
  },
  "settings.FontSettings.systemDefaultInterSegoe": {
    "zh": "系统默认（Inter、Segoe UI、微软雅黑）",
    "en": "System default (Inter, Segoe UI, Microsoft YaHei)"
  },
  "settings.FontSettings.pixelStarrySkyAa": {
    "zh": "像素星空 Aa 123",
    "en": "Pixel Starry Sky Aa 123"
  },
  "settings.FontSettings.codeFont": {
    "zh": "代码字体",
    "en": "Code font"
  },
  "settings.FontSettings.usedForCodePaths": {
    "zh": "代码、文件路径、分支名和快捷键提示，建议选等宽字体。",
    "en": "Used for code, paths, branch names and shortcuts. A monospace font is recommended."
  },
  "settings.FontSettings.systemDefaultJetbrainsMono": {
    "zh": "系统默认（JetBrains Mono、Cascadia Mono、Consolas）",
    "en": "System default (JetBrains Mono, Cascadia Mono, Consolas)"
  },
  "settings.FontSettings.fontSize": {
    "zh": "字号",
    "en": "Font size"
  },
  "settings.FontSettings.scaleTextOnlyButtons": {
    "zh": "只放大或缩小文字，按钮、间距等布局尺寸不变。",
    "en": "Scale text only. Buttons, spacing and other layout sizes remain unchanged."
  },
  "settings.FontSettings.serifConversationText": {
    "zh": "对话正文用衬线体",
    "en": "Serif conversation text"
  },
  "settings.FontSettings.useSerifFontsSongti": {
    "zh": "助手回复的正文改用衬线字体（宋体、Noto Serif SC、Georgia），长文更好读；代码仍是等宽字体。",
    "en": "Use serif fonts (Songti, Noto Serif SC, Georgia) for longer assistant replies. Code remains monospace."
  },
  "settings.FontSettings.resetFontSettings": {
    "zh": "恢复默认字体设置",
    "en": "Reset font settings"
  },
  "settings.models.ModelsSection.ready": {
    "zh": "已就绪",
    "en": "Ready"
  },
  "settings.models.ModelsSection.modelsCredits": {
    "zh": "模型与额度",
    "en": "Models & credits"
  },
  "settings.models.ModelsSection.defaultsForNewTasks": {
    "zh": "新任务默认用这里的设置。已经开始的会话在输入框的模型菜单里单独改，不影响这里。",
    "en": "Defaults for new tasks. Existing conversations can change their model menu selections independently."
  },
  "settings.models.ModelsSection.defaultCreditSource": {
    "zh": "默认额度来源",
    "en": "Default credit source"
  },
  "settings.models.ModelsSection.platformBilledThroughPixel": {
    "zh": "平台：走像素星空账号的线路扣费；自有：用本机引擎自己的登录。平台出错时不会自动改用自有。",
    "en": "Platform: billed through Pixel Starry Sky routes. Own account: uses local engine sign-in. Platform failures never switch automatically to your own account."
  },
  "settings.models.ModelsSection.defaultModel": {
    "zh": "默认模型",
    "en": "Default model"
  },
  "settings.models.ModelsSection.modelsFromYourAvailable": {
    "zh": "来自你能用的平台线路。先选模型，线路自动对齐到包含它、倍率最低的一条。",
    "en": "Models from your available platform routes. Choose a model and its lowest-multiplier supported route is selected automatically."
  },
  "settings.models.ModelsSection.noModelsAvailable": {
    "zh": "暂无可用模型",
    "en": "No models available"
  },
  "settings.models.ModelsSection.availableAfterSignIn": {
    "zh": "登录后显示",
    "en": "Available after sign-in"
  },
  "settings.models.ModelsSection.defaultRoute": {
    "zh": "默认线路",
    "en": "Default route"
  },
  "settings.models.ModelsSection.onlyRoutesSupportingDefault": {
    "zh": "只列包含默认模型的线路，按倍率从低到高。倍率是当前账号的有效倍率（含专属倍率）。",
    "en": "Only routes supporting the default model are listed, ordered by effective billing multiplier, including account-specific rates."
  },
  "settings.models.ModelsSection.noRoutesAvailable": {
    "zh": "暂无可用线路",
    "en": "No routes available"
  },
  "settings.models.ModelsSection.claudeCodeModelAliases": {
    "zh": "Claude Code 的模型别名；「默认」跟随 Claude Code 自己的设置。",
    "en": "Claude Code model aliases. Default follows Claude Code's own settings."
  },
  "settings.models.ModelsSection.signInToPixel": {
    "zh": "登录像素星空账号后，可以使用管理员公开的平台线路。",
    "en": "Sign in to Pixel Starry Sky to use published platform routes."
  },
  "settings.models.ModelsSection.balance": {
    "zh": "· 余额 {p0}",
    "en": "· Balance {p0}"
  },
  "settings.models.ModelsSection.models": {
    "zh": "{p0} 个模型",
    "en": "{p0} models"
  },
  "settings.models.ModelsSection.modelsShownInMenu": {
    "zh": "菜单里显示的模型",
    "en": "Models shown in menu"
  },
  "settings.models.ModelsSection.hiddenModelsAreRemoved": {
    "zh": "关掉的模型不在输入框菜单里列出，不影响调用。正在用的和默认模型总会显示。",
    "en": "Hidden models are removed from the composer menu without affecting requests. Current and default models always remain visible."
  },
  "settings.models.ModelsSection.showAll": {
    "zh": "全部显示",
    "en": "Show all"
  },
  "settings.models.ModelsSection.route": {
    "zh": "{n} 条线路",
    "en": "{n} route"
  },
  "settings.models.ModelsSection.routes": {
    "zh": "{n} 条线路",
    "en": "{n} routes"
  },
  "settings.models.ModelsSection.showInMenu": {
    "zh": "在菜单里显示 {p0}",
    "en": "Show {p0} in menu"
  },
  "settings.models.ModelsSection.ownAccountLocalEngine": {
    "zh": "自有（本机引擎）",
    "en": "Own account (local engine)"
  },
  "settings.models.ModelsSection.engineSettings": {
    "zh": "引擎设置…",
    "en": "Engine settings…"
  },
  "settings.models.ModelsSection.requestRetries": {
    "zh": "请求重试",
    "en": "Request retries"
  },
  "settings.models.ModelsSection.customApi": {
    "zh": "自定义 API",
    "en": "Custom API"
  },
  "settings.models.RequestRetrySettings.maximumAutomaticRetriesFor": {
    "zh": "模型请求遇到临时错误时最多自动重试多少次。0 表示不自动重试；修改后从下一轮生效。",
    "en": "Maximum automatic retries for temporary model request errors. 0 disables retries. Changes apply from the next turn."
  },
  "settings.models.RequestRetrySettings.appliesToClaudeCode": {
    "zh": "适用于 Claude Code 的平台与自有请求。不会自动重新执行整轮任务或工具操作。",
    "en": "Applies to Claude Code platform and own-account requests. Entire tasks and tool actions are never replayed automatically."
  },
  "settings.models.RequestRetrySettings.requestRetryMode": {
    "zh": "请求重试模式",
    "en": "Request retry mode"
  },
  "settings.models.RequestRetrySettings.engineDefault": {
    "zh": "跟随引擎",
    "en": "Engine default"
  },
  "settings.models.RequestRetrySettings.enterIntegerFrom0": {
    "zh": "请输入 0～15 的整数",
    "en": "Enter an integer from 0 to 15"
  },
  "settings.models.RequestRetrySettings.retryCount": {
    "zh": "重试次数",
    "en": "Retry count"
  },
  "settings.models.RequestRetrySettings.decreaseRetryCount": {
    "zh": "减少重试次数",
    "en": "Decrease retry count"
  },
  "settings.models.RequestRetrySettings.increaseRetryCount": {
    "zh": "增加重试次数",
    "en": "Increase retry count"
  },
  "settings.models.RequestRetrySettings.n015Retries": {
    "zh": "0～15 次",
    "en": "0–15 retries"
  },
  "settings.models.RequestRetrySettings.presets": {
    "zh": "常用",
    "en": "Presets"
  },
  "settings.models.RequestRetrySettings.setRetries": {
    "zh": "设为重试 {p0} 次",
    "en": "Set {p0} retries"
  },
  "settings.models.RequestRetrySettings.doNotRetryAfter": {
    "zh": "失败后不自动重试",
    "en": "Do not retry after failure"
  },
  "settings.models.RequestRetrySettings.upToRetriesAfter": {
    "zh": "失败后最多重试 {p0} 次，共最多 {p1} 次尝试",
    "en": "Up to {p0} retries after failure; at most {p1} attempts in total"
  },
  "settings.models.RequestRetrySettings.useEnginesCurrentRetry": {
    "zh": "使用引擎当前的默认重试策略；像素星空平台线路最多重试 3 次，避免网络中途断开时反复重发、重复计费",
    "en": "Use the engine's current retry policy; PixelSky platform routes retry at most 3 times so a dropped connection doesn't resend and rebill repeatedly"
  },
  "settings.models.RequestRetrySettings.resetToDefault": {
    "zh": "恢复默认",
    "en": "Reset to default"
  },
  "settings.replyStats.tokensInputOutput": {
    "zh": "Token（输入 / 输出）",
    "en": "Tokens (input / output)"
  },
  "settings.replyStats.cost": {
    "zh": "费用",
    "en": "Cost"
  },
  "settings.replyStats.uncachedInputTokens": {
    "zh": "普通输入 Token",
    "en": "Uncached input tokens"
  },
  "settings.replyStats.totalTokens": {
    "zh": "总 Token",
    "en": "Total tokens"
  },
  "settings.replyStats.cacheHitRate": {
    "zh": "缓存命中率",
    "en": "Cache hit rate"
  },
  "settings.replyStats.modelRequestCount": {
    "zh": "模型请求次数",
    "en": "Model request count"
  },
  "settings.replyStats.basicInformation": {
    "zh": "基础信息",
    "en": "Basic information"
  },
  "settings.replyStats.tokenBreakdown": {
    "zh": "Token 明细",
    "en": "Token breakdown"
  },
  "settings.replyStats.requestStatistics": {
    "zh": "调用统计",
    "en": "Request statistics"
  },
  "settings.ReplyStatsSettings.statisticsBelowReplies": {
    "zh": "回复下方的统计",
    "en": "Statistics below replies"
  },
  "settings.ReplyStatsSettings.chooseWhichStatisticsAppear": {
    "zh": "选择每轮回复下方显示的数据。立即应用到所有会话，并在本机保存。",
    "en": "Choose which statistics appear below each reply. Changes apply to all conversations and are saved locally."
  },
  "settings.ReplyStatsSettings.replyStatisticsPreview": {
    "zh": "回复统计预览",
    "en": "Reply statistics preview"
  },
  "settings.ReplyStatsSettings.previewSampleData": {
    "zh": "预览 · 示例数据",
    "en": "Preview · Sample data"
  },
  "settings.ReplyStatsSettings.hideStatistics": {
    "zh": "不显示统计",
    "en": "Hide statistics"
  },
  "settings.ReplyStatsSettings.uncachedInputExcludesCache": {
    "zh": "普通输入不含缓存；「输入 / 输出」中的输入包含缓存。没有数据的项目会自动隐藏。",
    "en": "Uncached input excludes cache; input / output includes cache in input. Fields without data are hidden automatically."
  },
  "settings.ReplyStatsSettings.resetStatistics": {
    "zh": "恢复默认统计",
    "en": "Reset statistics"
  },
  "settings.requestRetry.configureRequestRetriesIn": {
    "zh": "请在桌面应用中设置请求重试",
    "en": "Configure request retries in the desktop app"
  },
  "settings.searchIndex.composerStyleLayoutChatgpt": {
    "zh": "输入框 风格 样式 布局 chatgpt claude 工具框内 框外",
    "en": "composer style layout chatgpt claude inside outside toolbar"
  },
  "settings.searchIndex.openingMethodBuiltIn": {
    "zh": "打开方式 内置编辑器 像素星空 CodeMirror 软件内 打开项目 Trae TraeCode CN",
    "en": "opening method built-in editor Pixel Starry Sky CodeMirror project Trae TraeCode CN"
  },
  "settings.searchIndex.editorCursorVsCode": {
    "zh": "编辑器 Cursor VS Code Windsurf Trae TraeCode CN 打开项目 默认",
    "en": "editor Cursor VS Code Windsurf Trae TraeCode CN open project default"
  },
  "settings.searchIndex.editorReuseWindowNew": {
    "zh": "编辑器 复用窗口 新窗口",
    "en": "editor reuse window new window"
  },
  "settings.searchIndex.editorProgramPathExe": {
    "zh": "编辑器 程序 路径 exe 检测",
    "en": "editor program path exe detection"
  },
  "settings.searchIndex.editorFolderArgumentsAdd": {
    "zh": "编辑器 文件夹 参数 添加",
    "en": "editor folder arguments add"
  },
  "settings.searchIndex.signInSignOut": {
    "zh": "登录 退出登录 余额 套餐 订阅 充值 额度 限额",
    "en": "sign in sign out balance plan subscription credits limits"
  },
  "settings.searchIndex.platformOwnAccountCredits": {
    "zh": "平台 自有 额度 扣费 来源",
    "en": "platform own account credits billing source"
  },
  "settings.searchIndex.modelNewTaskClaude": {
    "zh": "模型 新任务 claude opus sonnet haiku",
    "en": "model new task claude opus sonnet haiku"
  },
  "settings.searchIndex.routeGroupMultiplierBilling": {
    "zh": "线路 分组 倍率 计费",
    "en": "route group multiplier billing"
  },
  "settings.searchIndex.routeGroupMultiplierBalance": {
    "zh": "线路 分组 倍率 余额计费 订阅额度 刷新",
    "en": "route group multiplier balance subscription refresh"
  },
  "settings.searchIndex.hiddenModelsManageModel": {
    "zh": "隐藏模型 管理模型 模型列表 显示",
    "en": "hidden models manage model list visibility"
  },
  "settings.searchIndex.retryFailureTemporaryErrors": {
    "zh": "重试 失败 临时错误 自动重试",
    "en": "retry failure temporary errors automatic retry"
  },
  "settings.searchIndex.byokKeyUrlOpenai": {
    "zh": "byok key 地址 openai anthropic 兼容",
    "en": "byok key url openai anthropic compatible"
  },
  "settings.searchIndex.engineVersionPathDetect": {
    "zh": "引擎 版本 路径 重新检测 claude 默认引擎 设为默认",
    "en": "engine version path detect claude default engine"
  },
  "settings.searchIndex.engineOpenaiCodex": {
    "zh": "引擎 openai codex",
    "en": "engine openai codex"
  },
  "settings.searchIndex.upgradeUpdateVersionClaude": {
    "zh": "升级 更新 版本 claude update 新版本",
    "en": "upgrade update version claude update new version"
  },
  "settings.searchIndex.defaultsNewTaskNew": {
    "zh": "默认 新任务 新会话",
    "en": "defaults new task new conversation"
  },
  "settings.searchIndex.effortThinkingDefaultLow": {
    "zh": "effort 思考 强度 默认 low high max",
    "en": "effort thinking default low high max"
  },
  "settings.searchIndex.askAutoEditPlan": {
    "zh": "询问 自动编辑 计划模式 完全放行 bypass 默认权限",
    "en": "ask auto-edit plan full access bypass default permissions"
  },
  "settings.searchIndex.fastSpeedDefault": {
    "zh": "fast 快速 默认",
    "en": "fast speed default"
  },
  "settings.searchIndex.ultracodeSubagentsOrchestrationDefault": {
    "zh": "ultracode 子智能体 编排 默认",
    "en": "ultracode subagents orchestration default"
  },
  "settings.searchIndex.thinkingSummaryDefault": {
    "zh": "思考 摘要 thinking 默认",
    "en": "thinking summary default"
  },
  "settings.searchIndex.outputStyleExplanatoryLearning": {
    "zh": "output style 风格 行文 explanatory learning proactive concise",
    "en": "output style explanatory learning proactive concise"
  },
  "settings.searchIndex.questionsAskuserquestionInterruptAssumptions": {
    "zh": "提问 问题 askuserquestion 打断 自己拿主意",
    "en": "questions askuserquestion interrupt assumptions"
  },
  "settings.searchIndex.compactThresholdPercentageContext": {
    "zh": "压缩 compact 阈值 百分比 上下文 窗口 autocompact",
    "en": "compact threshold percentage context window autocompact"
  },
  "settings.searchIndex.compactSummaryContextCompaction": {
    "zh": "压缩 compact 摘要 上下文 压缩模型",
    "en": "compact summary context compaction model"
  },
  "settings.searchIndex.hideEngineMenuShow": {
    "zh": "隐藏 引擎 菜单 显示",
    "en": "hide engine menu show"
  },
  "settings.searchIndex.pathClaudeExeDetection": {
    "zh": "路径 claude.exe 自动查找 覆盖 启动方式",
    "en": "path claude.exe detection override launch"
  },
  "settings.searchIndex.envProxyHttpsProxy": {
    "zh": "env 代理 proxy https_proxy key=value 启动方式",
    "en": "env proxy https_proxy key=value launch"
  },
  "settings.searchIndex.requestRecordsTokensCost": {
    "zh": "调用记录 token 费用 导出 csv 账号调用 本机记录 统计",
    "en": "request records tokens cost export csv account local statistics"
  },
  "settings.searchIndex.theme": {
    "zh": "主题",
    "en": "Theme"
  },
  "settings.searchIndex.lightDarkSystemTheme": {
    "zh": "浅色 深色 跟随系统 暗色 dark light",
    "en": "light dark system theme"
  },
  "settings.searchIndex.motion": {
    "zh": "动画",
    "en": "Motion"
  },
  "settings.searchIndex.motionTransitionReducedAnimation": {
    "zh": "动效 过渡 减少动画",
    "en": "motion transition reduced animation"
  },
  "settings.searchIndex.paneSwitching": {
    "zh": "切换窗格时",
    "en": "Pane switching"
  },
  "settings.searchIndex.paneSplitHighlightSlide": {
    "zh": "窗格 分屏 高亮 滑动 焦点 动画",
    "en": "pane split highlight slide focus animation"
  },
  "settings.searchIndex.statisticsDurationTokensCost": {
    "zh": "统计行 耗时 token 费用 回复",
    "en": "statistics duration tokens cost reply"
  },
  "settings.searchIndex.cacheHitRateAlerts": {
    "zh": "缓存 命中率 提醒 停止",
    "en": "cache hit rate alerts stop"
  },
  "settings.searchIndex.font": {
    "zh": "字体 font",
    "en": "font"
  },
  "settings.searchIndex.monospaceFont": {
    "zh": "等宽 字体 mono",
    "en": "monospace font"
  },
  "settings.searchIndex.textSizeScaleFont": {
    "zh": "文字大小 放大 缩小 字体大小",
    "en": "text size scale font size"
  },
  "settings.searchIndex.serifSongtiReading": {
    "zh": "衬线 宋体 阅读",
    "en": "serif Songti reading"
  },
  "settings.searchIndex.wallpaper": {
    "zh": "壁纸",
    "en": "Wallpaper"
  },
  "settings.searchIndex.backgroundImageVideoWallpaper": {
    "zh": "背景 图片 视频 wallpaper",
    "en": "background image video wallpaper"
  },
  "settings.searchIndex.opacity": {
    "zh": "透出程度",
    "en": "Opacity"
  },
  "settings.searchIndex.wallpaperTransparencyOpacity": {
    "zh": "壁纸 透明 不透明度",
    "en": "wallpaper transparency opacity"
  },
  "settings.searchIndex.blur": {
    "zh": "模糊",
    "en": "Blur"
  },
  "settings.searchIndex.wallpaperBlur": {
    "zh": "壁纸 虚化 blur",
    "en": "wallpaper blur"
  },
  "settings.searchIndex.shortcuts": {
    "zh": "快捷键",
    "en": "Shortcuts"
  },
  "settings.searchIndex.keyboardCtrlSplitSidebar": {
    "zh": "键盘 ctrl 分屏 侧边栏 面板 搜索",
    "en": "keyboard ctrl split sidebar panel search"
  },
  "settings.searchIndex.about": {
    "zh": "关于",
    "en": "About"
  },
  "settings.searchIndex.versionUpdateDataDirectory": {
    "zh": "版本 更新 数据目录 运行环境 链接",
    "en": "version update data directory runtime links"
  },
  "settings.SettingsDialog.appearance": {
    "zh": "外观",
    "en": "Appearance"
  },
  "settings.SettingsDialog.nav.machines": {
    "zh": "机器与连接",
    "en": "Machines"
  },
  "settings.SettingsDialog.nav.models": {
    "zh": "模型与额度",
    "en": "Models"
  },
  "settings.SettingsDialog.nav.terminal": {
    "zh": "终端设置",
    "en": "Terminal"
  },
  "settings.SettingsDialog.nav.search": {
    "zh": "搜索设置",
    "en": "Search"
  },
  "settings.SettingsDialog.application": {
    "zh": "应用",
    "en": "Application"
  },
  "settings.SettingsDialog.dragToResize": {
    "zh": "拖动调整大小",
    "en": "Drag to resize"
  },
  "settings.SettingsDialog.searchSettings": {
    "zh": "搜索设置",
    "en": "Search settings"
  },
  "settings.SettingsDialog.clearSearch": {
    "zh": "清空搜索",
    "en": "Clear search"
  },
  "settings.SettingsDialog.noMatchingSettings": {
    "zh": "没有匹配的设置",
    "en": "No matching settings"
  },
  "settings.SettingsDialog.light": {
    "zh": "浅色",
    "en": "Light"
  },
  "settings.SettingsDialog.dark": {
    "zh": "深色",
    "en": "Dark"
  },
  "settings.SettingsDialog.system": {
    "zh": "跟随系统",
    "en": "System"
  },
  "settings.SettingsDialog.alwaysOn": {
    "zh": "始终开启",
    "en": "Always on"
  },
  "settings.SettingsDialog.highlight": {
    "zh": "高亮",
    "en": "Highlight"
  },
  "settings.SettingsDialog.slide": {
    "zh": "滑动",
    "en": "Slide"
  },
  "settings.SettingsDialog.none": {
    "zh": "无",
    "en": "None"
  },
  "settings.SettingsDialog.whenFollowingSystemTheme": {
    "zh": "跟随系统时，会随 Windows 的浅色 / 深色模式自动切换。",
    "en": "When following the system, the theme changes with Windows light / dark mode."
  },
  "settings.SettingsDialog.interfaceLanguage": {
    "zh": "界面语言",
    "en": "Interface language"
  },
  "settings.SettingsDialog.chooseLanguageUsedBy": {
    "zh": "选择像素星空界面使用的语言。",
    "en": "Choose the language used by the Pixel Starry Sky interface."
  },
  "settings.SettingsDialog.animationsForSidebarAnd": {
    "zh": "侧边栏、右侧面板的展开收起，窗格的拆分、移动与标签切换，菜单弹出，按钮按下等动画效果。",
    "en": "Animations for sidebar and panel transitions, pane splits and tab switching, menus and button presses."
  },
  "settings.SettingsDialog.systemAnimationsAreDisabled": {
    "zh": "系统已关闭「动画效果」，当前仍显示动画。",
    "en": "System animations are disabled, but app animations remain enabled."
  },
  "settings.SettingsDialog.systemAnimationsAreDisabled2": {
    "zh": "系统已关闭「动画效果」，所以现在不显示动画。",
    "en": "System animations are disabled, so app animations are currently hidden."
  },
  "settings.SettingsDialog.highlightBrieflyLightsUp": {
    "zh": "高亮会在新窗格周围短暂亮起；滑动会将焦点框移过去；无则不显示焦点框。",
    "en": "Highlight briefly lights up the new pane; Slide moves the focus frame; None hides the focus frame."
  },
  "settings.SettingsDialog.motionIsDisabledPane": {
    "zh": "动画已关闭，切换窗格时直接跳过去",
    "en": "Motion is disabled. Pane focus switches immediately."
  },
  "settings.SettingsDialog.onlyAffectsFocusChanges": {
    "zh": "只影响切换焦点，拆分、均分和关闭窗格仍沿用布局动画。",
    "en": "Only affects focus changes. Splits, equal sizing and closing panes keep their layout animations."
  },
  "settings.SettingsDialog.fonts": {
    "zh": "字体",
    "en": "Fonts"
  },
  "settings.SettingsDialog.toggleSidebar": {
    "zh": "收起 / 展开侧边栏",
    "en": "Toggle sidebar"
  },
  "settings.SettingsDialog.toggleRightPanel": {
    "zh": "收起 / 展开右侧面板",
    "en": "Toggle right panel"
  },
  "settings.SettingsDialog.openSettings": {
    "zh": "打开设置",
    "en": "Open settings"
  },
  "settings.SettingsProvider.usesettingsMustBeUsed": {
    "zh": "useSettings 必须在 SettingsProvider 内使用",
    "en": "useSettings must be used within SettingsProvider"
  },
  "settings.sync.title": {
    "zh": "设置云同步",
    "en": "Sync settings"
  },
  "settings.sync.description": {
    "zh": "在登录同一账号的电脑之间同步偏好设置。只同步偏好设置，不同步密钥、会话和本机路径。",
    "en": "Sync preferences across computers signed in to this account. Only preferences are synced — never keys, sessions or local paths."
  },
  "settings.sync.appearance": {
    "zh": "外观",
    "en": "Appearance"
  },
  "settings.sync.display": {
    "zh": "对话显示",
    "en": "Conversation display"
  },
  "settings.sync.notifications": {
    "zh": "通知",
    "en": "Notifications"
  },
  "settings.sync.keybindings": {
    "zh": "快捷键",
    "en": "Shortcuts"
  },
  "settings.sync.platform": {
    "zh": "模型与线路",
    "en": "Models & routes"
  },
  "settings.sync.engine": {
    "zh": "引擎",
    "en": "Engines"
  },
  "settings.sync.syncing": {
    "zh": "正在同步…",
    "en": "Syncing…"
  },
  "settings.sync.lastSync": {
    "zh": "上次同步：{p0}",
    "en": "Last synced {p0}"
  },
  "settings.sync.notYet": {
    "zh": "还没有同步过",
    "en": "Not synced yet"
  },
  "settings.sync.now": {
    "zh": "立即同步",
    "en": "Sync now"
  },
  "settings.sync.justNow": {
    "zh": "刚刚",
    "en": "just now"
  },
  "settings.sync.minutesAgo": {
    "zh": "{p0} 分钟前",
    "en": "{p0} min ago"
  },
  "settings.sync.hoursAgo": {
    "zh": "{p0} 小时前",
    "en": "{p0} h ago"
  },
  "settings.sync.restored": {
    "zh": "已从云端恢复设置",
    "en": "Settings restored from the cloud"
  },
  "settings.sync.undo": {
    "zh": "撤销",
    "en": "Undo"
  },
  "settings.sync.close": {
    "zh": "关闭",
    "en": "Close"
  },
  "settings.usage.UsageChart.style": {
    "zh": "图表样式",
    "en": "Chart style"
  },
  "settings.usage.UsageChart.line": {
    "zh": "折线节点图",
    "en": "Line chart"
  },
  "settings.usage.UsageChart.bar": {
    "zh": "堆叠柱状图",
    "en": "Stacked bar chart"
  },
  "settings.usage.UsageChart.lineAria": {
    "zh": "{p0}用量折线图，峰值 {p1}",
    "en": "{p0} usage line chart, peak {p1}"
  },
  "settings.usage.UsageChart.keyboardHint": {
    "zh": "按 ← / → 逐格查看，Home / End 跳到首尾",
    "en": "Use ← / → to step through, Home / End to jump to the ends"
  },
  "settings.usage.UsageChart.toggleSeries": {
    "zh": "显示 / 隐藏「{p0}」，纵轴按显示的系列取整",
    "en": "Show / hide {p0}; the axis rescales to the visible series"
  },
  "settings.usage.UsageChart.keepOne": {
    "zh": "至少保留一个系列",
    "en": "Keep at least one series"
  },
  "settings.usage.UsageChart.inProgress": {
    "zh": "进行中",
    "en": "In progress"
  },
  "settings.usage.UsageChart.cacheWriteIncluded": {
    "zh": "缓存写（含在输入里）",
    "en": "Cache write (in input)"
  },
  "settings.usage.DailyChart.text": {
    "zh": "{p0}月{p1}日",
    "en": "{p0}/{p1}"
  },
  "settings.usage.DailyChart.total": {
    "zh": "合计",
    "en": "Total"
  },
  "settings.usage.DailyChart.peak": {
    "zh": "峰值 {p0}（{p1}）",
    "en": "Peak {p0} ({p1})"
  },
  "settings.usage.DailyChart.noUsageInThis": {
    "zh": "这段时间没有用量",
    "en": "No usage in this period"
  },
  "settings.usage.DailyChart.legend": {
    "zh": "图例",
    "en": "Legend"
  },
  "settings.usage.DailyChart.usageChartPeak": {
    "zh": "{p0}用量柱状图，峰值 {p1}",
    "en": "{p0} usage chart, peak {p1}"
  },
  "settings.usage.DailyChart.todayByHour": {
    "zh": "今天每小时",
    "en": "Today by hour"
  },
  "settings.usage.DailyChart.now": {
    "zh": "现在",
    "en": "Now"
  },
  "settings.usage.DailyChart.today": {
    "zh": "今天",
    "en": "Today"
  },
  "settings.usage.Distribution.distribution": {
    "zh": "分布",
    "en": "Distribution"
  },
  "settings.usage.Distribution.distributionDimension": {
    "zh": "分布维度",
    "en": "Distribution dimension"
  },
  "settings.usage.Distribution.noData": {
    "zh": "没有数据",
    "en": "No data"
  },
  "settings.usage.Distribution.share": {
    "zh": "占比",
    "en": "Share"
  },
  "settings.usage.Distribution.turns": {
    "zh": "轮次",
    "en": "Turns"
  },
  "settings.usage.Distribution.filteredByThisItem": {
    "zh": "已按这一项筛选",
    "en": "Filtered by this item"
  },
  "settings.usage.Distribution.clickToFilterBy": {
    "zh": "点击只看这一项",
    "en": "Click to filter by this item"
  },
  "settings.usage.KpiCards.conversationTurns": {
    "zh": "调用轮次",
    "en": "Conversation turns"
  },
  "settings.usage.KpiCards.turns": {
    "zh": "轮",
    "en": "turns"
  },
  "settings.usage.KpiCards.requests": {
    "zh": "{p0} 次请求",
    "en": "{p0} requests"
  },
  "settings.usage.KpiCards.inputOutput": {
    "zh": "输入 {p0} · 输出 {p1}",
    "en": "Input {p0} · Output {p1}"
  },
  "settings.usage.KpiCards.cacheHit": {
    "zh": "缓存命中",
    "en": "Cache hit"
  },
  "settings.usage.KpiCards.cacheRead": {
    "zh": "缓存读 {p0}",
    "en": "Cache read {p0}"
  },
  "settings.usage.KpiCards.unchanged": {
    "zh": "持平",
    "en": "Unchanged"
  },
  "settings.usage.KpiCards.missingCost": {
    "zh": "{p0} 条没有费用",
    "en": "{p0} records without a recorded cost"
  },
  "settings.usage.Distribution.missingCost": {
    "zh": "{p0} 条没有费用，分布表切到「费用情况」看原因",
    "en": "{p0} records without a recorded cost; switch the distribution to Cost status to see why"
  },
  "settings.usage.KpiCards.estimateReportedByEngine": {
    "zh": "引擎报告的估算值",
    "en": "Estimate reported by the engine"
  },
  "settings.usage.KpiCards.comparedWithPreviousPeriod": {
    "zh": "和上一个同样长度的时间段比较",
    "en": "Compared with the previous period of the same length"
  },
  "settings.usage.RecordsTable.completed": {
    "zh": "完成",
    "en": "Completed"
  },
  "settings.usage.RecordsTable.interrupted": {
    "zh": "中断",
    "en": "Interrupted"
  },
  "settings.usage.RecordsTable.time": {
    "zh": "时间",
    "en": "Time"
  },
  "settings.usage.RecordsTable.conversation": {
    "zh": "会话",
    "en": "Conversation"
  },
  "settings.usage.RecordsTable.untitledConversation": {
    "zh": "未命名会话",
    "en": "Untitled conversation"
  },
  "settings.usage.RecordsTable.requests": {
    "zh": "请求",
    "en": "Requests"
  },
  "settings.usage.RecordsTable.outcome": {
    "zh": "结果",
    "en": "Outcome"
  },
  "settings.usage.RecordsTable.requestRecords": {
    "zh": "调用记录",
    "en": "Request records"
  },
  "settings.usage.RecordsTable.requestCount": {
    "zh": "请求次数",
    "en": "Request count"
  },
  "settings.usage.RecordsTable.inputCacheMisses": {
    "zh": "输入（未命中缓存）",
    "en": "Input (cache misses)"
  },
  "settings.usage.RecordsTable.notReportedByEngine": {
    "zh": "引擎未报告",
    "en": "Not reported by engine"
  },
  "settings.usage.RecordsTable.started": {
    "zh": "开始",
    "en": "Started"
  },
  "settings.usage.RecordsTable.ended": {
    "zh": "结束",
    "en": "Ended"
  },
  "settings.usage.RecordsTable.openConversation": {
    "zh": "打开这个会话",
    "en": "Open conversation"
  },
  "settings.usage.RemoteCallsTable.succeeded": {
    "zh": "成功",
    "en": "Succeeded"
  },
  "settings.usage.RemoteCallsTable.rateLimited": {
    "zh": "限流",
    "en": "Rate limited"
  },
  "settings.usage.RemoteCallsTable.desktop": {
    "zh": "桌面端",
    "en": "Desktop"
  },
  "settings.usage.RemoteCallsTable.directApiKey": {
    "zh": "直接用 Key",
    "en": "Direct API key"
  },
  "settings.usage.RemoteCallsTable.unknown": {
    "zh": "未知",
    "en": "Unknown"
  },
  "settings.usage.RemoteCallsTable.client": {
    "zh": "客户端",
    "en": "Client"
  },
  "settings.usage.RemoteCallsTable.charge": {
    "zh": "扣费",
    "en": "Charge"
  },
  "settings.usage.RemoteCallsTable.firstToken": {
    "zh": "首字",
    "en": "First token"
  },
  "settings.usage.RemoteCallsTable.accountRequests": {
    "zh": "账号调用",
    "en": "Account requests"
  },
  "settings.usage.RemoteCallsTable.device": {
    "zh": "设备",
    "en": "Device"
  },
  "settings.usage.RemoteCallsTable.requestType": {
    "zh": "请求方式",
    "en": "Request type"
  },
  "settings.usage.RemoteCallsTable.streaming": {
    "zh": "流式",
    "en": "Streaming"
  },
  "settings.usage.RemoteCallsTable.nonStreaming": {
    "zh": "非流式",
    "en": "Non-streaming"
  },
  "settings.usage.RemoteCallsTable.noBillingInformation": {
    "zh": "无计费信息",
    "en": "No billing information"
  },
  "settings.usage.RemoteCallsTable.timeToFirstToken": {
    "zh": "首字延迟",
    "en": "Time to first token"
  },
  "settings.usage.RemoteCallsTable.relatedTurn": {
    "zh": "关联轮次",
    "en": "Related turn"
  },
  "settings.usage.RemoteCallsTable.requestedAt": {
    "zh": "发起时间",
    "en": "Requested at"
  },
  "settings.usage.RemoteCallsTable.accountRequestDetailsAre": {
    "zh": "账号调用明细即将推出",
    "en": "Account request details are coming soon"
  },
  "settings.usage.RemoteCallsTable.eachModelRequestWill": {
    "zh": "这一块已经定好形状（每一次模型请求一条：模型、客户端、token、实际扣费、延迟），等认证服务提供接口后接入。演示数据用",
    "en": "Each model request will show its model, client, tokens, actual charges and latency once the authentication service API is available. View sample data using"
  },
  "settings.usage.RemoteCallsTable.text": {
    "zh": "查看。",
    "en": "."
  },
  "settings.usage.RemoteCallsTable.backToLocalRecords": {
    "zh": "回到本机记录",
    "en": "Back to local records"
  },
  "settings.usage.RemoteCallsTable.signInToView": {
    "zh": "登录后查看账号调用",
    "en": "Sign in to view account requests"
  },
  "settings.usage.RemoteCallsTable.signInToPixel": {
    "zh": "登录像素星空账号后，可以查看这个账号每一次模型调用的明细（所有设备、所有客户端）。",
    "en": "Sign in to Pixel Starry Sky to view individual model requests across all devices and clients."
  },
  "settings.usage.RemoteCallsTable.signIn": {
    "zh": "去登录",
    "en": "Sign in"
  },
  "settings.usage.UsageSection.localRecords": {
    "zh": "本机记录",
    "en": "Local records"
  },
  "settings.usage.UsageSection.n7Days": {
    "zh": "7 天",
    "en": "7 days"
  },
  "settings.usage.UsageSection.n30Days": {
    "zh": "30 天",
    "en": "30 days"
  },
  "settings.usage.UsageSection.n90Days": {
    "zh": "90 天",
    "en": "90 days"
  },
  "settings.usage.UsageSection.recordSource": {
    "zh": "记录范围",
    "en": "Record source"
  },
  "settings.usage.UsageSection.exportCsv": {
    "zh": "导出 CSV",
    "en": "Export CSV"
  },
  "settings.usage.UsageSection.clearAllRecords": {
    "zh": "清空全部记录？",
    "en": "Clear all records?"
  },
  "settings.usage.UsageSection.timeRange": {
    "zh": "时间范围",
    "en": "Time range"
  },
  "settings.usage.UsageSection.removeFilter": {
    "zh": "移除筛选 {p0}",
    "en": "Remove filter {p0}"
  },
  "settings.usage.UsageSection.clearFilters": {
    "zh": "清除筛选",
    "en": "Clear filters"
  },
  "settings.usage.UsageSection.recordsStayOnThis": {
    "zh": "记录只保存在这台电脑上，保留 90 天，只有时间、模型、token 数、费用和耗时，不含对话内容。费用是引擎报告的估算值，可能和实际账单不同。",
    "en": "Records stay on this computer for 90 days. They include time, model, token counts, cost and duration, but no conversation content. Costs are engine estimates and may differ from actual bills."
  },
  "settings.usage.KpiCards.accountRequests": {
    "zh": "调用次数",
    "en": "Requests"
  },
  "settings.usage.KpiCards.callsUnit": {
    "zh": "次",
    "en": "calls"
  },
  "settings.usage.KpiCards.models": {
    "zh": "{p0} 个模型",
    "en": "{p0} models"
  },
  "settings.usage.Distribution.requests": {
    "zh": "请求",
    "en": "Requests"
  },
  "settings.usage.UsageSection.accountTotalsUnavailable": {
    "zh": "暂时读不到合计，下面是逐条明细。",
    "en": "Totals aren't available right now. The list below shows each request."
  },
  "settings.usage.UsageSection.accountRecordsNote": {
    "zh": "账号调用来自平台账单，每次模型请求一条，费用是实际扣除的金额。用 Claude Code / Codex 自带登录的调用不在这里。",
    "en": "Account requests come from the platform's billing, one per model request. Costs are the amounts actually charged. Requests made with Claude Code or Codex's own sign-in aren't listed here."
  },
  "settings.usage.UsageSection.loadingAccountRequests": {
    "zh": "正在读取账号调用…",
    "en": "Loading account requests…"
  },
  "settings.usage.UsageSection.noRecordsMatchThese": {
    "zh": "没有符合筛选条件的记录",
    "en": "No records match these filters"
  },
  "settings.usage.UsageSection.noUsageRecordsYet": {
    "zh": "还没有用量记录",
    "en": "No usage records yet"
  },
  "settings.usage.UsageSection.chooseAnotherTimeRange": {
    "zh": "换一个时间范围，或者移除筛选条件。",
    "en": "Choose another time range or remove filters."
  },
  "settings.usage.UsageSection.afterStartingConversationEach": {
    "zh": "开始对话后，每一轮的模型调用都会记在这里：用了哪个模型、多少 token、花了多少钱。记录只保存在这台电脑上。",
    "en": "After starting a conversation, each turn's model, token count and cost appear here. Records stay on this computer."
  },
  "settings.usage.UsageTable.previousPage": {
    "zh": "上一页",
    "en": "Previous page"
  },
  "settings.usage.UsageTable.nextPage": {
    "zh": "下一页",
    "en": "Next page"
  },
  "settings.WallpaperSettings.fillWindowWithImage": {
    "zh": "用图片或视频（mp4 / webm，静音循环）铺满整个窗口。文件只保存在本机，最大 200 MB。",
    "en": "Fill the window with an image or silent looping video (mp4 / webm). Files stay on this computer. Maximum size: 200 MB."
  },
  "settings.WallpaperSettings.currentWallpaper": {
    "zh": "当前壁纸",
    "en": "Current wallpaper"
  },
  "settings.WallpaperSettings.notSet": {
    "zh": "未设置",
    "en": "Not set"
  },
  "settings.WallpaperSettings.change": {
    "zh": "更换…",
    "en": "Change…"
  },
  "settings.WallpaperSettings.chooseImageOrVideo": {
    "zh": "选择图片或视频…",
    "en": "Choose image or video…"
  },
  "settings.WallpaperSettings.howMuchWallpaperShows": {
    "zh": "壁纸能透出来多少。越低文字越清楚。",
    "en": "How much wallpaper shows through. Lower values improve text readability."
  },
  "settings.WallpaperSettings.blurWallpaperToMake": {
    "zh": "把壁纸虚化，界面上的文字更容易看清。",
    "en": "Blur the wallpaper to make interface text easier to read."
  },
  "shortcuts.splitPaneRight": {
    "zh": "向右拆分窗格",
    "en": "Split pane right"
  },
  "shortcuts.splitPaneDown": {
    "zh": "向下拆分窗格",
    "en": "Split pane down"
  },
  "shortcuts.closeTabClosePane": {
    "zh": "关闭标签（窗格空了就关闭窗格）",
    "en": "Close tab (close pane if empty)"
  },
  "shortcuts.jumpToPaneN": {
    "zh": "跳到第 N 个窗格",
    "en": "Jump to pane N"
  },
  "shortcuts.switchToPreviousNext": {
    "zh": "切换到上一个 / 下一个窗格",
    "en": "Switch to previous / next pane"
  },
  "shortcuts.expandRestoreCurrentPane": {
    "zh": "放大 / 还原当前窗格",
    "en": "Expand / restore current pane"
  },
  "shortcuts.switchTabsInPane": {
    "zh": "切换窗格里的标签",
    "en": "Switch tabs in pane"
  },
  "shortcuts.help.action": {
    "zh": "快捷键一览",
    "en": "Show keyboard shortcuts"
  },
  "shortcuts.help.title": {
    "zh": "快捷键",
    "en": "Keyboard shortcuts"
  },
  "shortcuts.help.search": {
    "zh": "搜索快捷键",
    "en": "Search shortcuts"
  },
  "shortcuts.help.none": {
    "zh": "没有符合的快捷键",
    "en": "No matching shortcuts"
  },
  "shortcuts.help.customize": {
    "zh": "自定义快捷键…",
    "en": "Customize shortcuts…"
  },
  "shortcuts.help.groupGeneral": {
    "zh": "常用（可以改）",
    "en": "General (customizable)"
  },
  "shortcuts.help.groupPanes": {
    "zh": "窗格和终端",
    "en": "Panes and terminal"
  },
  "shortcuts.help.groupComposer": {
    "zh": "输入框",
    "en": "Message box"
  },
  "shortcuts.help.groupMenus": {
    "zh": "菜单",
    "en": "Menus"
  },
  "shortcuts.help.groupBoard": {
    "zh": "任务看板",
    "en": "Task board"
  },
  "shortcuts.help.send": {
    "zh": "发送",
    "en": "Send"
  },
  "shortcuts.help.newline": {
    "zh": "换行",
    "en": "New line"
  },
  "shortcuts.help.stop": {
    "zh": "停止正在进行的回复",
    "en": "Stop the reply in progress"
  },
  "shortcuts.help.mention": {
    "zh": "添加文件",
    "en": "Add a file"
  },
  "shortcuts.help.command": {
    "zh": "输入命令",
    "en": "Run a command"
  },
  "shortcuts.help.suggestion": {
    "zh": "填入灰色的建议",
    "en": "Fill in the suggestion"
  },
  "shortcuts.help.menuMove": {
    "zh": "上下移动",
    "en": "Move up and down"
  },
  "shortcuts.help.menuSub": {
    "zh": "打开 / 退出子菜单",
    "en": "Open / leave a submenu"
  },
  "shortcuts.help.menuPick": {
    "zh": "直接选第 N 项",
    "en": "Pick item N"
  },
  "shortcuts.help.menuClose": {
    "zh": "关闭菜单",
    "en": "Close the menu"
  },
  "shortcuts.help.boardNew": {
    "zh": "新任务",
    "en": "New task"
  },
  "shortcuts.help.boardSearch": {
    "zh": "搜索任务",
    "en": "Search tasks"
  },
  "theme.ThemeProvider.usethemeMustBeUsed": {
    "zh": "useTheme 必须在 ThemeProvider 内使用",
    "en": "useTheme must be used within ThemeProvider"
  },
  "usage.format.cliSignIn": {
    "zh": "CLI 登录",
    "en": "CLI sign-in"
  },
  "usage.format.pixelStarrySkyAccount": {
    "zh": "像素星空账号",
    "en": "Pixel Starry Sky account"
  },
  "search.field.title": {
    "zh": "会话标题",
    "en": "Title"
  },
  "search.field.recent": {
    "zh": "最近会话",
    "en": "Recent"
  },
  "search.field.project": {
    "zh": "项目",
    "en": "Project"
  },
  "search.field.user": {
    "zh": "用户消息",
    "en": "Your message"
  },
  "search.field.assistant": {
    "zh": "助手回复",
    "en": "Reply"
  },
  "search.field.notice": {
    "zh": "系统提示",
    "en": "Notice"
  },
  "search.field.command": {
    "zh": "命令",
    "en": "Command"
  },
  "search.field.commandDescription": {
    "zh": "命令说明",
    "en": "Command description"
  },
  "search.field.commandOutput": {
    "zh": "命令输出",
    "en": "Command output"
  },
  "search.field.toolSummary": {
    "zh": "工具摘要",
    "en": "Tool summary"
  },
  "search.field.toolName": {
    "zh": "工具名称",
    "en": "Tool name"
  },
  "search.field.toolOutput": {
    "zh": "工具输出",
    "en": "Tool output"
  },
  "search.field.changedPath": {
    "zh": "修改路径",
    "en": "Changed path"
  },
  "search.field.diff": {
    "zh": "文件改动",
    "en": "File changes"
  },
  "search.field.todo": {
    "zh": "待办",
    "en": "To-do"
  },
  "search.field.removedProject": {
    "zh": "已移除的项目",
    "en": "Removed project"
  },
  "sidebar.SidebarFooter.platformAccount": {
    "zh": "平台账号",
    "en": "Platform account"
  },
  "sidebar.SidebarFooter.notSignedInShort": {
    "zh": "未登录 · 可选",
    "en": "Not signed in · optional"
  },
  "sidebar.SidebarFooter.notSignedInOptional": {
    "zh": "未登录 · 用平台额度时才需要",
    "en": "Not signed in · only needed for platform credits"
  },
  "usage.format.noProject": {
    "zh": "未归属项目",
    "en": "No project"
  }
} as const
export type TranslationKey = keyof typeof catalog
