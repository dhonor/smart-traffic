import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common'
import { IsIn, IsString, Matches } from 'class-validator'
import { PgService } from '../../infra/pg.service'
import type { FeatureCollection, RoadProps } from '@traffic/shared-types'

class WithinDto {
  /** WKT 多边形，简单校验格式，避免明显非法输入打到数据库 */
  @IsString()
  @Matches(/^POLYGON\s*\(\(/i, { message: 'polygon 必须是 WKT POLYGON' })
  polygon!: string

  @IsIn(['checkpoint', 'road', 'zone', 'alarm'])
  layer!: string
}

/**
 * 空间分析：全部下推到 PostGIS。
 * NestJS 只做参数校验与结果整形 —— 千万级要素也不允许把几何拉到应用层遍历。
 */
@Controller('spatial')
export class SpatialController {
  constructor(private readonly pg: PgService) {}

  @Get('roads')
  async roads(@Query('bbox') bbox?: string): Promise<FeatureCollection<RoadProps, unknown>> {
    const envelope = parseBbox(bbox)
    const rows = await this.pg.query<any>(
      `SELECT id, name, level, speed_limit, speed_kph, ST_AsGeoJSON(geom) AS geojson
         FROM road
        ${envelope ? 'WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))' : ''}
        ORDER BY id`,
      envelope ?? [],
    )
    return {
      type: 'FeatureCollection',
      features: rows.map((row) => {
        const speed = Number(row.speed_kph)
        return {
          type: 'Feature' as const,
          id: row.id,
          geometry: JSON.parse(row.geojson),
          properties: {
            id: row.id,
            name: row.name,
            level: row.level,
            speed_limit: row.speed_limit,
            speed_kph: speed,
            congestion: speed >= 55 ? 'free' : speed >= 30 ? 'slow' : 'jam',
          } satisfies RoadProps,
        }
      }),
    }
  }

  /**
   * 城市背景体块（**示意数据**）。
   * 只给路网提供空间参照；真实项目替换为白模/倾斜摄影切片，接口形状保持不变。
   */
  @Get('blocks')
  async blocks() {
    const rows = await this.pg.query<any>(
      `SELECT id, height, ST_AsGeoJSON(geom) AS geojson FROM block ORDER BY id`,
    )
    return {
      type: 'FeatureCollection',
      features: rows.map((row) => ({
        type: 'Feature',
        id: row.id,
        geometry: JSON.parse(row.geojson),
        properties: { id: row.id, height: Number(row.height) },
      })),
    }
  }

  /** 布控区：给前端做空间参照（哪些区域处于布控状态） */
  @Get('zones')
  async zones() {
    const rows = await this.pg.query<any>(
      `SELECT id, name, kind, ST_AsGeoJSON(geom) AS geojson FROM zone ORDER BY id`,
    )
    return {
      type: 'FeatureCollection',
      features: rows.map((row) => ({
        type: 'Feature',
        id: row.id,
        geometry: JSON.parse(row.geojson),
        properties: { id: row.id, name: row.name, kind: row.kind },
      })),
    }
  }

  /** 多边形内要素查询：ST_Within + GIST */
  @Post('within')
  async within(@Body() dto: WithinDto) {
    const table = { checkpoint: 'checkpoint', road: 'road', zone: 'zone', alarm: 'checkpoint' }[dto.layer]
    if (dto.layer === 'alarm') {
      const rows = await this.pg.query<any>(
        `SELECT a.id, a.plate_no, a.kind, a.level, a.ts, a.checkpoint_id
           FROM alarm a JOIN checkpoint c ON c.id = a.checkpoint_id
          WHERE ST_Within(c.geom, ST_GeomFromText($1, 4326))
          ORDER BY a.ts DESC LIMIT 500`,
        [dto.polygon],
      )
      return { layer: dto.layer, count: rows.length, items: rows }
    }
    const rows = await this.pg.query<any>(
      `SELECT id, ${dto.layer === 'zone' || dto.layer === 'road' ? 'name' : 'name, status'},
              ST_AsGeoJSON(geom) AS geojson
         FROM ${table}
        WHERE ST_Within(geom, ST_GeomFromText($1, 4326))`,
      [dto.polygon],
    )
    return {
      layer: dto.layer,
      count: rows.length,
      type: 'FeatureCollection',
      features: rows.map((row) => ({
        type: 'Feature',
        id: row.id,
        geometry: JSON.parse(row.geojson),
        properties: { id: row.id, name: row.name, status: row.status },
      })),
    }
  }

  /** 卡口覆盖范围：ST_DWithin + Buffer，返回覆盖的卡口数与缓冲面 */
  @Get('coverage/:checkpointId')
  async coverage(@Param('checkpointId') checkpointId: string, @Query('radius') radius = '500') {
    const meters = Math.min(Math.max(Number(radius) || 500, 100), 5000)
    const summary = await this.pg.one<any>(
      `WITH origin AS (SELECT geom FROM checkpoint WHERE id = $1)
       SELECT (SELECT ST_AsGeoJSON(ST_Buffer(geom::geography, $2)::geometry) FROM origin) AS buffer,
              (SELECT count(*) FROM checkpoint c, origin o
                WHERE ST_DWithin(c.geom::geography, o.geom::geography, $2)) AS covered`,
      [checkpointId, meters],
    )
    return {
      checkpoint_id: checkpointId,
      radius_m: meters,
      covered: Number(summary?.covered ?? 0),
      buffer: summary?.buffer ? JSON.parse(summary.buffer) : null,
    }
  }
}

function parseBbox(bbox?: string): [number, number, number, number] | null {
  if (!bbox) return null
  const parts = bbox.split(',').map(Number)
  if (parts.length !== 4 || parts.some((value) => Number.isNaN(value))) return null
  return parts as [number, number, number, number]
}

@Module({
  controllers: [SpatialController],
})
export class SpatialModule {}
