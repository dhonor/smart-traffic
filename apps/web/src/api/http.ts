import type {
  AlarmEvent,
  CheckpointProps,
  FeatureCollection,
  OverviewKpi,
  RoadProps,
  SurveillanceRule,
} from '@traffic/shared-types'

import { AUTH_REQUIRED_EVENT, clearAuth, getToken } from './auth'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    // 401 = 令牌缺失/过期：清状态并广播，让登录层接管；403 交给调用方提示（如 viewer 尝试写操作）
    if (response.status === 401) {
      clearAuth()
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
    }
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${response.statusText} ${text.slice(0, 120)}`)
  }
  return response.json() as Promise<T>
}

export interface HealthPayload {
  status: string
  ingest: 'kafka-dual-group' | 'direct'
  deps: Record<string, string>
  counts: { checkpoints?: number }
}

export interface LoginPayload {
  token: string
  name: string
  role: 'admin' | 'viewer'
  expiresInHours: number
}

export const api = {
  login: (name: string, password: string) =>
    request<LoginPayload>('/auth/login', { method: 'POST', body: JSON.stringify({ name, password }) }),
  me: () => request<{ name: string; role: 'admin' | 'viewer' }>('/auth/me'),
  health: () => request<HealthPayload>('/health'),
  overview: () => request<{ kpi: OverviewKpi[] }>('/overview'),
  roads: () => request<FeatureCollection<RoadProps, any>>('/spatial/roads'),
  zones: () => request<{ type: string; features: any[] }>('/spatial/zones'),
  blocks: () => request<{ type: string; features: any[] }>('/spatial/blocks'),
  checkpoints: () => request<FeatureCollection<CheckpointProps, any>>('/devices/checkpoints'),
  checkpointDetail: (id: string) => request<any>(`/devices/${id}`),
  alarms: (
    params: {
      limit?: number
      offset?: number
      open?: boolean
      plate?: string
      kind?: string
      level?: string
      from?: string
      to?: string
    } = {},
  ) => {
    const qs = new URLSearchParams()
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.offset != null) qs.set('offset', String(params.offset))
    if (params.open) qs.set('open', 'true')
    if (params.plate) qs.set('plate', params.plate)
    if (params.kind) qs.set('kind', params.kind)
    if (params.level) qs.set('level', params.level)
    if (params.from) qs.set('from', params.from)
    if (params.to) qs.set('to', params.to)
    return request<{ count: number; total: number; items: AlarmEvent[]; counts: Record<string, number> }>(
      `/surveillance/alarms?${qs}`,
    )
  },
  ackAlarm: (id: string) => request<{ ok: boolean }>(`/surveillance/alarms/${id}/ack`, { method: 'POST' }),
  rules: () => request<{ items: SurveillanceRule[] }>('/surveillance/rules'),
  saveRule: (rule: Partial<SurveillanceRule>) =>
    request<SurveillanceRule>('/surveillance/rules', { method: 'POST', body: JSON.stringify(rule) }),
  deleteRule: (id: string) =>
    request<{ ok: boolean }>(`/surveillance/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  trajectoryRecent: () => request<{ items: any[] }>('/trajectory/recent'),
  simulate: (count: number) =>
    request<{ produced: number }>(`/checkpoints/simulate?count=${count}`, { method: 'POST' }),
  gbStatus: () => request<any>('/gb28181/status'),
}
