// 执行机（docs/multica-learn.md §11.7）：机器页的执行机一行、成员设置的「团队活由谁接」，
// 以及主进程（channels/runner.ts、runner/install.ts、core/channels/service.ts）报的错误（中文原文认得出，界面用 translateMessage 翻）
export const runnerMessages = {
  // ── 机器页 ──
  'runner.title': { zh: '执行机', en: 'Runner' },
  'runner.intro': {
    zh: '设为执行机后，这台机器常驻一个后台服务接团队活，这台电脑关了也照样接。只接你指定由它接的 AI 成员的活，用这台机器上自己登录的 Claude Code / Codex。',
    en: 'As a runner, this machine keeps a background service that takes team work even when this computer is off. It only takes work for the AI members you point at it, using the Claude Code / Codex signed in on that machine.',
  },
  'runner.install': { zh: '设为执行机', en: 'Make it a runner' },
  'runner.reinstall': { zh: '重新安装', en: 'Reinstall' },
  'runner.remove': { zh: '停用', en: 'Turn off' },
  'runner.removeTitle': { zh: '停用这台执行机？', en: 'Turn off this runner?' },
  'runner.removeBody': {
    zh: '由它接的 AI 成员改回这台电脑接，它手上在做的活会被判失败。机器上的会话和副本留着。',
    en: 'AI members it handles go back to this computer, and work in progress on it is marked as failed. Sessions and copies on the machine are kept.',
  },
  'runner.installing': { zh: '正在安装…', en: 'Installing…' },
  'runner.online': { zh: '在线', en: 'Online' },
  'runner.offline': { zh: '离线', en: 'Offline' },
  'runner.load': { zh: '在做 {running} 件，排着 {queued} 件', en: '{running} running, {queued} queued' },
  'runner.members': { zh: '由它接的成员：{count} 个', en: 'Members it handles: {count}' },
  'runner.noMembers': {
    zh: '还没有成员由它接：在成员设置里把「团队活由谁接」改成这台执行机。',
    en: 'No members use it yet: in a member’s settings, set “Who takes team work” to this runner.',
  },
  'runner.linger': {
    zh: '重启机器后要先登录一次它才会起来。想让它自己起来，在那台机器上运行：sudo loginctl enable-linger {user}',
    en: 'After the machine restarts, it only starts once someone logs in. To start it on boot, run on that machine: sudo loginctl enable-linger {user}',
  },
  'runner.notMine': {
    zh: '这台执行机是另一台电脑装的，设置由那台电脑推。',
    en: 'Another computer installed this runner, so that computer sends its settings.',
  },
  'runner.revoked': {
    zh: '执行机的登录失效了（被停用或在别处重新配对过），点「重新安装」。',
    en: 'The runner’s sign-in is no longer valid (turned off, or paired again elsewhere). Click Reinstall.',
  },
  'runner.seats': {
    zh: '团队的执行机席位满了，这台没连上。',
    en: 'The team has no free runner seats, so this one is not connected.',
  },
  'runner.needConnect': {
    zh: '连上这台机器后才能安装或查看状态。',
    en: 'Connect to this machine to install it or see its status.',
  },
  'runner.needLinux': { zh: '执行机第一版只支持 Linux。', en: 'Runners only support Linux for now.' },
  'runner.failed': { zh: '没成功：{error}', en: 'Failed: {error}' },

  // ── 成员设置 ──
  'runner.member.label': { zh: '团队活由谁接', en: 'Who takes team work' },
  'runner.member.desktop': { zh: '这台电脑', en: 'This computer' },
  'runner.member.runner': { zh: '{name} 上的执行机', en: 'Runner on {name}' },
  'runner.member.hint': {
    zh: '执行机上每项活新开会话、需要审批的操作一律拒绝，平台额度和自定义接口用不了。',
    en: 'On the runner every job starts a new session, actions that need approval are denied, and platform credits and custom APIs are unavailable.',
  },

  // ── 主进程报的错 ──
  'runner.error.notReady': { zh: '机器还没有就绪', en: 'Machines are not ready yet' },
  'runner.error.machine': { zh: '机器不存在', en: 'Machine not found' },
  'runner.error.connect': { zh: '先连上这台机器', en: 'Connect to this machine first' },
  'runner.error.linux': { zh: '执行机第一版只支持 Linux', en: 'Runners only support Linux for now' },
  'runner.error.busy': { zh: '正在处理，请稍候', en: 'Working on it, please wait' },
  'runner.error.data': { zh: '执行机返回的数据异常', en: 'The runner returned unexpected data' },
  'runner.error.member': { zh: '成员不存在', en: 'Member not found' },
  'runner.error.notRunner': { zh: '成员所在的机器还没设为执行机', en: 'The member’s machine is not a runner yet' },
  'runner.error.engine': {
    zh: '执行机上只能跑 Claude Code / Codex 的成员',
    en: 'Only Claude Code / Codex members can run on a runner',
  },
  'runner.error.systemd': {
    zh: '这台机器没有 systemd 用户服务（容器里或没开 systemd 的 WSL 不行）',
    en: 'This machine has no systemd user services (containers and WSL without systemd do not work)',
  },
  'runner.error.notInstaller': {
    zh: '这台执行机是另一台电脑装的，只认那台电脑的设置',
    en: 'Another computer installed this runner; it only accepts that computer’s settings',
  },
  'runner.error.config': { zh: '执行机配置不对', en: 'The runner settings are invalid' },
  'runner.error.params': { zh: '执行机配对参数不对', en: 'The runner pairing input is invalid' },
} as const
