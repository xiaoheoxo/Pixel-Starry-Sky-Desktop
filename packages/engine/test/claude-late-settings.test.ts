// 进程启动期间改设置：记下来、进程就绪后补上；进程报的旧权限模式不能盖掉用户新选的
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { EngineEvent, SessionRecord } from '@pixelsky/protocol'
import { ClaudeSession } from '../src/claude/session'
import { makeTmp, removeTmp } from './helpers/tmp'

it('启动期间切换权限模式：进程就绪后补发，system/init 报的旧模式不写回记录', async () => {
  const root = makeTmp('claude-late-settings')
  const record: SessionRecord = {
    id: '44444444-4444-4444-8444-444444444444',
    projectId: 'project',
    cwd: root,
    engine: 'claude',
    engineSessionId: null,
    title: 'test',
    model: null,
    effort: null,
    permissionMode: 'ask',
    ultracode: false,
    fast: false,
    thinkingSummaries: true,
    createdAt: 0,
    updatedAt: 0,
    lastOutcome: null,
  }
  const events: EngineEvent[] = []
  const setPermissionMode = vi.fn((mode: SessionRecord['permissionMode']) => {
    record.permissionMode = mode
  })
  const session = new ClaudeSession(
    {
      record: () => record,
      emit: event => events.push(event),
      setEngineSessionId: id => {
        record.engineSessionId = id
      },
      setPermissionMode,
      setUltracode: vi.fn(),
      setFast: vi.fn(),
    },
    {
      launcher: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fakes/fake-claude.mjs', import.meta.url))],
      },
      projectsDir: join(root, 'projects'),
      env: { ...process.env, FAKE_CLAUDE_PROJECTS: join(root, 'projects'), FAKE_CLAUDE_INIT_DELAY: '400' },
    },
  )
  try {
    session.send('hello', 't1', 'input-1')
    await new Promise(r => setTimeout(r, 100))
    // 宿主先改记录再调 update（host/sessions.ts）
    record.permissionMode = 'plan'
    await session.update({ permissionMode: 'plan' })
    await vi.waitFor(
      () => expect(events).toContainEqual(expect.objectContaining({ type: 'turn_completed', turnId: 't1' })),
      { timeout: 10_000 },
    )
    expect(setPermissionMode).not.toHaveBeenCalledWith('ask')
    expect(record.permissionMode).toBe('plan')
  } finally {
    await session.close()
    removeTmp(root)
  }
}, 15_000)
