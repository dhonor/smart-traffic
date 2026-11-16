import { Controller, Get, Module, Param, Query } from '@nestjs/common'
import { PgService } from '../../infra/pg.service'

/**
 * 轨迹服务。
 *
 * 原始点只在 TDengine（高频写入）；PostGIS 只存**抽稀后的线段**（用于空间筛选与回放）。
 * `level` 控制回放精度：0 粗（每 4 点取 1）/ 1 中（每 2 点取 1）/ 2 全量。
 */
@Controller('trajectory')
export class TrajectoryController {
  constructor(private readonly pg: PgService) {}

  @Get('recent')
  async recent(@Query('limit') limit = '20') {
    const rows = await this.pg.query<any>(
      `SELECT id, vehicle_id, plate_no, started_at, ended_at, points, ST_AsGeoJSON(geom) AS geojson
         FROM trajectory_segment ORDER BY started_at DESC LIMIT $1`,
      [Math.min(Number(limit) || 20, 100)],
    )
    return {
      count: rows.length,
      items: rows.map((row) => ({
        id: String(row.id),
        vehicle_id: row.vehicle_id,
        plate_no: row.plate_no,
        started_at: row.started_at,
        ended_at: row.ended_at,
        points: row.points,
        geometry: JSON.parse(row.geojson),
      })),
    }
  }

  @Get(':vehicleId')
  async byVehicle(
    @Param('vehicleId') vehicleId: string,
    @Query('level') level = '1',
    @Query('limit') limit = '5',
  ) {
    const rows = await this.pg.query<any>(
      `SELECT id, vehicle_id, plate_no, started_at, ended_at, points, ST_AsGeoJSON(geom) AS geojson
         FROM trajectory_segment WHERE vehicle_id = $1 ORDER BY started_at DESC LIMIT $2`,
      [vehicleId, Math.min(Number(limit) || 5, 50)],
    )
    const stride = level === '0' ? 4 : level === '1' ? 2 : 1
    return {
      vehicle_id: vehicleId,
      level: Number(level),
      items: rows.map((row) => {
        const geometry = JSON.parse(row.geojson)
        const thinned = (geometry.coordinates as number[][]).filter((_, index) => index % stride === 0)
        return {
          id: String(row.id),
          plate_no: row.plate_no,
          started_at: row.started_at,
          ended_at: row.ended_at,
          points: thinned.length,
          geometry: { type: 'LineString', coordinates: thinned },
        }
      }),
    }
  }
}

@Module({
  controllers: [TrajectoryController],
})
export class TrajectoryModule {}
