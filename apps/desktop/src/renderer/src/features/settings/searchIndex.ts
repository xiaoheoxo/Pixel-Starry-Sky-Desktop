// 设置搜索的索引（docs/ui/plan-search-panes-compact.md §1，参考 JuCode settings/nav.ts）：
// 每个设置项的标题、说明里的关键词、在哪一页。title 要和页面上 SettingRow / GroupTitle 的标题一致
// （它们会带 data-setting-title），点搜索结果时按标题找到那一行、滚过去并高亮。改设置页时同步改这里。
import { ENGINES, type EngineId } from '@pixelsky/protocol'
import type { SectionId } from './SettingsDialog'
import { tr, translateText } from '../../i18n/core'
import { getPackState } from '@/features/extpacks/store'
import { iconThemesAvailable } from '@/features/files/icons/store'
import { editorThemesAvailable } from '@/features/editor/code/colorTheme/store'

export interface SearchEntry {
  section: SectionId
  title: string
  /** 搜索时也匹配的词（同义词、说明里的关键词） */
  keywords: string
  /** 在本机引擎的哪个引擎详情页里（点结果时先打开详情） */
  engine?: EngineId
  /** 在设置 › 扩展的哪个页签里（点结果时先切到那个页签） */
  extTab?: 'discover' | 'installed' | 'publish'
  /** 这一行现在显不显示（随扩展启停的设置）；不显示时搜不到 */
  available?: () => boolean
}

export const SETTINGS_INDEX: SearchEntry[] = [
  { section: 'notifications', title: '通知', keywords: '通知 提醒 系统通知 notification notify alert' },
  { section: 'mobile', title: '手机', keywords: '手机 远程 扫码 配对 中转 mobile phone remote pair qr relay' },
  { section: 'mobile', title: '允许手机远程连接', keywords: '手机 远程 连接 开关 mobile phone remote enable' },
  { section: 'mobile', title: '有任务运行时不让电脑睡眠', keywords: '手机 睡眠 休眠 唤醒 sleep awake' },
  { section: 'notifications', title: '回复完成', keywords: '通知 完成 回复 done finished notification' },
  { section: 'notifications', title: '回复出错', keywords: '通知 出错 失败 错误 error failed notification' },
  { section: 'notifications', title: '等你处理', keywords: '通知 审批 批准 提问 等待 approval waiting notification' },
  { section: 'notifications', title: '仅在窗口不在前台时通知', keywords: '通知 前台 后台 窗口 焦点 focus background' },
  { section: 'notifications', title: '提示音', keywords: '通知 声音 提示音 静音 sound mute' },
  { section: 'notifications', title: '勿扰', keywords: '勿扰 免打扰 静音 安静 do not disturb dnd quiet' },
  { section: 'notifications', title: '定时勿扰', keywords: '勿扰 定时 每天 夜间 schedule quiet hours dnd' },
  { section: 'notifications', title: '发送测试通知', keywords: '通知 测试 test notification' },
  {
    section: 'projects',
    get title() {
      return tr('projectImport.fromTools')
    },
    get keywords() {
      return tr('projects.keywords')
    },
  },
  { section: 'machines', title: '机器与连接', keywords: '机器 ssh remote 主机 连接 工作区 workspace' },
  {
    section: 'appearance',
    title: '图标位置',
    keywords:
      '侧边栏 图标 拖动 位置 排序 上下 底部 顶栏 右上角 工具栏 不显示 隐藏 Git git sidebar icons drag position reorder bottom toolbar top bar header hidden hide',
  },
  { section: 'terminal', title: '终端设置', keywords: '终端 shell powershell cmd git bash 交互 terminal' },
  { section: 'terminal', title: '默认 Shell', keywords: '默认 shell powershell cmd git bash' },
  {
    section: 'plugins',
    title: '插件配置',
    keywords: '插件 连接器 MCP Skills 技能 命令行 CLI plugin connector extension server',
  },
  {
    section: 'extensions',
    get title() {
      return tr('extensions.title')
    },
    get keywords() {
      return tr('extensions.keywords')
    },
  },
  {
    section: 'extensions',
    extTab: 'discover',
    get title() {
      return tr('extstore.tab.discover')
    },
    get keywords() {
      return tr('extstore.search.keywords')
    },
  },
  {
    section: 'extensions',
    extTab: 'publish',
    get title() {
      return tr('extstore.tab.publish')
    },
    get keywords() {
      return tr('extstore.publish.keywords')
    },
  },
  {
    section: 'extensions',
    get title() {
      return tr('extensions.loadFolder')
    },
    get keywords() {
      return tr('extensions.loadFolderKeywords')
    },
  },
  {
    section: 'appearance',
    get title() {
      return tr('extensions.appearance.fileIcons')
    },
    get keywords() {
      return tr('extensions.appearance.fileIconsKeywords')
    },
    available: () => iconThemesAvailable(getPackState()),
  },
  {
    section: 'appearance',
    get title() {
      return tr('extensions.appearance.editorTheme')
    },
    get keywords() {
      return tr('extensions.appearance.editorThemeKeywords')
    },
    available: () => editorThemesAvailable(getPackState()),
  },
  {
    section: 'appearance',
    title: '界面语言',
    keywords: '语言 中文 英文 简体 language Chinese English locale localization',
  },
  {
    section: 'appearance',
    title: '长对话先显示最近',
    keywords: '长对话 最近 轮 折叠 隐藏 更早 显示全部 conversation long recent turns fold hide',
  },
  // 用 tr() 取标题和关键词（getter，随界面语言），不新增写死的中文
  {
    section: 'appearance',
    get title() {
      return tr('subagent.setting')
    },
    get keywords() {
      return tr('subagent.searchKeywords')
    },
  },
  {
    section: 'appearance',
    get title() {
      return tr('subagentStop.setting')
    },
    get keywords() {
      return tr('subagentStop.searchKeywords')
    },
  },
  { section: 'appearance', title: '对话框风格', keywords: '输入框 风格 样式 布局 chatgpt claude 工具框内 框外' },
  {
    section: 'editor',
    title: '默认打开方式',
    keywords: '打开方式 内置编辑器 像素星空 CodeMirror 软件内 打开项目 Trae TraeCode CN',
  },
  {
    section: 'editor',
    title: '默认外部编辑器',
    keywords: '编辑器 Cursor VS Code Windsurf Trae TraeCode CN 打开项目 默认',
  },
  { section: 'editor', title: '打开窗口', keywords: '编辑器 复用窗口 新窗口' },
  {
    section: 'editor',
    get title() {
      return tr('editor.autoSave.title')
    },
    get keywords() {
      return tr('editor.autoSave.keywords')
    },
  },
  { section: 'editor', title: '指定程序路径', keywords: '编辑器 程序 路径 exe 检测' },
  { section: 'editor', title: '自定义编辑器', keywords: '编辑器 文件夹 参数 添加' },
  { section: 'account', title: '账号', keywords: '登录 退出登录 余额 套餐 订阅 充值 额度 限额' },
  {
    section: 'account',
    title: '设置云同步',
    keywords: '同步 云端 多台电脑 换电脑 备份 偏好 sync cloud settings',
  },

  {
    section: 'models',
    get title() {
      return tr('modelChannels.title')
    },
    keywords: '通道 像素星空账号 额度来源 默认引擎 平台 自有 自定义 channels credit source engine',
  },
  {
    section: 'models',
    get title() {
      return tr('modelChannels.channel.claude')
    },
    keywords: '授权 登录 claude pro max 订阅 切换账号 取消授权 claude auth login sign in',
  },
  {
    section: 'models',
    get title() {
      return tr('modelChannels.channel.chatgpt')
    },
    keywords: '授权 登录 chatgpt codex plus pro 设备码 切换账号 取消授权 codex login sign in',
  },
  {
    section: 'models',
    get title() {
      return tr('modelChannels.newTask.title')
    },
    keywords: '默认模型 默认线路 接着上次 固定 新任务 新对话 default model new task',
  },
  { section: 'models', title: '平台', keywords: '线路 分组 倍率 余额计费 订阅额度 刷新' },
  { section: 'models', title: '菜单里显示的模型', keywords: '隐藏模型 管理模型 模型列表 显示' },
  { section: 'models', title: '请求重试', keywords: '重试 失败 临时错误 自动重试' },
  { section: 'models', title: '自定义 API', keywords: 'byok key 地址 openai anthropic 兼容' },

  {
    section: 'engines',
    title: 'Claude Code',
    keywords: '引擎 版本 路径 重新检测 claude 默认引擎 设为默认',
    engine: 'claude',
  },
  { section: 'engines', title: 'Codex', keywords: '引擎 openai codex' },
  { section: 'engines', title: ENGINES.pixel.name, keywords: 'engine pixel pixelsky starry px pi cli agent' },
  { section: 'engines', title: '检查更新', keywords: '升级 更新 版本 claude update 新版本', engine: 'claude' },
  { section: 'engines', title: '新会话默认值', keywords: '默认 新任务 新会话', engine: 'claude' },
  { section: 'engines', title: '推理强度', keywords: 'effort 思考 强度 默认 low high max', engine: 'claude' },
  { section: 'engines', title: '权限', keywords: '询问 自动编辑 计划模式 完全放行 bypass 默认权限', engine: 'claude' },
  { section: 'engines', title: 'Fast 模式', keywords: 'fast 快速 默认', engine: 'claude' },
  { section: 'engines', title: 'Ultracode', keywords: 'ultracode 子智能体 编排 默认', engine: 'claude' },
  { section: 'engines', title: '显示思考过程', keywords: '思考 摘要 thinking 默认', engine: 'claude' },
  {
    section: 'engines',
    title: '输出风格',
    keywords: 'output style 风格 行文 explanatory learning proactive concise',
    engine: 'claude',
  },
  {
    section: 'engines',
    title: '允许中途向我提问',
    keywords: '提问 问题 askuserquestion 打断 自己拿主意',
    engine: 'claude',
  },
  {
    section: 'engines',
    title: '自动压缩触发点',
    keywords: '压缩 compact 阈值 百分比 上下文 窗口 autocompact',
    engine: 'claude',
  },
  { section: 'engines', title: '压缩上下文用的模型', keywords: '压缩 compact 摘要 上下文 压缩模型', engine: 'claude' },
  { section: 'engines', title: '在引擎菜单中显示', keywords: '隐藏 引擎 菜单 显示', engine: 'claude' },
  {
    section: 'engines',
    title: '启动',
    keywords: '启动方式 命令 参数 可执行文件 路径 claude.exe PATH 替换 自带程序 自动查找 launch command arguments flag',
    engine: 'claude',
  },
  {
    section: 'engines',
    title: '环境变量',
    keywords: 'env 代理 proxy https_proxy key=value 启动方式',
    engine: 'claude',
  },

  { section: 'usage', title: '用量', keywords: '调用记录 token 费用 导出 csv 账号调用 本机记录 统计' },
  {
    section: 'usage',
    title: '用量图表样式',
    keywords: '图表 折线 节点 柱状 堆叠 趋势 图例 隐藏系列 chart line bar trend legend',
  },

  { section: 'appearance', title: '主题', keywords: '浅色 深色 跟随系统 暗色 dark light' },
  {
    section: 'appearance',
    title: '配色主题',
    keywords:
      '配色 主题 皮肤 颜色 暖灰 极夜 纯黑 midnight black factory github solarized nord catppuccin gruvbox tokyo night rose pine rosé palette color scheme skin',
  },
  {
    section: 'appearance',
    title: '强调色',
    keywords: '主色 主题色 颜色 跟随配色 墨绿 海蓝 靛紫 青碧 琥珀 玫红 石墨 accent color blue purple orange pink',
  },
  {
    section: 'appearance',
    title: '极简模式',
    keywords: '极简 简洁 紧凑 安静 阴影 密度 factory minimal compact clean density',
  },
  { section: 'appearance', title: '动画', keywords: '动效 过渡 减少动画' },
  { section: 'appearance', title: '切换窗格时', keywords: '窗格 分屏 高亮 滑动 焦点 动画' },
  {
    section: 'appearance',
    get title() {
      return tr('coding.shell.transition.setting')
    },
    get keywords() {
      return tr('coding.shell.transition.keywords')
    },
  },
  {
    section: 'appearance',
    get title() {
      return tr('coding.gitOpen.setting')
    },
    get keywords() {
      return tr('coding.gitOpen.keywords')
    },
  },
  {
    section: 'appearance',
    title: '关闭主窗口时',
    keywords: '托盘 通知区域 后台 最小化 隐藏 退出 关闭 tray background minimize close quit',
  },
  { section: 'appearance', title: '侧边栏', keywords: '侧栏 历史 最近任务 图标 sidebar history recent icons toolbar' },
  {
    section: 'appearance',
    title: '显示最近任务',
    keywords: '侧栏 历史 隐藏 展开 折叠 sidebar history recent tasks hide collapse expand',
  },
  {
    section: 'appearance',
    title: '侧边栏图标',
    keywords:
      '侧栏 图标 自定义 替换 恢复 新建任务 添加项目 设置 插件 用量 sidebar icons customize replace reset new task add project settings plugins usage',
  },
  { section: 'appearance', title: '回复下方的统计', keywords: '统计行 耗时 token 费用 回复' },
  {
    section: 'appearance',
    title: '消息操作按钮',
    keywords: '复制 分叉 分支 回退 撤回 按钮 位置 左侧 下方 message actions copy fork rewind position below left',
  },
  {
    section: 'appearance',
    get title() {
      return tr('fullAccess.setting.title')
    },
    get keywords() {
      return tr('fullAccess.setting.keywords')
    },
  },
  { section: 'appearance', title: '缓存未命中提醒', keywords: '缓存 命中率 提醒 停止' },
  { section: 'appearance', title: '界面字体', keywords: '字体 font' },
  { section: 'appearance', title: '代码字体', keywords: '等宽 字体 mono' },
  { section: 'appearance', title: '字号', keywords: '文字大小 放大 缩小 字体大小' },
  { section: 'appearance', title: '对话正文用衬线体', keywords: '衬线 宋体 阅读' },
  { section: 'appearance', title: '壁纸', keywords: '背景 图片 视频 wallpaper' },
  { section: 'appearance', title: '透出程度', keywords: '壁纸 透明 不透明度' },
  { section: 'appearance', title: '模糊', keywords: '壁纸 虚化 blur' },

  { section: 'shortcuts', title: '快捷键', keywords: '键盘 ctrl 分屏 侧边栏 面板 搜索' },
  { section: 'logs', title: '日志', keywords: '日志 诊断 排查 报错 错误 导出 log logs diagnostics debug' },
  { section: 'logs', title: '详细日志', keywords: '日志 调试 详细 verbose debug stderr' },
  {
    section: 'feedback',
    title: '提交反馈',
    keywords: '反馈 问题 bug 建议 报错 联系 客服 意见 提交 feedback issue suggestion contact support',
  },
  { section: 'feedback', title: '我的反馈', keywords: '反馈 回复 团队 问题 建议 bug feedback reply ticket' },
  { section: 'about', title: '关于', keywords: '版本 更新 数据目录 运行环境 链接' },
]

/** 搜索：标题、关键词、页面名都参与，忽略大小写和空格；标题命中的排前面 */
export function searchSettings(query: string, sectionLabel: (s: SectionId) => string): SearchEntry[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, '')
  if (!q) return []
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')
  const scored = SETTINGS_INDEX.filter(e => e.available?.() !== false).map(e => {
    const titles = [norm(e.title), norm(translateText(e.title))]
    const score = titles.some(title => title.startsWith(q))
      ? 3
      : titles.some(title => title.includes(q))
        ? 2
        : norm(`${e.keywords}${translateText(e.keywords)}${sectionLabel(e.section)}`).includes(q)
          ? 1
          : 0
    return { e, score }
  })
  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.e)
}
