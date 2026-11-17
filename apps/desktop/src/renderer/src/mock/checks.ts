// 「做完自动检查」的演示结果（docs/ui/channels-collab-v2.md §8）：输入框上方的检查条和概况的「检查」都读它
import type { CheckRun } from '../../../shared/types/checks'
import type { ReviewFinding } from '../../../shared/types/ai'
import { T0 } from './conversations'

// 假截图：一张白底页面，真实结果是 JPEG data URL，img 标签都认
const SHOT = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 96"><rect width="160" height="96" fill="#fff"/><rect x="10" y="10" width="90" height="7" rx="2" fill="#c9544c"/><rect x="10" y="24" width="140" height="6" rx="2" fill="#d8d8d2"/><rect x="10" y="36" width="140" height="6" rx="2" fill="#d8d8d2"/><rect x="10" y="48" width="100" height="6" rx="2" fill="#d8d8d2"/></svg>',
)}`

export const demoSessionChecks: Record<string, CheckRun> = {
  'demo-claude-running': {
    id: 'demo-check-running',
    at: T0,
    endedAt: T0,
    status: 'done',
    items: [
      {
        kind: 'command',
        label: 'typecheck',
        command: 'pnpm typecheck',
        status: 'fail',
        exitCode: 2,
        ms: 12_400,
        output: "src/session/drafts.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      },
      { kind: 'command', label: 'test', command: 'pnpm test', status: 'pass', exitCode: 0, ms: 38_100, output: '' },
      { kind: 'text', status: 'pass', findings: [] },
      {
        kind: 'page',
        url: 'http://localhost:5173/',
        status: 'fail',
        ms: 2_300,
        errors: ['TypeError: x is undefined'],
        requests: ['404 /assets/a.js'],
        shot: SHOT,
      },
    ],
  },
  'demo-claude-tools': {
    id: 'demo-check-tools',
    at: T0,
    endedAt: T0,
    status: 'done',
    items: [
      {
        kind: 'command',
        label: 'typecheck',
        command: 'pnpm typecheck',
        status: 'pass',
        exitCode: 0,
        ms: 12_400,
        output: '',
      },
      { kind: 'command', label: 'test', command: 'pnpm test', status: 'pass', exitCode: 0, ms: 38_100, output: '' },
      { kind: 'page', url: 'http://localhost:5173/', status: 'pass', ms: 1_900, errors: [], requests: [], shot: SHOT },
    ],
  },
}

/** 改动卡片「AI 审查」的演示结果（docs/ui/review-pr-actions.md §2）：照样稿第 3 项 */
export const demoAiReviewFindings: ReviewFinding[] = [
  {
    severity: 'high',
    file: 'src/session/Composer.jsx',
    line: 88,
    title: '输入法组字时按回车会直接发送',
    detail: 'keydown 里没看 isComposing，中文输入法选词的回车也会触发发送；先判断 e.nativeEvent.isComposing。',
  },
  {
    severity: 'medium',
    file: 'src/styles/session.css',
    line: 12,
    title: '深色主题下边框颜色写死',
    detail: '#ddd 在深色主题下太亮，换成 var(--border)。',
  },
  {
    severity: 'low',
    file: 'src/session/Composer.jsx',
    line: 40,
    title: 'sendLock 可以提出来复用',
    detail: '和 QueueBar 里的锁是同一个逻辑，提成一个 hook，不影响功能。',
  },
]
