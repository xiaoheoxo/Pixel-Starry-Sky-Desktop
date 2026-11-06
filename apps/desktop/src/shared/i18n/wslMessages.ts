// WSL 模式界面文案（wsl-mode.plan.md §3）：「本机」下拉、检查卡片、侧栏说明、/mnt/ 提示
const WINDOWS_PATH =
  '找到的是 Windows 程序：WSL 把 Windows 的 PATH 也带进来了，能跑但会按 Windows 处理路径，出奇怪的错。要在 WSL 里装 Linux 版：'
const WINDOWS_PATH_EN =
  'This is a Windows program: WSL also brings in the Windows PATH. It runs but treats paths the Windows way and fails oddly. Install the Linux build in WSL:'
const OPTIONAL = {
  zh: '可选，没装也能用文件、Git、终端。要用就在 WSL 里装：',
  en: 'Optional; files, Git and the terminal work without it. To use it, install in WSL:',
}

export const wslMessages = {
  'wsl.menu.title': { zh: '这台电脑', en: 'This computer' },
  'wsl.menu.windows': { zh: 'Windows', en: 'Windows' },
  'wsl.menu.windowsSub': { zh: 'D:\\ · C:\\ 上的项目', en: 'Projects on D:\\ · C:\\' },
  'wsl.menu.distro': { zh: 'WSL · {name}', en: 'WSL · {name}' },
  'wsl.menu.recheck': { zh: '重新检测 WSL', en: 'Detect WSL again' },
  'wsl.menu.note': {
    zh: '列表只读名字和状态，不会为了显示它去启动 WSL；选中未运行的才启动并检查。docker-desktop 不列出。',
    en: 'The list only reads names and states and never starts WSL just to show it. Choosing a stopped one starts and checks it. docker-desktop is not listed.',
  },
  'wsl.menu.needsPrep': { zh: '需要准备', en: 'Needs setup' },
  // 状态行（switchModel 的 wslStatusLine）
  'wsl.status.connected': { zh: '运行中 · 可以用', en: 'Running · ready' },
  'wsl.status.connectedVersion': { zh: '运行中 · {version} · 可以用', en: 'Running · {version} · ready' },
  'wsl.status.connecting': { zh: '正在启动 WSL…', en: 'Starting WSL…' },
  'wsl.status.runningOk': { zh: '运行中 · 上次检查通过', en: 'Running · last check passed' },
  'wsl.status.stoppedOk': { zh: '未运行 · 上次检查通过', en: 'Stopped · last check passed' },
  'wsl.status.runningFailed': { zh: '运行中 · 上次检查：{problem}', en: 'Running · last check: {problem}' },
  'wsl.status.stoppedFailed': { zh: '未运行 · 上次检查：{problem}', en: 'Stopped · last check: {problem}' },
  'wsl.status.runningNever': { zh: '运行中 · 还没检查过', en: 'Running · not checked yet' },
  'wsl.status.stoppedNever': { zh: '未运行 · 还没检查过', en: 'Stopped · not checked yet' },
  'wsl.status.error': { zh: '出错 · {error}', en: 'Error · {error}' },
  // 没过的必需项的短说明
  'wsl.problem.start': { zh: '启动失败', en: 'start failed' },
  'wsl.problem.node': { zh: '缺 node 22', en: 'needs node 22' },
  'wsl.problem.NODE_MISSING': { zh: '缺 node 22', en: 'needs node 22' },
  'wsl.problem.NODE_OLD': { zh: '缺 node 22', en: 'needs node 22' },
  'wsl.problem.NODE_BROKEN': { zh: '缺 node 22', en: 'needs node 22' },
  'wsl.problem.NODE_WINDOWS': { zh: '缺 node 22', en: 'needs node 22' },
  // 检查卡片
  'wsl.card.title': { zh: '准备 WSL · {name}', en: 'Set up WSL · {name}' },
  'wsl.card.intro': {
    zh: '第一次在这个发行版里用像素星空，先检查需要的东西：',
    en: 'First time using PixelSky in this distro. Checking what it needs:',
  },
  'wsl.card.empty': { zh: '还没检查过，点「重新检查」。', en: 'Not checked yet. Press Check again.' },
  'wsl.card.close': { zh: '关闭', en: 'Close' },
  'wsl.card.terminal': { zh: '打开 WSL 终端', en: 'Open WSL terminal' },
  'wsl.card.recheck': { zh: '重新检查', en: 'Check again' },
  'wsl.card.start': { zh: '开始使用', en: 'Start using' },
  'wsl.card.nodeHint': { zh: '已经用 nvm / fnm / volta 装过？', en: 'Installed with nvm / fnm / volta?' },
  'wsl.card.nodeSet': { zh: '指定 node 的位置', en: 'Set the node location' },
  'wsl.card.nodeLabel': { zh: 'WSL 里 node 的路径', en: 'Path of node inside WSL' },
  'wsl.card.nodePlaceholder': {
    zh: '/home/你/.nvm/versions/node/v22/bin/node',
    en: '/home/you/.nvm/versions/node/v22/bin/node',
  },
  'wsl.card.nodeSave': { zh: '保存并检查', en: 'Save and check' },
  'wsl.card.nodeClear': { zh: '清除', en: 'Clear' },
  'wsl.item.start': { zh: '启动 WSL', en: 'Start WSL' },
  'wsl.item.encoding': { zh: '中文编码', en: 'Text encoding' },
  'wsl.item.node': { zh: 'node 22 以上（Linux 版）', en: 'node 22+ (Linux build)' },
  'wsl.item.claude': { zh: 'Claude Code', en: 'Claude Code' },
  'wsl.item.codex': { zh: 'Codex', en: 'Codex' },
  'wsl.item.pixel': { zh: 'Pixel 引擎（自带）', en: 'Pixel engine (built in)' },
  'wsl.item.login': { zh: '登录', en: 'Login' },
  'wsl.login.none': { zh: '还没登录', en: 'Not signed in' },
  'wsl.login.some': { zh: '已登录：{who}', en: 'Signed in: {who}' },
  // 原因：short 放在项右侧，reason 放在项下面
  'wsl.short.ENCODING_NOT_UTF8': {
    zh: '原来是 {charmap}，像素星空里改用 C.UTF-8',
    en: 'Was {charmap}; PixelSky uses C.UTF-8',
  },
  'wsl.short.ENCODING_UNKNOWN': { zh: '读不到编码，改用 C.UTF-8', en: 'Unknown; PixelSky uses C.UTF-8' },
  'wsl.short.NODE_MISSING': { zh: '没找到', en: 'Not found' },
  'wsl.short.NODE_OLD': { zh: '现在是 {version}', en: 'Currently {version}' },
  'wsl.short.NODE_BROKEN': { zh: '跑不起来', en: 'Does not run' },
  'wsl.short.NODE_WINDOWS': { zh: '只找到 Windows 版', en: 'Only a Windows build' },
  'wsl.short.CLAUDE_MISSING': { zh: '没装', en: 'Not installed' },
  'wsl.short.CLAUDE_WINDOWS': { zh: '找到的是 Windows 程序', en: 'Found a Windows program' },
  'wsl.short.CODEX_MISSING': { zh: '没装', en: 'Not installed' },
  'wsl.short.CODEX_WINDOWS': { zh: '找到的是 Windows 程序', en: 'Found a Windows program' },
  'wsl.short.PIXEL_NODE_OLD': { zh: 'node 是 {version}，要 22.19 以上', en: 'node is {version}; needs 22.19+' },
  'wsl.short.PIXEL_ARCH': { zh: '不支持这个架构', en: 'Unsupported architecture' },
  'wsl.short.WSL_HOME_EMPTY': { zh: '读不到主目录', en: 'Home directory unknown' },
  'wsl.reason.WSL_HOME_EMPTY': {
    zh: '读不到这个发行版里的用户主目录，请先在 WSL 里打开一次完成初始化。',
    en: "Could not read the user's home directory in this distro. Open it in WSL once to finish setup.",
  },
  'wsl.reason.WSL_START_FAILED': {
    zh: '启动超时或失败。第一次用这个发行版，先在终端里打开一次，完成创建用户。',
    en: 'Start timed out or failed. If this distro is new, open it once in a terminal and finish creating a user.',
  },
  'wsl.reason.NODE_MISSING': {
    zh: '需要 Linux 版 node 22 以上，在 WSL 里装：',
    en: 'Needs a Linux node 22+. Install it in WSL:',
  },
  'wsl.reason.NODE_OLD': {
    zh: '需要 22 以上，在 WSL 里装新版：',
    en: 'Needs 22 or newer. Install a newer one in WSL:',
  },
  'wsl.reason.NODE_BROKEN': {
    zh: '找到了 node 但跑不起来，重装一个：',
    en: 'A node was found but does not run. Reinstall:',
  },
  'wsl.reason.NODE_WINDOWS': {
    zh: '只找到 Windows 版 node（在 /mnt/ 下）。要在 WSL 里装 Linux 版：',
    en: 'Only a Windows node (under /mnt/) was found. Install the Linux build inside WSL:',
  },
  'wsl.reason.CLAUDE_MISSING': OPTIONAL,
  'wsl.reason.CLAUDE_WINDOWS': { zh: WINDOWS_PATH, en: WINDOWS_PATH_EN },
  'wsl.reason.CODEX_MISSING': OPTIONAL,
  'wsl.reason.CODEX_WINDOWS': { zh: WINDOWS_PATH, en: WINDOWS_PATH_EN },
  'wsl.reason.PIXEL_NODE_OLD': {
    zh: '自带的 Pixel 引擎要 node 22.19 以上，现在的版本用不了它（别的照常能用）。在 WSL 里装新版：',
    en: 'The built-in Pixel engine needs node 22.19 or newer, so it isn’t available with this version (everything else still works). Install a newer one in WSL:',
  },
  'wsl.reason.PIXEL_ARCH': {
    zh: '自带的 Pixel 引擎只支持 x64 和 arm64，这个发行版里用不了它（别的照常能用）。',
    en: 'The built-in Pixel engine supports only x64 and arm64, so it isn’t available in this distro (everything else still works).',
  },
  'wsl.reason.login': {
    zh: '用平台额度不用登录；用自有额度要在 WSL 终端里运行 claude / codex login 单独登录（Windows 上的登录带不进 WSL）。',
    en: 'Platform credit needs no login. With your own quota, run claude / codex login in a WSL terminal; a Windows login does not carry over.',
  },
  // 侧栏说明条
  'wsl.hint.text': {
    zh: '这是 WSL · {name} 里的项目和对话，和 Windows 上的分开记。切回 Windows 照旧。',
    en: 'These are the projects and conversations inside WSL · {name}, kept apart from Windows. Switch back to Windows as before.',
  },
  'wsl.hint.dismiss': { zh: '关闭说明', en: 'Dismiss' },
  // 添加项目
  'wsl.mntHint': {
    zh: '放在 WSL 自己的目录（/home/...）里会快很多',
    en: 'Projects in WSL’s own folders (/home/...) are much faster',
  },
} as const
