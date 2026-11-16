/**
 * 前后端共享契约（唯一真源）
 *
 * 纪律：这里只放「跨进程传输的形状」，不放业务常量、不放校验逻辑。
 * 后端 class-validator DTO 单独定义（校验属于后端），字段变更时两边靠编译器报错。
 */

export type CongestionLevel = 'free' | 'slow' | 'jam'

export interface RoadProps {
  id: string
  name: string
  level: 'expressway' | 'arterial' | 'branch'
  speed_limit: number
  /** 实时平均速度 km/h，由 Kafka 消费者聚合写入 */
  speed_kph: number
  congestion: CongestionLevel
}

export interface CheckpointProps {
  id: string
  name: string
  road_id: string
  direction: 'up' | 'down'
  /** GB28181 国标编码；设备管理只维护「编码—空间位置」映射，不处理 SIP */
  gb_code: string
  status: 'online' | 'offline' | 'fault'
  lanes: number
}

export interface PassageEvent {
  /** ISO8601 */
  ts: string
  checkpoint_id: string
  plate_no: string
  lane: number
  speed_kph: number
  /** 抓拍对象存储 key（MinIO） */
  snapshot_key?: string
}

export interface AlarmEvent {
  id: string
  checkpoint_id: string
  checkpoint_name: string
  plate_no: string
  kind: 'speeding' | 'wrong_way' | 'blacklist' | 'surveillance_hit'
  level: 'critical' | 'warning' | 'info'
  ts: string
  speed_kph?: number
  snapshot_url?: string
  /** 处置状态：确认时间非空即已确认（null/undefined = 未确认） */
  acked_at?: string | null
}

export interface TrajectoryPoint {
  ts: string
  lng: number
  lat: number
  speed_kph: number
}

export interface VehicleTarget {
  vehicle_id: string
  plate_no: string
  lng: number
  lat: number
  /** 航向角，deg，正北为 0，顺时针 */
  heading: number
  speed_kph: number
  color: string
}

export interface SurveillanceRule {
  id: string
  name: string
  kind: 'blacklist' | 'speeding' | 'wrong_way' | 'zone'
  plate_pattern?: string
  speed_threshold?: number
  zone_id?: string
  active: boolean
}

/** WebSocket 事件（服务端 → 客户端） */
export interface WsEnvelope<T = unknown> {
  type: 'passage' | 'alarm' | 'vehicles' | 'road_status' | 'rule_changed' | 'hello'
  ts: string
  data: T
}

export interface RoadStatusPatch {
  id: string
  speed_kph: number
  congestion: CongestionLevel
}

export interface OverviewKpi {
  key: string
  label: string
  value: number
  unit: string
  sub?: string
}

/** GeoJSON 最小可用类型（避免为前端引入 @types/geojson） */
export interface Feature<P = Record<string, unknown>, G = unknown> {
  type: 'Feature'
  id?: string
  geometry: G
  properties: P
}

export interface FeatureCollection<P = Record<string, unknown>, G = unknown> {
  type: 'FeatureCollection'
  features: Array<Feature<P, G>>
}
