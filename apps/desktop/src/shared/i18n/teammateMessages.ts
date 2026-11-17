// 队友派来的活的限制（docs/multica-learn.md §8、§11.4）
export const teammateMessages = {
  'run.reason.project_blocked': {
    zh: '这个项目不接队友派来的活',
    en: 'This project does not take work from teammates',
  },
  'run.hint.project_blocked': {
    zh: '请主人在团队设置里放开这个项目，或换个 AI 成员',
    en: 'Ask the owner to allow this project in team settings, or pick another AI member',
  },
  'teammate.title': { zh: '队友派来的活', en: 'Work from teammates' },
  'teammate.hint': {
    zh: '别人派给你的 AI 成员的活，在这台电脑上按这里的规则做（所有团队通用）。权限最高到「自动改文件」，每次都新开会话',
    en: 'Work teammates assign to your AI members runs on this computer under these rules (all teams). Permission is capped at "Auto-edit", and every run starts a new session',
  },
  'teammate.projects': { zh: '在哪些项目里接', en: 'Projects that take this work' },
  'teammate.projects.all': { zh: '所有项目', en: 'All projects' },
  'teammate.projects.some': { zh: '只在勾选的项目', en: 'Only checked projects' },
  'teammate.projects.empty': { zh: '还没有项目', en: 'No projects yet' },
  'teammate.copy': { zh: '每件活用一个独立副本', en: 'Use a separate copy for each task' },
  'teammate.copyHint': {
    zh: 'Git 项目里另建一个工作副本做，不碰你正在改的文件；建不了时在原目录做',
    en: 'In Git projects, work happens in a new working copy so your own edits are untouched; falls back to the folder itself when a copy cannot be made',
  },
  'teammate.mcp': { zh: '不带我的 MCP 和扩展', en: "Don't use my MCP servers and extensions" },
  'teammate.mcpHint': {
    zh: '只用项目里的 MCP 配置，你账号级的 MCP 和像素星空的扩展都不挂',
    en: "Only the project's own MCP config is used; your account-level MCP servers and PixelSky extensions are left out",
  },
  'teammate.saved': { zh: '已保存', en: 'Saved' },
  'teammate.blocked': {
    zh: '这个项目不接队友派来的活，别人派给它的活不会开工。可以在团队设置里放开',
    en: 'This project does not take work from teammates, so their tasks will not start. You can allow it in team settings',
  },
  'teammate.guard.capped': {
    zh: '队友派来的活：权限降到自动改文件',
    en: 'From a teammate: permission capped at Auto-edit',
  },
  'teammate.guard.copy': { zh: '在副本 {branch} 里做', en: 'Working in copy {branch}' },
} as const
