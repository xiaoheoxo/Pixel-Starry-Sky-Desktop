// 宿主错误代码的文案（docs/ui/files-search-terminal-pins.md §1）：key 为 errors.<code>，
// 主进程 / 引擎用 codedError(code, params) 抛出，界面 translateMessage 按代码查这里。
export const errorMessages = {
  'errors.files.relativePath': { zh: '请使用项目内的相对路径', en: 'Use a path inside the project' },
  'errors.files.outsideProject': { zh: '文件路径超出项目', en: 'The path is outside the project' },
  'errors.files.notFound': { zh: '文件或目录已不存在', en: 'The file or folder no longer exists' },
  'errors.files.changedOutside': {
    zh: '文件已被其他程序修改，请重新加载后再保存；当前草稿仍保留',
    en: 'The file was changed by another program. Reload before saving; your draft is kept',
  },
  'errors.files.exists': {
    zh: '已经有同名的文件或文件夹：{name}',
    en: 'A file or folder named {name} already exists',
  },
  'errors.files.invalidName': {
    zh: '名称不能为空，也不能包含 / \\ : * ? " < > |',
    en: 'Names can’t be empty or contain / \\ : * ? " < > |',
  },
  'errors.files.parentMissing': { zh: '上级文件夹不存在', en: 'The parent folder doesn’t exist' },
  'errors.files.projectRoot': { zh: '不能修改项目根目录本身', en: 'The project folder itself can’t be changed' },
  'errors.files.trashFailed': { zh: '没能移到回收站：{reason}', en: 'Couldn’t move to the trash: {reason}' },
  'errors.files.busy': {
    zh: '{name} 被别的程序占用，关掉后再试',
    en: '{name} is in use by another program. Close it and try again',
  },
  'errors.files.crossDevice': {
    zh: '不能移到另一个磁盘上的位置',
    en: 'Can’t move to a location on another disk',
  },
  'errors.files.queryInvalid': { zh: '搜索内容为空或太长', en: 'The search text is empty or too long' },
  'errors.terminal.scriptNotFound': { zh: '找不到脚本：{name}', en: 'Script not found: {name}' },
  'errors.terminal.commandInvalid': { zh: '要运行的命令不正确', en: 'The command to run is invalid' },
  'errors.tasks.notFound': { zh: '任务已不存在', en: 'The task no longer exists' },
  // 取消授权后引擎仍然可用（docs/ui/model-channels.md §3）
  'errors.engine.logoutProvider': {
    zh: '{engine} 没有登录账号，用的是 config.toml 里配置的接口「{provider}」，在这里取消不了。要停用它，去掉配置里的 model_provider',
    en: '{engine} isn’t signed in to an account. It uses the “{provider}” provider set in config.toml, which can’t be removed here. To stop using it, remove model_provider from the config',
  },
  'errors.engine.logoutStillReady': {
    zh: '已取消授权，但 {engine} 仍然可用：它可能在用环境变量里的 API Key 或自己配置的接口',
    en: 'Signed out, but {engine} still works. It may be using an API key from an environment variable or its own provider settings',
  },
  // 引擎启动方式（docs/ui/engine-launch.md §3）
  'errors.launch.notFound': {
    zh: '找不到「{command}」：请填绝对路径或 PATH 上的命令名',
    en: 'Can’t find “{command}”. Enter an absolute path or a command on PATH',
  },
  'errors.launch.notAbsolute': {
    zh: '「{command}」不是绝对路径：带目录的命令要写完整路径',
    en: '“{command}” isn’t an absolute path. A command with a folder needs the full path',
  },
  'errors.launch.script': {
    zh: '「{path}」不能直接启动：Windows 上的 .cmd、.bat、.ps1 要经过 cmd.exe，参数会被改坏。请指向 .exe',
    en: '“{path}” can’t be launched directly. On Windows, .cmd, .bat and .ps1 files run through cmd.exe, which mangles arguments. Point to an .exe instead',
  },
  'errors.launch.reserved': {
    zh: '「{arg}」由像素星空控制，不能在这里改',
    en: '“{arg}” is controlled by Pixel Starry Sky and can’t be set here',
  },
  'errors.env.reserved': {
    zh: '{name} 不能在环境变量里新增或修改：接口地址和 Key 请在「设置 › 模型与额度 › 自定义 API」里配置',
    en: '{name} can’t be added or changed here. Configure base URLs and keys under Settings › Models & credits › Custom API',
  },
  'errors.launch.firstArg': {
    zh: '参数要以选项开头（- 或 --），「{arg}」不是选项',
    en: 'Arguments must start with an option (- or --); “{arg}” isn’t one',
  },
  'errors.launch.invalidArgs': { zh: '启动参数的格式不对', en: 'The launch arguments are invalid' },
  'errors.launch.argsTooLong': {
    zh: '启动参数太多或太长（最多 100 个，每个不超过 4000 字）',
    en: 'Too many or too long launch arguments (up to 100, each at most 4000 characters)',
  },
  'errors.resume.live': {
    zh: '终端或别的程序里正开着这个会话，不能直接往里写',
    en: 'This session is open in the terminal or another program, so it can’t be written to directly',
  },
  // 队列调序时被挪的消息或锚点已不在队里（docs/ui/message-queue.md）
  'errors.queue.changed': {
    zh: '队列已变化，排序未保存',
    en: 'The queue changed, so the new order wasn’t saved',
  },
} as const
