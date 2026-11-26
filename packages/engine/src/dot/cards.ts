// Read-only projection of native cards. Never forward schemas, results, credential fields or URLs.
export type DotSpecialCard =
  | { kind: 'input' | 'signIn'; status: 'pending' | 'resolved' | 'unknown' }
  | { kind: 'signIn'; status: 'submitted' }
  | { kind: 'browserHandoff' | 'browserActivity' }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export function dotSpecialCard(elicitation: unknown, metadata: unknown): DotSpecialCard | undefined {
  const e = record(elicitation)
  if (e) {
    const params = record(e.params)
    const meta = record(params?._meta)
    const signIn = meta?.codex_approval_kind === 'browser_auth'
    if (signIn && e.status === 'submitted') return { kind: 'signIn', status: 'submitted' }
    const status = e.status === 'pending' || e.status === 'resolved' ? e.status : 'unknown'
    return { kind: signIn ? 'signIn' : 'input', status }
  }
  const m = record(metadata)
  if (record(m?.cloud_browser_handoff)) return { kind: 'browserHandoff' }
  if (record(m?.browser_activity_reference)) return { kind: 'browserActivity' }
}
