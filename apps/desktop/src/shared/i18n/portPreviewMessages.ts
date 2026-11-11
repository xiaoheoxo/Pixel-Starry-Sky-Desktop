// 对话里发现本机端口的提示条、浏览器面板空状态的端口入口（docs/ui/port-preview.md）
export const portPreviewMessages = {
  'portTip.one': { zh: '发现本机页面', en: 'Local page found' },
  'portTip.many': { zh: '发现 {n} 个本机页面', en: '{n} local pages found' },
  'portTip.open': { zh: '在内置浏览器打开', en: 'Open in built-in browser' },
  'portTip.openPort': { zh: '打开 :{port}', en: 'Open :{port}' },
  'portTip.opened': { zh: '已在内置浏览器打开', en: 'Opened in the built-in browser' },
  'portTip.show': { zh: '显示', en: 'Show' },
  'portTip.copy': { zh: '复制地址', en: 'Copy address' },
  'portTip.ignore': { zh: '忽略', en: 'Dismiss' },
  'portTip.ignoreAll': { zh: '全部忽略', en: 'Dismiss all' },
  // 提示条的「⋯」和总开关（docs/ui/port-preview.md §7）
  'portTip.more': { zh: '更多', en: 'More' },
  'portTip.ignoreThis': { zh: '忽略这个端口', en: 'Dismiss this port' },
  'portTip.turnOff': { zh: '不再提示发现的本机页面', en: 'Stop showing local page tips' },
  'portTip.turnedOff': {
    zh: '已关闭「发现本机页面」提示，可在 设置 › 对话 › 提示 里重新打开',
    en: 'Local page tips are off. Turn them back on in Settings › Chats › Tips',
  },
  'portTip.undo': { zh: '撤销', en: 'Undo' },
  'portTip.setting.title': { zh: '命令输出里发现本机页面时提示', en: 'Show a tip when commands print a local page' },
  'portTip.setting.desc': {
    zh: 'AI 运行的命令输出了 localhost 地址时，在对话末尾提示「在内置浏览器打开」；关掉后右侧面板的「端口」页照常显示',
    en: 'When a command prints a localhost address, offer to open it in the built-in browser at the end of the conversation. The Ports tab in the side panel still lists them when off',
  },
  'portTip.setting.keywords': {
    zh: '本机页面 端口 localhost 内置浏览器 预览 提示 不再提示 port preview browser tip',
    en: 'local page port localhost built-in browser preview tip',
  },
  'portTip.expand': { zh: '展开', en: 'Expand' },
  'portTip.collapse': { zh: '收起', en: 'Collapse' },
  'portTip.manualHint': {
    zh: '输入网址或本机端口，在这里预览页面',
    en: 'Enter an address or a local port to preview a page here',
  },
  'portTip.portPlaceholder': { zh: '端口', en: 'port' },
  'portTip.portInvalid': { zh: '输入 1–65535 的端口', en: 'Enter a port from 1 to 65535' },
  'portTip.found': { zh: '本会话发现的端口', en: 'Ports found in this session' },
} as const
