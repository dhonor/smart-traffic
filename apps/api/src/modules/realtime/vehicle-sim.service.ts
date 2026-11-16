import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common'
import { config } from '../../config'
import { PgService } from '../../infra/pg.service'
import { RealtimeGateway } from './realtime.gateway'
import type { VehicleTarget } from '@traffic/shared-types'

interface RoadShape {
  id: string
  level: string
  from: [number, number]
  to: [number, number]
  length: number
}

interface SimVehicle {
  id: string
  plate: string
  road: RoadShape
  /** 0..1 沿路段进度 */
  t: number
  speedKph: number
  direction: 1 | -1
}

const COLORS = ['#3FA9F5', '#7BD389', '#F5A623', '#C56CF0', '#FF6B6B', '#4ECDC4']

/**
 * 车辆目标模拟器（演示用）。
 *
 * 生产的车辆位置来自定位流（Kafka）→ 消费者写入 Redis / 推 WS；
 * 这里用路网几何生成同样的 VehicleTarget 结构，前端实例化渲染不用区分来源。
 * 关键约束：一次 tick 只推**位置数组**，不推任何几何 —— 前端按 id 更新实例矩阵。
 */
@Injectable()
export class VehicleSimService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('VehicleSim')
  private roads: RoadShape[] = []
  private vehicles: SimVehicle[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly pg: PgService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /**
   * 用 onApplicationBootstrap 而不是 onModuleInit：
   * 后者按模块顺序执行，拿到 PgService 时连接池可能还没建好（实测会读不到路网）。
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!config.enableSimulator) return
    // 数据可能还没 seed，重试几次不影响主流程
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const rows = await this.pg.query<{ id: string; level: string; geojson: string }>(
          `SELECT id, level, ST_AsGeoJSON(geom) AS geojson FROM road`,
        )
        if (rows.length > 0) {
          this.roads = rows.map((row) => {
            const geo = JSON.parse(row.geojson)
            const [from, to] = geo.coordinates as [number, number][]
            return {
              id: row.id,
              level: row.level,
              from,
              to,
              length: distanceMeters(from, to),
            }
          })
          break
        }
      } catch {
        /* PostGIS 尚未就绪 */
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }

    if (!this.roads.length) {
      this.log.warn('没有路网数据，车辆模拟未启动（先执行 pnpm db:seed）')
      return
    }

    this.vehicles = Array.from({ length: config.vehicleCount }, (_, i) => {
      const road = this.roads[i % this.roads.length]
      return {
        id: `V-${String(i + 1).padStart(4, '0')}`,
        plate: `粤B${String(10000 + ((i * 37) % 89999))}`,
        road,
        t: (i * 0.037) % 1,
        speedKph: road.level === 'expressway' ? 55 + (i % 25) : 25 + (i % 20),
        direction: i % 2 === 0 ? 1 : -1,
      }
    })

    this.timer = setInterval(() => this.tick(), config.vehicleTickMs)
    this.log.log(`车辆模拟已启动: ${this.vehicles.length} 辆，周期 ${config.vehicleTickMs}ms`)
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private tick(): void {
    const dtHours = config.vehicleTickMs / 3_600_000
    const targets: VehicleTarget[] = []

    for (const vehicle of this.vehicles) {
      vehicle.t += (vehicle.speedKph * dtHours * 1000) / vehicle.road.length
      if (vehicle.t > 1) {
        vehicle.t -= 1
        vehicle.road = this.roads[Math.floor(Math.random() * this.roads.length)]
      }

      const { from, to } = vehicle.road
      const t = vehicle.direction === 1 ? vehicle.t : 1 - vehicle.t
      const lng = from[0] + (to[0] - from[0]) * t
      const lat = from[1] + (to[1] - from[1]) * t
      const heading =
        (Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI + (vehicle.direction === 1 ? 0 : 180)

      targets.push({
        vehicle_id: vehicle.id,
        plate_no: vehicle.plate,
        lng,
        lat,
        heading: (heading + 360) % 360,
        speed_kph: Math.round(vehicle.speedKph),
        color: COLORS[Number(vehicle.id.slice(2)) % COLORS.length],
      })
    }

    this.gateway.emitVehicles(targets)
  }
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const R = 6_371_000
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  const lat = (a[1] * Math.PI) / 180
  const x = dLng * Math.cos(lat)
  return Math.sqrt(x * x + dLat * dLat) * R
}
