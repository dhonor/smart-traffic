import { Controller, Get, Module, NotFoundException, Param, Query } from '@nestjs/common'
import { PgService } from '../../infra/pg.service'
import { TdengineService } from '../../infra/tdengine.service'
import type { CheckpointProps, Feature, FeatureCollection } from '@traffic/shared-types'

/** 设备管理只维护「编码—空间位置—状态」，不处理 SIP 信令 */
@Controller('devices')
export class DeviceController {
  constructor(
    private readonly pg: PgService,
    private readonly tdengine: TdengineService,
  ) {}

  @Get('checkpoints')
  async checkpoints(@Query('bbox') bbox?: string): Promise<FeatureCollection<CheckpointProps, unknown>> {
    const envelope = parseBbox(bbox)
    const rows = await this.pg.query<any>(
      `SELECT id, name, road_id, direction, gb_code, status, lanes, ST_AsGeoJSON(geom) AS geojson
         FROM checkpoint
        ${envelope ? 'WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))' : ''}
        ORDER BY id`,
      envelope ?? [],
    )
    const features: Array<Feature<CheckpointProps>> = rows.map((row) => ({
      type: 'Feature',
      id: row.id,
      geometry: JSON.parse(row.geojson),
      properties: {
        id: row.id,
        name: row.name,
        road_id: row.road_id,
        direction: row.direction,
        gb_code: row.gb_code,
        status: row.status,
        lanes: row.lanes,
      },
    }))
    return { type: 'FeatureCollection', features }
  }

  @Get('gb/:code')
  async byGbCode(@Param('code') code: string) {
    const row = await this.pg.one<any>(
      `SELECT id, name, gb_code, status, ST_AsGeoJSON(geom) AS geojson FROM checkpoint WHERE gb_code = $1`,
      [code],
    )
    if (!row) throw new NotFoundException(`未找到国标编码 ${code}`)
    return { ...row, geometry: JSON.parse(row.geojson) }
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const row = await this.pg.one<any>(
      `SELECT c.id, c.name, c.road_id, c.direction, c.gb_code, c.status, c.lanes,
              ST_AsGeoJSON(c.geom) AS geojson, r.name AS road_name, r.speed_kph
         FROM checkpoint c LEFT JOIN road r ON r.id = c.road_id
        WHERE c.id = $1`,
      [id],
    )
    if (!row) throw new NotFoundException(`未找到卡口 ${id}`)
    const passages = await this.tdengine.recentPassages(200)
    return {
      ...row,
      speed_kph: row.speed_kph === null ? null : Number(row.speed_kph),
      geometry: JSON.parse(row.geojson),
      recent_passages: passages.filter((item) => item.checkpoint_id === id).slice(0, 20),
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
  controllers: [DeviceController],
})
export class DeviceModule {}
