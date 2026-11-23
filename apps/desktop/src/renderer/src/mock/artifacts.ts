// 产物面板的演示数据（docs/ui/artifacts-panel.md），只在 `pnpm dev:demo` 显示
import type { ArtifactResponse, FileChange } from '@pixelsky/protocol'
import type { ArtifactPreview } from '../../../shared/types/artifacts'
import { CHANGES_BAR_EDITS, CHANGES_BAR_ID, CHANGES_BAR_PROMPT, CHANGES_BAR_USER } from './conversations'
import { SETTINGS_CHANGES, SIDEBAR_CHANGES, workbenchSnapshots } from './workbench'

const now = Date.now()
const root = 'D:/pixel-web'
/** 产物面板里的文件：增删行数取对话里那次改动（mock/workbench.ts），两边对得上 */
const file = ({ path: local, kind, added, removed }: FileChange, itemId: string) => ({
  path: local,
  absolute: `${root}/${local}`,
  inside: true,
  local,
  kind,
  added,
  removed,
  itemId,
  itemIds: [itemId],
})

/** 「运行中：改动条」那一轮：同一个文件改了几次合成一行 */
const changesBarFiles = [...new Set(CHANGES_BAR_EDITS.map(e => e.change.path))].map(path => {
  const edits = CHANGES_BAR_EDITS.filter(e => e.change.path === path)
  return {
    ...file(edits[0].change, edits[0].id),
    added: edits.reduce((n, e) => n + e.change.added, 0),
    removed: edits.reduce((n, e) => n + e.change.removed, 0),
    itemIds: edits.map(e => e.id),
  }
})

export const demoArtifacts: ArtifactResponse = {
  requestId: 0,
  turns: [
    {
      sessionId: CHANGES_BAR_ID,
      title: '运行中：改动条（循环播放）',
      engine: 'claude',
      archived: false,
      userItemId: CHANGES_BAR_USER,
      prompt: CHANGES_BAR_PROMPT,
      at: now,
      files: changesBarFiles,
    },
    {
      sessionId: 's-settings-form',
      title: '设置页迁移到新的表单组件',
      engine: 'claude',
      archived: false,
      userItemId: 'demo-u2',
      prompt: '把设置页迁到新的表单组件，先做账号和外观两页',
      at: now - 25 * 60_000,
      files: [
        file(SETTINGS_CHANGES.account, 'demo-c2'),
        file(SETTINGS_CHANGES.useField, 'demo-c2'),
        file(SETTINGS_CHANGES.oldForm, 'demo-c3'),
      ],
    },
    {
      sessionId: 's-redesign',
      title: '重构网页版工作台为 Codex 式布局',
      engine: 'claude',
      archived: false,
      userItemId: 'demo-u1',
      prompt: '帮我看一下侧栏改版的整体结构',
      at: now - 26 * 3600_000,
      files: [file(SIDEBAR_CHANGES[0], 'demo-c1'), file(SIDEBAR_CHANGES[1], 'demo-c1')],
    },
  ],
  delivered: [
    {
      sessionId: 's-redesign',
      itemId: 'demo-d1',
      title: '重构网页版工作台为 Codex 式布局',
      path: 'docs/侧栏改版报告.md',
      absolute: `${root}/docs/侧栏改版报告.md`,
      inside: true,
      local: 'docs/侧栏改版报告.md',
      type: 'document',
      at: now - 26 * 3600_000,
      exists: true,
      bytes: 2140,
    },
    {
      sessionId: 's-settings-form',
      itemId: 'demo-d2',
      title: '设置页迁移到新的表单组件',
      path: 'docs/form-screens.png',
      absolute: `${root}/docs/form-screens.png`,
      inside: true,
      local: 'docs/form-screens.png',
      type: 'image',
      at: now - 20 * 60_000,
      exists: true,
      bytes: 48_210,
    },
    {
      sessionId: 's-settings-form',
      itemId: 'demo-d3',
      title: '设置页迁移到新的表单组件',
      path: 'C:/Users/linxia/Desktop/字段对照表.csv',
      absolute: 'C:/Users/linxia/Desktop/字段对照表.csv',
      inside: false,
      local: null,
      type: 'table',
      at: now - 18 * 60_000,
      exists: true,
      bytes: 312,
    },
    {
      sessionId: 's-redesign',
      itemId: 'demo-d4',
      title: '重构网页版工作台为 Codex 式布局',
      path: 'preview/sidebar.html',
      absolute: `${root}/preview/sidebar.html`,
      inside: true,
      local: 'preview/sidebar.html',
      type: 'web',
      at: now - 27 * 3600_000,
      exists: false,
      bytes: null,
    },
  ],
  outsideCount: 1,
  truncated: false,
  partial: false,
}

/** 产物面板点开一个文件：取对话里那条改动记录的全部改动 */
export function demoArtifactChanges(itemId: string): FileChange[] | null {
  const edit = CHANGES_BAR_EDITS.find(e => e.id === itemId)
  if (edit) return [edit.change]
  for (const snap of Object.values(workbenchSnapshots))
    for (const item of snap.items) if (item.id === itemId && item.kind === 'file_change') return item.changes
  return null
}

// 一张 2×2 的小图（演示用）
const PIXEL =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#e9eee9"/><rect x="20" y="20" width="120" height="140" rx="8" fill="#ffffff"/><rect x="160" y="20" width="140" height="64" rx="8" fill="#ffffff"/><rect x="160" y="96" width="140" height="64" rx="8" fill="#ffffff"/></svg>',
  )
export function demoArtifactPreview(path: string): ArtifactPreview {
  if (path.endsWith('.png')) return { kind: 'image', dataUrl: PIXEL, bytes: 48_210 }
  if (path.endsWith('.csv'))
    return {
      kind: 'text',
      format: 'plain',
      truncated: false,
      bytes: 312,
      content: '旧字段,新字段,校验\nemail,email,有效邮箱\nnickname,displayName,1-32 个字\n',
    }
  if (path.endsWith('.html')) return { kind: 'missing' }
  return {
    kind: 'text',
    format: 'markdown',
    truncated: false,
    bytes: 2140,
    content:
      '# 侧栏改版报告\n\n## 改了什么\n\n- 「最近任务」固定在账号行上方\n- 会话状态点统一为 6px\n\n## 验证\n\n| 项目 | 结果 |\n|---|---|\n| 构建 | 通过 |\n| 键盘导航 | 通过 |\n',
  }
}
