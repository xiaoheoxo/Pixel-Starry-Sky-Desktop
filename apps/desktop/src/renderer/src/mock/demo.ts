// 演示数据：照参考图 docs/reference/workbench-session.jpg 写的，品牌名已替换。
// 用 `pnpm dev:demo` 启动时显示，用来对照参考图调样式。
import type { AppData } from '@/data/types'
import { COMPOSER } from '@/data/constants'
import { DEMO_TEAMS, demoChannelData } from './channels'
import { SHOWCASE_PROJECT, SHOWCASE_SESSIONS, showcaseSnapshots } from './conversations'
import { CODEX_FLOW_PROJECT, CODEX_FLOW_SESSIONS, codexFlowSnapshots } from './codexFlow'
import { CODING_SESSION } from './coding'
import { BRANCH_MERGE_SESSIONS } from './branchMerge'
import { statusDemoProjects } from './statusDemo'

// 参考图改动卡片里两个文件的 diff（点文件行展开，docs/ui/changes-inline-diff.md）；行数和卡片上的 +27 −8、+15 −2 对得上
const COMPOSER_DIFFS = [
  [
    '@@ -1,12 +1,22 @@',
    "-import { useState } from 'react'",
    "+import { useRef, useState } from 'react'",
    "+import { AttachmentChip } from './AttachmentChip'",
    "+import { ModelMenu } from './ModelMenu'",
    ' ',
    '-export function Composer({ onSend }) {',
    "-  const [text, setText] = useState('')",
    '+export function Composer({ onSend, attachments = [], onRemove }) {',
    "+  const [text, setText] = useState('')",
    '+  const input = useRef(null)',
    '+  const empty = !text.trim() && attachments.length === 0',
    ' ',
    '   const send = () => {',
    '-    if (!text.trim()) return',
    '+    if (empty) return',
    '     onSend(text)',
    "     setText('')",
    '   }',
    ' ',
    '   return (',
    '-    <div className="composer">',
    '-      <textarea value={text} onChange={e => setText(e.target.value)} />',
    '+    <div className="composer-shell">',
    '+      {attachments.length > 0 && (',
    '+        <div className="composer-chips">',
    '+          {attachments.map(a => (',
    '+            <AttachmentChip key={a.id} item={a} onRemove={() => onRemove(a.id)} />',
    '+          ))}',
    '+        </div>',
    '+      )}',
    '+      <textarea',
    '+        ref={input}',
    '+        value={text}',
    '+        onChange={e => setText(e.target.value)}',
    '+        placeholder="继续追问或提出修改，@ 添加文件，/ 输入命令"',
    '+      />',
  ].join('\n'),
  [
    '@@ -24,6 +34,10 @@',
    '-      <button onClick={send}>发送</button>',
    '-    </div>',
    '+      <div className="composer-actions">',
    '+        <ModelMenu />',
    '+        <button className="send" disabled={empty} onClick={send} aria-label="发送" />',
    '+      </div>',
    '+    </div>',
    '   )',
    ' }',
  ].join('\n'),
]

const SESSION_CSS_DIFFS = [
  [
    '@@ -8,6 +8,19 @@',
    '-.composer {',
    '-  border: 1px solid #ddd;',
    '+.composer-shell {',
    '+  display: flex;',
    '+  flex-direction: column;',
    '+  gap: 8px;',
    '+  padding: 12px 14px;',
    '+  border: 1px solid var(--line-card);',
    '+  border-radius: 16px;',
    '+  background: var(--surface);',
    '+}',
    '+',
    '+.composer-chips {',
    '+  display: flex;',
    '+  flex-wrap: wrap;',
    '+  gap: 6px;',
    '+}',
    ' ',
    ' .composer textarea {',
    '   resize: none;',
  ].join('\n'),
]

/** 几天没收发消息（批量归档旧会话，docs/ui/archive-old-sessions.md）；置顶的 s-redesign、运行中的 s-settings-form 也列在「不会归档」里 */
export const demoIdleDays: Record<string, number> = {
  's-redesign': 40,
  's-settings-form': 20,
  's-cloud-onboarding': 3,
  's-old-error': 15,
  's-old-mermaid': 21,
  's-old-ssh': 60,
  's-old-hello': 21,
}

export const demo: AppData = {
  pinned: [],
  projects: [
    {
      id: 'pixel-web',
      name: 'pixel-web',
      running: true,
      expanded: true,
      sessions: [
        CODING_SESSION,
        { id: 's-hhh', title: 'hhh', status: 'idle', time: '刚刚' },
        { id: 's-redesign', title: '重构网页版工作台为 Codex 式布局', status: 'unread', pinnedAt: 1 },
        { id: 's-settings-form', title: '设置页迁移到新的表单组件', status: 'running' },
        { id: 's-cloud-onboarding', title: '把云主机配置引导改成两步', status: 'idle', time: '3天' },
        { id: 's-old-error', title: '帮我看看这个报错', status: 'idle', time: '2周' },
        { id: 's-old-mermaid', title: '整理 Mermaid 渲染方案', status: 'idle', time: '3周' },
        { id: 's-old-ssh', title: 'SSH 重连排查', status: 'idle', time: '2月' },
        ...BRANCH_MERGE_SESSIONS,
      ],
      archived: [{ id: 's-archived-demo', title: '已完成的项目检查', status: 'idle', time: '5天', archivedAt: 1 }],
    },
    // 对话展示：用真实对话组件显示（docs/ui/demo-conversation.md）
    {
      id: SHOWCASE_PROJECT,
      name: '对话展示（Claude）',
      expanded: true,
      sessions: SHOWCASE_SESSIONS.map(s => ({
        id: s.id,
        title: s.title,
        status: showcaseSnapshots[s.id].state === 'idle' ? ('idle' as const) : ('running' as const),
      })),
    },
    // Codex 普通模式：中间的回复直接显示、动作按段收起（docs/ui/codex-flow-slash-feedback.md A）
    {
      id: CODEX_FLOW_PROJECT,
      name: '对话展示（Codex）',
      expanded: true,
      sessions: CODEX_FLOW_SESSIONS.map(s => ({
        id: s.id,
        title: s.title,
        status: codexFlowSnapshots[s.id].state === 'idle' ? ('idle' as const) : ('running' as const),
      })),
    },
    // 侧栏对话的状态图标（docs/ui/sidebar-status-icons.md）：每种问题、每种 PR 一个对话
    ...statusDemoProjects,
    { id: 'pixel-desktop', name: 'pixel-desktop', branch: 'feat/turn-island', sessions: [] },
    { id: 'pixel-channel', name: 'pixel-channel', sessions: [] },
    {
      id: 'docs-site',
      name: 'docs-site',
      sessions: [{ id: 's-old-hello', title: '你好', status: 'idle', time: '3周' }],
    },
    { id: 'research-notes', name: 'research-notes', sessions: [] },
  ],
  recent: [
    { id: 's-hhh', title: 'hhh', project: 'pixel-web', time: '刚刚' },
    { id: 'r-cloud-reconnect', title: '修复云主机断线后仍显示已连接', time: '刚刚' },
    { id: 'r-channel-quote', title: '频道话题支持引用回复', project: 'pixel-channel', time: '1时', hasPr: true },
    { id: 'r-changelog', title: '整理 10 月更新日志', project: 'docs-site', time: '3时' },
  ],
  defaultSessionId: 's-hhh',
  sessionDiff: { added: 42, removed: 10 },
  toolCalls: [
    { kind: 'edit', path: 'src/styles/session.css', added: 15, removed: 2 },
    { kind: 'run', command: 'npm run build', ok: true, duration: '2.2s' },
  ],
  assistantReply: {
    intro: '好的，已按你的要求处理：',
    bullets: [
      { text: '先读了相关文件，确认改动范围只在当前工作区；' },
      { text: '改完后跑了一遍构建，', bold: '没有新的告警', after: '；' },
      { text: '浏览器里打开检查过，桌面和窄屏都正常。' },
    ],
    outro: '如果要我继续，可以直接说下一步，或者把这条设为定时任务。',
  },
  changedFiles: {
    added: 42,
    removed: 10,
    files: [
      { dir: 'src/session/', name: 'Composer.jsx', added: 27, removed: 8, diffs: COMPOSER_DIFFS },
      { dir: 'src/styles/', name: 'session.css', added: 15, removed: 2, diffs: SESSION_CSS_DIFFS },
    ],
  },
  turnUsage: {
    durationMs: 44_000,
    models: {
      'claude-opus-5-5': {
        input: 1200,
        cacheRead: 48_000,
        cacheWrite: 2900,
        output: 2100,
        costUsd: 0.0743,
        requests: 7,
      },
      'claude-haiku-4-5': { input: 600, cacheRead: 9000, cacheWrite: 0, output: 380, costUsd: 0.0034, requests: 2 },
    },
  },
  attachments: [
    { id: 'a-chrome', kind: 'browser', label: 'Chrome · 127.0.0.1:8330' },
    { id: 'a-shot', kind: 'screenshot', label: '截图 10-42.png' },
    { id: 'a-doc', kind: 'file', label: '需求说明.md' },
    { id: 'a-minimal', kind: 'mode', label: '极简模式' },
  ],
  composer: { ...COMPOSER, placeholder: '继续追问或提出修改，@ 添加文件，/ 输入命令' },
  composerStatus: { machine: '这台电脑', branch: 'main', contextPercent: 12 },
  defaultPanelOpen: true,
  // 协作频道的角标由未读数计算（features/channels/store.ts），不再写在 BADGES 里
  // 团队先关着（docs/ui/channels-local-ai.md §1），DEMO_TEAMS 改成 true 能看到团队示例
  ...demoChannelData(DEMO_TEAMS),
}
