// 自定义 API 的接口列表（docs/ui/custom-api.md）：主进程保存，这里只订阅；Key 永远只看到末 4 位。
// 演示模式用两条假接口，改动只在内存里
import { useEffect, useSyncExternalStore } from 'react'
import type { EngineId } from '@pixelsky/protocol'
import type {
  ProviderInput,
  ProviderProtocol,
  ProvidersState,
  ProviderTestResult,
  ProviderView,
  RelayBilling,
} from '../../../../shared/types/providers'
import { engineProviderProtocols } from '../../../../shared/provider-protocols'
import { demo } from '@/data/demo'

let state: ProvidersState = { providers: [], persistent: true, warning: null }
let loaded = false
let started = false
const listeners = new Set<() => void>()

function set(next: ProvidersState): void {
  state = next
  loaded = true
  listeners.forEach(fn => fn())
}

function start(): void {
  if (started) return
  started = true
  if (window.pixelsky?.demo) {
    set(structuredClone(demo().providers))
    return
  }
  const api = window.pixelsky?.providers
  if (!api) return
  api.onChange(set)
  void api
    .list()
    .then(set)
    .catch(() => undefined)
}

export function useProviders(): ProvidersState & { loaded: boolean } {
  useEffect(start, [])
  const s = useSyncExternalStore(
    fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => state,
  )
  return { ...s, loaded }
}

export function getProviders(): ProvidersState {
  start()
  return state
}

/** 引擎能用哪些协议的自定义接口（和主进程同一份）；Antigravity 只能用 Gemini 接口（docs/ui/custom-api.md §15） */
export const engineProtocols = (engine: EngineId): ProviderProtocol[] => engineProviderProtocols(engine)

export const providersFor = (providers: ProviderView[], engine: EngineId): ProviderView[] =>
  providers.filter(p => engineProtocols(engine).includes(p.protocol))

/**
 * 模型菜单里 Gemini 接口列哪些模型（docs/ui/custom-api.md §15）：有 agy 目录里也有的就只列这些；一个都对不上
 * （接口列的是上游的真名，如 -preview）或读不到目录时列接口的——发出去的是接口的名字，网关按会话模型兜底。
 * 不列 agy 目录里接口没有的名字：选了网关也只能换成接口第一个模型。别的协议原样
 */
export function menuProvider(p: ProviderView, agyCatalog: readonly string[]): ProviderView {
  if (p.protocol !== 'gemini') return p
  const both = p.models.filter(m => agyCatalog.includes(m.id))
  return both.length ? { ...p, models: both } : p
}

/** 接口里还在的模型；没有就取第一个；接口没列模型时保留原值 */
export function resolveCustomModel(p: ProviderView | undefined, model: string | null): string | null {
  if (!p || p.models.length === 0) return model
  return model && p.models.some(m => m.id === model) ? model : p.models[0].id
}

export async function saveProvider(input: ProviderInput): Promise<ProviderView> {
  if (window.pixelsky?.demo) {
    const existing = state.providers.find(p => p.id === input.id)
    const view: ProviderView = {
      id: existing?.id ?? `demo-${Date.now().toString(36)}`,
      name: input.name.trim(),
      template: input.template ?? 'custom',
      protocol: input.protocol,
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      auth: input.auth ?? (input.protocol === 'anthropic' || input.protocol === 'gemini' ? 'x-api-key' : 'bearer'),
      models: input.models ?? existing?.models ?? [],
      smallModel: input.smallModel ?? null,
      modelFallback: input.modelFallback ?? true,
      keyHint: input.apiKey ? input.apiKey.slice(-4) : (existing?.keyHint ?? null),
      headerNames: Object.keys(input.headers ?? {}),
      insecure: input.baseUrl.startsWith('http:'),
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    set({
      ...state,
      providers: existing ? state.providers.map(p => (p.id === view.id ? view : p)) : [...state.providers, view],
    })
    return view
  }
  return window.pixelsky!.providers.save(input)
}

export async function removeProvider(id: string): Promise<void> {
  if (window.pixelsky?.demo) {
    set({ ...state, providers: state.providers.filter(p => p.id !== id) })
    return
  }
  await window.pixelsky!.providers.remove(id)
}

export async function testProvider(input: ProviderInput): Promise<ProviderTestResult> {
  if (window.pixelsky?.demo) return { ok: true, status: 200, model: input.models?.[0]?.id ?? null }
  return window.pixelsky!.providers.test(input)
}

/** 从中转站读取费用倍率；演示模式给一份 sub2api 的样子 */
export async function readRelayBilling(input: ProviderInput): Promise<RelayBilling> {
  if (window.pixelsky?.demo) return { kind: 'sub2api', multiplier: 0.6, base: 0.6, peak: null }
  return window.pixelsky!.providers.billing(input)
}

export async function readProviderModels(input: ProviderInput): Promise<string[]> {
  if (window.pixelsky?.demo)
    return input.protocol === 'anthropic'
      ? ['deepseek-chat', 'deepseek-reasoner']
      : input.protocol === 'gemini'
        ? ['gemini-3.1-pro', 'gemini-3.8-flash']
        : ['gpt-5', 'gpt-5-mini']
  return window.pixelsky!.providers.models(input)
}
