const { readFileSync } = require('node:fs')

const block = reason => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
})
const tell = reason => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: reason } })

async function beforeDispatch(event, env, request = fetch) {
  const mode = env.PIXELSKY_AGNES_MODE
  if (mode !== 'force' && mode !== 'suggest') return {}
  if (event.hook_event_name !== 'PreToolUse' || !/^(collaboration[.:])?(spawn_agent|Agent)$/.test(event.tool_name))
    return {}
  const fallback = mode === 'force' ? block : tell
  const input = event.tool_input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fallback('Agnes: invalid dispatch input.')
  // Full-history forks inherit the main model. Don't silently discard the requested context or role.
  const isolated = input.fork_turns === undefined ? input.fork_context === false : input.fork_turns === 'none'
  if (mode === 'force' && !isolated) {
    return block(
      'Agnes strict dispatch requires an isolated agent. Use fork_turns="none" (or fork_context=false on the legacy tool); include the necessary context in the task.',
    )
  }
  const task =
    typeof input.message === 'string'
      ? input.message
      : Array.isArray(input.items)
        ? input.items
            .filter(item => item && item.type === 'text' && typeof item.text === 'string')
            .map(item => item.text)
            .join('\n')
        : ''
  if (
    !task.trim() ||
    !/^http:\/\/127\.0\.0\.1:\d+\/agnes$/.test(env.PIXELSKY_AGNES_URL ?? '') ||
    !env.PIXELSKY_AGNES_AUTH
  )
    return fallback('Agnes: the local evaluator cannot verify this task.')
  try {
    const response = await request(env.PIXELSKY_AGNES_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { authorization: env.PIXELSKY_AGNES_AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: event.session_id, turnId: event.turn_id, task: task.slice(0, 4000) }),
    })
    if (!response.ok) return fallback('Agnes: the local evaluator is unavailable.')
    const result = await response.json()
    if (typeof result.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(result.model))
      return fallback(result.reason ?? 'Agnes could not recommend an authorized model for this task.')
    if (mode === 'suggest')
      return tell(
        `Agnes recommends ${result.model} for this specific dispatch. This is a recommendation, not a confirmation that the agent used it.`,
      )
    const updatedInput = { ...input, model: result.model }
    if (input.model !== result.model) delete updatedInput.reasoning_effort
    if (/^(minimal|low|medium|high|xhigh|max)$/.test(result.effort ?? '')) updatedInput.reasoning_effort = result.effort
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } }
  } catch {
    return fallback('Agnes: evaluation timed out or the local connection failed.')
  }
}

async function main() {
  let output
  try {
    output = await beforeDispatch(JSON.parse(readFileSync(0, 'utf8')), process.env)
  } catch {
    output = process.env.PIXELSKY_AGNES_MODE === 'force' ? block('Agnes could not read the dispatch.') : {}
  }
  process.stdout.write(JSON.stringify(output) + '\n')
}

if (require.main === module) void main()
module.exports = { beforeDispatch, main }
