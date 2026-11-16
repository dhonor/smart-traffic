import { Logger } from '@nestjs/common'
import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets'
import type { Server, Socket } from 'socket.io'
import { config } from '../../config'
import { verifyJwt } from '../auth/jwt'
import type { AlarmEvent, WsEnvelope } from '@traffic/shared-types'

/**
 * 实时推送网关。
 *
 * 房间按业务维度组织（`alarm` / `checkpoint:{id}` / `trajectory:{vid}`），
 * 多实例必须挂 Redis Adapter —— 否则负载均衡后，A 实例产生的事件推不到 B 实例的连接上。
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: config.corsOrigin, credentials: false } })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly log = new Logger('WS')

  @WebSocketServer()
  server!: Server

  afterInit(): void {
    // Adapter 在 RedisIoAdapter 里挂载（见 main.ts）——这里只确认命名空间已就绪
    this.log.log('WebSocket 命名空间 /realtime 已就绪')
  }

  handleConnection(client: Socket): void {
    // 握手鉴权：令牌放在 handshake.auth.token（或 Authorization 头），无效直接断开——
    // docs/02 §6 曾把「WS 鉴权」列为待办，这里补上；房间内不再区分角色（推送是只读的）
    const headerAuth = client.handshake.headers.authorization
    const token =
      client.handshake.auth?.token ??
      (typeof headerAuth === 'string' ? headerAuth.replace(/^Bearer\s+/i, '') : undefined)
    if (!verifyJwt(token ?? '', config.authJwtSecret)) {
      this.log.warn(`WS 连接被拒绝（令牌缺失或无效）: ${client.id}`)
      client.emit('unauthorized', { message: '令牌缺失或已过期，请重新登录' })
      client.disconnect(true)
      return
    }

    client.join('alarm')
    const envelope: WsEnvelope = {
      type: 'hello',
      ts: new Date().toISOString(),
      data: { rooms: ['alarm'], heartbeatMs: 15000 },
    }
    client.emit('hello', envelope)
  }

  private emit<T>(event: string, type: WsEnvelope['type'], data: T, room?: string): void {
    if (!this.server) return
    const envelope: WsEnvelope<T> = { type, ts: new Date().toISOString(), data }
    if (room) this.server.to(room).emit(event, envelope)
    else this.server.emit(event, envelope)
  }

  emitAlarm(alarm: AlarmEvent): void {
    this.emit('alarm', 'alarm', alarm, 'alarm')
  }

  emitPassage(passage: unknown): void {
    this.emit('passage', 'passage', passage)
  }

  emitVehicles(vehicles: unknown[]): void {
    this.emit('vehicles', 'vehicles', vehicles)
  }

  emitRoadStatus(roads: unknown[]): void {
    this.emit('road_status', 'road_status', roads)
  }

  emitRuleChanged(): void {
    this.emit('rule_changed', 'rule_changed', { at: Date.now() })
  }
}
