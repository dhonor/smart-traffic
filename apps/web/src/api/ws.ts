import { io, type Socket } from 'socket.io-client'
import type { AlarmEvent, RoadStatusPatch, VehicleTarget, WsEnvelope } from '@traffic/shared-types'
import { AUTH_REQUIRED_EVENT, getToken } from './auth'

export type WsState = 'connecting' | 'online' | 'offline'

export interface RealtimeHandlers {
  onState?: (state: WsState) => void
  onVehicles?: (vehicles: VehicleTarget[]) => void
  onRoadStatus?: (patches: RoadStatusPatch[]) => void
  onAlarm?: (alarm: AlarmEvent) => void
  onPassage?: (passage: unknown) => void
  /** 规则变更广播（Redis Pub/Sub → 多实例 → 各端刷新规则副本） */
  onRuleChanged?: () => void
}

const WS_BASE = (import.meta.env.VITE_WS_BASE as string | undefined) ?? 'http://127.0.0.1:8080'

/**
 * 实时通道。
 *
 * 命名空间是 `/realtime`，握手走 socket.io 默认的 `/socket.io` 路径。
 * 生产建议同源部署（Nginx 反代），这样无需暴露第二个端口。
 */
export function connectRealtime(handlers: RealtimeHandlers): () => void {
  const socket: Socket = io(`${WS_BASE}/realtime`, {
    transports: ['websocket', 'polling'],
    reconnectionDelay: 800,
    reconnectionDelayMax: 6000,
    // 握手带 JWT：服务端校验失败会发 unauthorized 并断开
    auth: { token: getToken() ?? undefined },
  })

  socket.on('unauthorized', () => {
    handlers.onState?.('offline')
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
  })

  handlers.onState?.('connecting')

  socket.on('connect', () => handlers.onState?.('online'))
  socket.on('disconnect', () => handlers.onState?.('offline'))
  socket.on('connect_error', () => handlers.onState?.('offline'))

  socket.on('hello', () => handlers.onState?.('online'))
  socket.on('vehicles', (envelope: WsEnvelope<VehicleTarget[]>) => handlers.onVehicles?.(envelope.data))
  socket.on('road_status', (envelope: WsEnvelope<RoadStatusPatch[]>) => handlers.onRoadStatus?.(envelope.data))
  socket.on('alarm', (envelope: WsEnvelope<AlarmEvent>) => handlers.onAlarm?.(envelope.data))
  socket.on('passage', (envelope: WsEnvelope<unknown>) => handlers.onPassage?.(envelope.data))
  socket.on('rule_changed', () => handlers.onRuleChanged?.())

  return () => socket.close()
}
