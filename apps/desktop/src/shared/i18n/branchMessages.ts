// 回退恢复代码、分叉、旁聊、代码评论、都按推荐、截图标注（docs/ui/rewind-fork-sidechat.md）
export const branchMessages = {
  // 回退
  'rewind.hint': {
    zh: '回退到这条消息之前：对话、代码或两者',
    en: 'Go back to before this message: conversation, code, or both',
  },
  'rewind.title': { zh: '回退到这条消息之前', en: 'Rewind to before this message' },
  'rewind.both': { zh: '恢复代码和对话', en: 'Restore code and conversation' },
  'rewind.conversation': { zh: '只恢复对话', en: 'Restore conversation only' },
  'rewind.code': { zh: '只恢复代码', en: 'Restore code only' },
  'rewind.bothDesc': {
    zh: '移除这条消息及之后的对话，文件改回这条消息之前',
    en: 'Remove this message and everything after it, and put files back as they were before it',
  },
  'rewind.conversationDesc': {
    zh: '移除这条消息及之后的对话，文件保持现在的样子',
    en: 'Remove this message and everything after it; files stay as they are',
  },
  'rewind.codeDesc': {
    zh: '对话不动，只把文件改回这条消息之前',
    en: 'Keep the conversation; only put files back as they were before this message',
  },
  'rewind.checking': { zh: '正在检查代码改动…', en: 'Checking code changes…' },
  'rewind.checkingFor': { zh: '正在检查代码改动… {n} 秒', en: 'Checking code changes… {n}s' },
  'rewind.checkingNoWait': {
    zh: '只恢复对话不用等检查，可以直接回退',
    en: 'Restoring only the conversation does not wait for the check',
  },
  'rewind.files': { zh: '还原 {n} 个文件', en: 'Restore {n} files' },
  'rewind.filesOne': { zh: '还原 1 个文件', en: 'Restore 1 file' },
  'rewind.more': { zh: '等 {n} 个', en: 'and {n} more' },
  'rewind.unchanged': { zh: '代码没有变化，无需还原', en: 'The code has not changed; nothing to restore' },
  'rewind.noCheckpoint': {
    zh: '这条消息没有代码检查点（这次更新之前的消息，或者不是 AI 改的），代码保持不变',
    en: 'This message has no code checkpoint (sent before this update, or the files were not changed by the AI); the code stays as it is',
  },
  // GitHub #82：压缩过的会话，压缩之前的消息没有代码检查点
  'rewind.compacted': {
    zh: '这条消息在上下文压缩之前：Claude Code 只保留压缩之后的代码检查点，只能恢复对话，代码保持不变',
    en: 'This message is from before the context was compacted. Claude Code only keeps code checkpoints after the latest compaction, so only the conversation can be restored and the code stays as it is',
  },
  'rewind.codeSkipped': {
    zh: '对话已回退，代码没有恢复：{reason}',
    en: 'The conversation was rewound, but the code was not restored: {reason}',
  },
  'branch.compactedNoCheckpoint': {
    zh: '这条消息在上下文压缩之前，Claude Code 只保留压缩之后的代码检查点，代码保持不变',
    en: 'This message is from before the context was compacted; Claude Code only keeps code checkpoints after the latest compaction, so the code stays as it is',
  },
  'rewind.unsupportedCode': { zh: '这个引擎不能还原代码', en: 'This engine cannot restore code' },
  'rewind.codeFailed': { zh: '无法检查代码改动：{reason}', en: 'Could not check code changes: {reason}' },
  'rewind.overwrite': {
    zh: '这之后你自己对这些文件的修改也会被还原。',
    en: 'Your own edits to these files after this message will be reverted too.',
  },
  'rewind.noUndo': {
    zh: '文件太大（超过 20 MiB），还原后不能撤销代码。',
    en: 'The files are too large (over 20 MiB); restoring the code cannot be undone.',
  },
  'rewind.undoHint': {
    zh: '回退后可以撤销，直到发出下一条消息。',
    en: 'You can undo until you send the next message.',
  },
  'rewind.confirm': { zh: '回退', en: 'Rewind' },
  'rewind.skip': { zh: '只恢复对话时不再确认', en: "Don't ask again when only restoring the conversation" },
  'rewind.done': { zh: '已回退', en: 'Rewound' },
  'rewind.doneFiles': { zh: '已回退 · 还原了 {n} 个文件', en: 'Rewound · restored {n} files' },
  'rewind.doneCode': { zh: '已还原 {n} 个文件', en: 'Restored {n} files' },
  'rewind.undo': { zh: '撤销', en: 'Undo' },
  'rewind.undone': { zh: '已撤销回退', en: 'Rewind undone' },
  'rewind.dismiss': { zh: '关闭', en: 'Dismiss' },
  'rewind.attachmentsDropped': {
    zh: '原消息有 {n} 个附件没有放回输入框：加上输入框里已有的会超过附件上限',
    en: '{n} attachments from the original message were not put back: the input box would go over the attachment limit',
  },

  // 分叉
  'fork.action': { zh: '分叉', en: 'Fork' },
  'fork.hint': {
    zh: '在新会话中从这条消息之前继续，当前会话保留',
    en: 'Continue from before this message in a new session; this session stays as it is',
  },
  'fork.unsupported': { zh: '当前引擎暂不支持分叉', en: 'The current engine does not support forking yet' },
  'fork.from': { zh: '分叉自「{title}」', en: 'Forked from “{title}”' },
  'fork.titleSuffix': { zh: '（分支）', en: ' (fork)' },

  // 旁聊
  'side.title': { zh: '旁聊', en: 'Side chat' },
  'side.open': { zh: '打开旁聊', en: 'Open side chat' },
  'side.hint': {
    zh: '就当前对话问个小问题：不打断主任务，不进入主对话，不能读文件或运行命令。',
    en: "Ask a quick question about this conversation. It doesn't interrupt the main task, isn't added to the conversation, and can't read files or run commands.",
  },
  'side.placeholder': { zh: '问点什么…', en: 'Ask something…' },
  'side.send': { zh: '提问', en: 'Ask' },
  'side.answering': { zh: '正在回答…', en: 'Answering…' },
  'side.stop': { zh: '停止', en: 'Stop' },
  'side.clear': { zh: '清空', en: 'Clear' },
  'side.close': { zh: '关闭旁聊', en: 'Close side chat' },
  'side.empty': { zh: '还没有问题。', en: 'No questions yet.' },
  'side.needMessage': { zh: '先在主对话里发一条消息', en: 'Send a message in the conversation first' },
  'side.busy': {
    zh: '上一个旁聊问题还在回答，答完再问',
    en: 'The previous side chat question is still being answered; ask again when it finishes',
  },
  'side.unsupported': { zh: '当前引擎暂不支持旁聊', en: 'The current engine does not support side chat yet' },
  'side.copy': { zh: '复制回答', en: 'Copy answer' },
  'side.note': { zh: '只保存在这个窗口里，关掉就没了。', en: 'Kept in this window only; gone when you close it.' },

  // 代码评论
  'review.add': { zh: '评论这一行', en: 'Comment on this line' },
  'review.placeholder': {
    zh: '要改什么？Ctrl+Enter 保存，Esc 取消',
    en: 'What should change? Ctrl+Enter to save, Esc to cancel',
  },
  'review.save': { zh: '保存', en: 'Save' },
  'review.cancel': { zh: '取消', en: 'Cancel' },
  'review.edit': { zh: '编辑', en: 'Edit' },
  'review.delete': { zh: '删除', en: 'Delete' },
  'review.count': { zh: '{n} 条代码评论', en: '{n} code comments' },
  'review.countOne': { zh: '1 条代码评论', en: '1 code comment' },
  'review.handoff': { zh: '交给 AI', en: 'Send to AI' },
  'review.clear': { zh: '清空', en: 'Clear' },
  'review.started': { zh: '已交给 AI：开始了新的一轮', en: 'Sent to AI: a new turn started' },
  'review.queued': { zh: '已交给 AI：排在队列里', en: 'Sent to AI: queued' },
  'review.failed': { zh: '没交出去：{reason}', en: 'Not sent: {reason}' },
  'review.line': { zh: '第 {n} 行', en: 'line {n}' },
  'review.removedLine': { zh: '第 {n} 行（已删除的行）', en: 'line {n} (removed line)' },
  'review.messageIntro': { zh: '请处理这些代码评论：', en: 'Please address these code review comments:' },

  // 提问卡片
  'question.recommended': { zh: '推荐', en: 'Recommended' },
  'question.allRecommended': { zh: '都按推荐', en: 'Use all recommendations' },
  'question.other': { zh: '其他…', en: 'Other…' },
  'question.otherPlaceholder': { zh: '输入你的回答', en: 'Type your answer' },
  'session.live.ApprovalCard.sendFailed': {
    zh: '没发出去：{p0}。可以再点一次。',
    en: 'Not sent: {p0}. You can try again.',
  },

  // 截图标注
  'annotate.open': { zh: '标注', en: 'Annotate' },
  'annotate.title': { zh: '标注图片', en: 'Annotate image' },
  'annotate.box': { zh: '框', en: 'Box' },
  'annotate.arrow': { zh: '箭头', en: 'Arrow' },
  'annotate.text': { zh: '文字', en: 'Text' },
  'annotate.color': { zh: '颜色', en: 'Color' },
  'annotate.red': { zh: '红色', en: 'Red' },
  'annotate.orange': { zh: '橙色', en: 'Orange' },
  'annotate.yellow': { zh: '黄色', en: 'Yellow' },
  'annotate.blue': { zh: '蓝色', en: 'Blue' },
  'annotate.size': { zh: '粗细', en: 'Size' },
  'annotate.small': { zh: '小', en: 'Small' },
  'annotate.medium': { zh: '中', en: 'Medium' },
  'annotate.large': { zh: '大', en: 'Large' },
  'annotate.undo': { zh: '撤销', en: 'Undo' },
  'annotate.original': { zh: '用原图', en: 'Use original' },
  'annotate.cancel': { zh: '取消', en: 'Cancel' },
  'annotate.done': { zh: '完成', en: 'Done' },
  'annotate.textPlaceholder': { zh: '输入文字，回车结束', en: 'Type, then press Enter' },
  'annotate.discard': { zh: '放弃这些标注？', en: 'Discard these annotations?' },
  'annotate.discardConfirm': { zh: '放弃', en: 'Discard' },
  'annotate.keep': { zh: '继续标注', en: 'Keep annotating' },
  'annotate.tooLarge': { zh: '标注后的图片超过 10 MiB', en: 'The annotated image is larger than 10 MiB' },

  // 引擎报的错（中文原文 → 英文）
  'branch.pickSomething': { zh: '请选择要恢复的内容', en: 'Choose what to restore' },
  'branch.noCheckpoint': {
    zh: '这条消息没有代码检查点，代码保持不变',
    en: 'This message has no code checkpoint; the code stays as it is',
  },
  'branch.restoreFailed': { zh: '没能还原代码', en: 'Could not restore the code' },
  'branch.undoStale': {
    zh: '回退之后有了新的对话，不能撤销了',
    en: 'The conversation has continued since the rewind, so it can no longer be undone',
  },
  'branch.forkUnsupported': { zh: '当前引擎暂不支持分叉', en: 'The current engine does not support forking yet' },
  'branch.sideUnsupported': { zh: '当前引擎暂不支持旁聊', en: 'The current engine does not support side chat yet' },
  'branch.needMessage': { zh: '先在主对话里发一条消息', en: 'Send a message in the conversation first' },
  'branch.emptyQuestion': { zh: '请输入问题', en: 'Enter a question' },
  'branch.noTranscript': { zh: '这个会话还没有 Claude Code 记录', en: 'This session has no Claude Code history yet' },
  'branch.sideTimeout': { zh: '旁聊超时（5 分钟）', en: 'Side chat timed out (5 minutes)' },
  'branch.stopped': { zh: '已停止', en: 'Stopped' },
  'branch.noAnswer': { zh: 'Claude Code 没有回答', en: 'Claude Code did not answer' },
  'branch.answerFailed': { zh: 'Claude Code 回答失败', en: 'Claude Code failed to answer' },
  'branch.forkFailed': {
    zh: '无法从原会话分叉，已开始新的引擎会话（之前的上下文没有带过去）',
    en: 'Could not fork from the original session. Started a new engine session without the previous context.',
  },
  'branch.compactedAnchor': {
    zh: '这条消息在上下文压缩之前，Claude Code 没法从这里接着，已开始新的引擎会话（之前的上下文没有带过去）',
    en: 'This message is from before a context compaction, so Claude Code cannot continue from here. Started a new engine session without the previous context.',
  },
  'branch.forkMissing': {
    zh: '无法在 {p0} 记录中找到这条消息，分叉出的会话没有带上之前的上下文',
    en: 'Could not find this message in {p0} history; the forked session does not include the previous context',
  },
} as const
