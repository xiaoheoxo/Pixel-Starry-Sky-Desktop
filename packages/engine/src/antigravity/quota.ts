// Antigravity CLI 账号额度（agy --print /usage --output-format json）：
// 只读取 Gemini Models 组（5 小时 / 每周两个窗口）；Claude and GPT models 组按产品决定忽略。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QuotaWindow } from '@pixelsky/protocol'
import { quotaWindowId } from '@pixelsky/protocol'
import type { Launcher } from '../adapter'
import { removeTree, run } from '../exec'
import { clampPercent, epochMs, quotaNoDataError, type QuotaReading } from '../quota'
import { forgetKeyAuth } from './auth-state'

const FIVE_HOUR = 300
const WEEK = 10_080
const USAGE_TIMEOUT_MS = 30_000

type Shape = Record<string, unknown>
const obj = (v: unknown): Shape => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Shape) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function bucketDuration(bucket: Shape): number | null {
  const w = str(bucket.window).trim().toLowerCase()
  const id = str(bucket.id).trim().toLowerCase()
  if (w === '5h' || id === 'gemini-5h') return FIVE_HOUR
  if (w === 'weekly' || id === 'gemini-weekly') return WEEK
  return null
}

/**
 * 解析 agy --print /usage --output-format json 的标准输出。
 * 仅从 "Gemini Models" 组提取 5 小时和每周已用比例（1 - remaining_fraction），忽略第三方模型池。
 */
export function parseAgyUsage(stdout: string, observedAt: number, plan: string | null = null): QuotaReading {
  const text = stdout.trim()
  if (!text) throw quotaNoDataError()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw quotaNoDataError()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw quotaNoDataError()

  const r = obj(parsed)
  const status = str(r.status).trim().toUpperCase()
  if (status && status !== 'SUCCESS') {
    const detail = str(r.response).trim() || str(r.error).trim() || `status=${status}`
    throw new Error(detail)
  }

  const groups = arr(obj(obj(r.command).data).groups).map(obj)
  const geminiGroup =
    groups.find(g => str(g.name).trim().toLowerCase() === 'gemini models') ??
    groups.find(g => arr(g.buckets).some(b => str(obj(b).id).toLowerCase().startsWith('gemini-')))
  if (!geminiGroup) throw quotaNoDataError()

  const byDuration = new Map<number, QuotaWindow>()
  for (const rawBucket of arr(geminiGroup.buckets)) {
    const b = obj(rawBucket)
    const durationMins = bucketDuration(b)
    const remaining = finite(b.remaining_fraction)
    if (durationMins === null || remaining === null || byDuration.has(durationMins)) continue
    const clampedRemaining = Math.min(1, Math.max(0, remaining))
    const usedPercent = clampPercent(1 - clampedRemaining, 1)
    if (usedPercent === null) continue
    byDuration.set(durationMins, {
      id: quotaWindowId(durationMins),
      durationMins,
      usedPercent,
      resetsAt: epochMs(b.reset_time),
      ...(clampedRemaining <= 0 ? { rejected: true } : {}),
    })
  }

  const windows = [...byDuration.values()].sort((a, b) => (a.durationMins ?? 0) - (b.durationMins ?? 0))
  if (!windows.length) throw quotaNoDataError()

  return {
    kind: 'ok',
    plan,
    account: null,
    windows,
    extras: {},
    blocked: null,
    observedAt,
  }
}

/** 在临时空目录运行一次 agy --print /usage --output-format json */
export async function fetchAgyUsage(
  launcher: Launcher,
  env: NodeJS.ProcessEnv,
  plan: string | null = null,
  signal?: AbortSignal,
): Promise<QuotaReading> {
  if (signal?.aborted) throw new Error('Antigravity unavailable: 应用正在退出')
  const cwd = mkdtempSync(join(tmpdir(), 'pixelsky-agy-'))
  forgetKeyAuth(env)
  try {
    const r = await run(launcher, ['--print', '/usage', '--output-format', 'json'], env, USAGE_TIMEOUT_MS, {
      cwd,
      signal,
    })
    if (signal?.aborted) throw new Error('Antigravity unavailable: 应用正在退出')
    if (!r.started) throw new Error(`引擎不可用: ${r.error ?? 'failed to start'}`)
    if (r.error === '超时') throw new Error('读取额度超时: timed out')
    if (!r.ok) {
      let detail = ''
      try {
        const j = obj(JSON.parse(r.stdout.trim()))
        detail = str(j.response).trim() || str(j.error).trim()
      } catch {
        // stdout 不是 JSON 时用 stderr / stdout 原文
      }
      throw new Error(detail || r.stderr.trim() || r.stdout.trim() || r.error || 'agy exited non-zero')
    }
    return parseAgyUsage(r.stdout, Date.now(), plan)
  } finally {
    try {
      removeTree(cwd)
    } catch {
      // Windows 上目录可能仍被杀毒或句柄短暂占用，留给系统临时目录清理
    }
  }
}
