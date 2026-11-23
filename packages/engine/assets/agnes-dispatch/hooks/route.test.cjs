const { test } = require('node:test')
const assert = require('node:assert/strict')
const { beforeDispatch } = require('./route.cjs')

const env = mode => ({
  PIXELSKY_AGNES_MODE: mode,
  PIXELSKY_AGNES_URL: 'http://127.0.0.1:1234/agnes',
  PIXELSKY_AGNES_AUTH: 'test',
})
const event = {
  hook_event_name: 'PreToolUse',
  tool_name: 'collaboration.spawn_agent',
  session_id: 'main',
  turn_id: 'round',
  tool_input: {
    task_name: 'audit',
    message: 'Review one component',
    fork_turns: 'none',
    model: 'main-choice',
    reasoning_effort: 'max',
  },
}
const ok = result => ({ ok: true, json: async () => result })

test('ordinary tools and inactive sessions never request evaluation', async () => {
  const mustNotRun = () => {
    throw new Error('unwanted evaluation')
  }
  assert.deepEqual(await beforeDispatch({ ...event, tool_name: 'apply_patch' }, env('force'), mustNotRun), {})
  assert.deepEqual(await beforeDispatch(event, {}, mustNotRun), {})
})

test('enforce rewrites only model and compatible effort using the delegated task', async () => {
  const result = await beforeDispatch(event, env('force'), async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { threadId: 'main', turnId: 'round', task: 'Review one component' })
    return ok({ model: 'approved-worker', effort: 'low' })
  })
  assert.deepEqual(result.hookSpecificOutput.updatedInput, {
    ...event.tool_input,
    model: 'approved-worker',
    reasoning_effort: 'low',
  })
  assert.equal(result.hookSpecificOutput.permissionDecision, undefined)
})

test('enforce denies incompatibility and failed evaluation without guessing a worker', async () => {
  for (const bad of [
    beforeDispatch({ ...event, tool_input: { ...event.tool_input, fork_turns: 'all' } }, env('force')),
    beforeDispatch(event, env('force'), async () => ok({ reason: 'no eligible worker' })),
    beforeDispatch(event, env('force'), async () => {
      throw new Error('timeout')
    }),
  ])
    assert.equal((await bad).hookSpecificOutput.permissionDecision, 'deny')
})

test('suggest mode returns advice, not an override', async () => {
  const result = await beforeDispatch(event, env('suggest'), async () => ok({ model: 'approved-worker' }))
  assert.match(result.hookSpecificOutput.additionalContext, /approved-worker/)
  assert.equal(result.hookSpecificOutput.updatedInput, undefined)
})
