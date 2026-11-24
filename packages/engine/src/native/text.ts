// 导入 / 补上本机会话时放进对话的提示文字（不分引擎；引擎名由调用方传入，不传按 Claude Code）。
/** 导入时放进对话的提示文字（引擎发的中文，界面靠 shared/i18n/systemMessages.ts 翻译；数字原样写在句子里） */
export const NATIVE_TEXT = {
  relayRun: (turns: number) => `以下 ${turns} 轮是在像素星空里用别的引擎聊的，接力时写进了这个会话`,
  handoff: '这一轮带着像素星空的交接材料',
  /** Codex 版：VS Code 扩展加在用户话前面的编辑器上下文 */
  ideContext: '这一轮带着编辑器的上下文',
  /** 读不到 Codex 的会话（没装好 / app-server 起不来）；后面可以接冒号和原因 */
  codexUnavailable: 'Codex 没装好，读不到它的会话',
  codexMissing: 'Codex 没装好，读不到它的会话：没找到 Codex 命令行程序（只装 Codex 桌面版不够）',
  codexOutdated: (version: string, min: string) => `Codex 没装好，读不到它的会话：版本 ${version} 太旧，要 ${min} 以上`,
  codexBroken: 'Codex 没装好，读不到它的会话：找到了 Codex，但启动不了或读不出版本号',
  codexCustom: 'Codex 没装好，读不到它的会话：设置里指定的 Codex 用不了',
  gap: (turns: number) => `中间还有 ${turns} 轮没有显示`,
  images: (count: number) => `（${count} 张图片没有导入）`,
  /** 对话最上面的分隔条；missing 是还没显示的更早的轮数 */
  divider: (
    source: 'terminal' | 'other',
    copy: boolean,
    turns: number,
    missing: number,
    engine = 'Claude Code',
    /** 旧格式的线程（Codex）：不能原地回退，一律复制成新线程 */
    legacy = false,
  ): string => {
    const where = source === 'terminal' ? '终端里' : '其他程序'
    const base = copy
      ? legacy
        ? `复制了${where}的 ${engine} 会话 · ${turns} 轮（旧格式的线程不能原地回退，复制成新线程接着聊，原会话不动）`
        : `复制了${where}的 ${engine} 会话 · ${turns} 轮（原会话不动，两边可以同时用）`
      : source === 'terminal'
        ? `接着终端里的 ${engine} 会话 · ${turns} 轮`
        : `接着 ${engine} 会话（来自其他程序）· ${turns} 轮`
    return missing > 0 ? `${base}（更早的 ${missing} 轮没有显示）` : base
  },
  /** 加载更早的越过压缩边界时，放在压缩条目上面 */
  summaryOnly: '以上是压缩之前的轮次，模型只看到压缩摘要',
  newer: (turns: number) => `这个会话在终端里又聊了 ${turns} 轮，显示里还没有`,
  synced: (turns: number) => `已补上终端里的 ${turns} 轮`,
  /** 从终端（TUI）模式切回时补上的分隔（docs/ui/tui-toggle.md §3.3） */
  tuiSynced: (turns: number) => `在终端里聊了 ${turns} 轮 · 已补上`,
  gone: '这个会话的记录已经不在了',
  /** Codex 读取进程被关掉了（更新 / 安装 Codex、换了 Codex 的位置、应用退出）时，排队的读取请求被拒绝 */
  codexReaderClosed: 'Codex 正在更新或已重新检测，读取被中断了，请重试',
  /** 原地导入的对话已经不接着原会话了（回退换了新线程、换了引擎），不能再「复制一份」 */
  notFollowing: '这个对话已经不接着原来的会话了，没法再复制一份',
  /** 复制一份接着聊要从一轮已结束的轮次分叉，线程里一轮结束的都没有 */
  nothingToCopy: '这个会话还没有聊完的一轮，没法复制',
  /** Codex 版：线程是像素星空以前用过的，换引擎时注入的聊天 app-server 读不出来 */
  pixelskyThread: '这个线程以前在像素星空里用过，换引擎时带过去的聊天不会显示，模型照样看得到',
  cancelled: '已取消导入',
  earlierGone: '这个会话的记录已经不在了，更早的没法再加载',
  unsupported: '这个引擎不支持接着本机会话',
  /** 原生记录不在了，接力把像素星空里的聊天写进新的引擎会话 */
  recreated: (turns: number, engine = 'Claude Code') =>
    `${engine} 的会话记录不在了，已把像素星空里的聊天（${turns} 轮）写进新的引擎会话（工具调用和文件改动没有带过去）`,
  /** 原生会话接不上了（恢复 / 回退 / 分叉失败），改开了新会话，把像素星空里的聊天带了过去 */
  resumeLost: (turns: number, engine = 'Claude Code') =>
    `没能接上原来的 ${engine} 会话，已改开新的引擎会话，并把像素星空里的聊天（${turns} 轮）带了过去（工具调用和文件改动没有带过去）`,
  /** 目标模式（Codex /goal，docs/ui/codex-goal.md） */
  goalSet: (objective: string, engine = 'Codex') =>
    `已设目标：${objective}。${engine} 会一轮接一轮地做，直到完成；输入 /goal pause 暂停，/goal clear 清除`,
  goalWaiting: 'Codex 已经记下目标，会自己接着做',
  goalNone: '这个对话没有目标。输入 /goal 加上要达成的目标来设一个',
  goalShow: (objective: string, status: string) => `当前目标（${status}）：${objective}`,
  goalPaused: '目标已暂停',
  goalResumed: '目标继续进行',
  goalCleared: '目标已清除',
  goalComplete: (objective: string) => `目标已完成：${objective}`,
  goalBlocked: (objective: string) => `目标卡住了，Codex 需要你帮忙：${objective}`,
  goalUsageLimited: '额度用完了，目标先停下',
  goalBudgetLimited: '目标的 token 预算用完了',
  goalUnsupported: '这个 Codex 版本没有目标模式（/goal），请更新到 0.128 以上',
  ompGoalUnsupported: '这个 oh-my-pi 版本没有目标模式（/goal），请在终端运行 omp update',
  ompGoalPlan: '先退出计划模式，再设目标或继续目标',
  ompGoalCost: '目标会一轮接一轮地做，一直用平台额度，直到完成或你停下；输入 /goal pause 暂停',
  ompGoalIdle: '这一轮没有新的进展，oh-my-pi 先停下了，目标还在；发一条消息就接着做，或者 /goal clear 清除',
  ompGoalHeld: '设置改了，oh-my-pi 换了进程，目标先停下；发一条消息后接着做',
  goalImages: '目标只能是文字，/goal 不能带图片',
  goalStatus: {
    active: '进行中',
    paused: '已暂停',
    blocked: '卡住了',
    usageLimited: '额度用完',
    budgetLimited: '预算用完',
    complete: '已完成',
  },
  /** 原生会话接不上、发的是 /compact，之前的聊天又注不进新会话：这次不压缩，下一条普通消息再带过去 */
  compactSkipped: (engine = 'Claude Code') =>
    `没能接上原来的 ${engine} 会话，之前的聊天也没能放进新的引擎会话，这次没有压缩；下一条消息会把像素星空里的聊天带过去`,
} as const
