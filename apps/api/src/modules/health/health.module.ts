import { Controller, Get, Module } from '@nestjs/common'
import { config } from '../../config'
import { Public } from '../auth/auth.module'
import { KafkaService } from '../../infra/kafka.service'
import { MinioService } from '../../infra/minio.service'
import { PgService } from '../../infra/pg.service'
import { RedisService } from '../../infra/redis.service'
import { TdengineService } from '../../infra/tdengine.service'
import { SurveillanceModule, SurveillanceService } from '../surveillance/surveillance.module'
import type { OverviewKpi } from '@traffic/shared-types'

/**
 * 健康检查的意义在于**如实**：每个依赖是 up / down / disabled，
 * 前端顶部据此显示链路形态（Kafka 双通道 or 直连），排障时一眼定位。
 */
// 健康检查对探活系统（K8s probe / 冒烟脚本前置检查）公开，不要求登录
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly kafka: KafkaService,
    private readonly tdengine: TdengineService,
    private readonly minio: MinioService,
    private readonly surveillance: SurveillanceService,
  ) {}

  @Get('health')
  async health() {
    const counts = this.pg.available
      ? await this.pg
          .one<any>(`SELECT count(*)::int AS checkpoints FROM checkpoint`)
          .catch(() => ({ checkpoints: 0 }))
      : { checkpoints: 0 }

    return {
      status: this.pg.available ? 'ok' : 'degraded',
      ts: new Date().toISOString(),
      ingest: this.kafka.enabled && this.kafka.state === 'up' ? 'kafka-dual-group' : 'direct',
      deps: {
        postgis: this.pg.state,
        redis: this.redis.state,
        kafka: this.kafka.enabled ? this.kafka.state : 'disabled',
        tdengine: this.tdengine.state,
        minio: this.minio.state,
        gb28181: config.gb28181Gateway ? 'configured' : 'disabled',
      },
      counts,
      errors: {
        postgis: this.pg.lastError || undefined,
        redis: this.redis.lastError || undefined,
        kafka: this.kafka.lastError || undefined,
        tdengine: this.tdengine.lastError || undefined,
        minio: this.minio.lastError || undefined,
      },
    }
  }

  @Get('overview')
  async overview() {
    if (!this.pg.available) {
      return { kpi: [] as OverviewKpi[], alarm_counts: {}, ts: new Date().toISOString() }
    }
    const [row] = await this.pg.query<any>(
      `SELECT
         (SELECT count(*)::int FROM checkpoint)                                        AS checkpoints,
         (SELECT count(*)::int FROM checkpoint WHERE status = 'online')                AS online,
         (SELECT count(*)::int FROM alarm WHERE acked_at IS NULL)                      AS alarms_open,
         (SELECT coalesce(avg(speed_kph), 0) FROM road)                                AS avg_speed,
         (SELECT count(*)::int FROM alarm WHERE ts > now() - interval '1 hour')        AS alarms_1h`,
    )
    const counts = await this.surveillance.alarmCounts()

    const kpi: OverviewKpi[] = [
      { key: 'checkpoints', label: '卡口总数', value: row.checkpoints, unit: '个', sub: `在线 ${row.online}` },
      { key: 'speed', label: '路网均速', value: Math.round(Number(row.avg_speed)), unit: 'km/h', sub: '近 1 分钟聚合' },
      { key: 'alarms', label: '待处置告警', value: row.alarms_open, unit: '条', sub: `近 1 小时 ${row.alarms_1h} 条` },
      {
        key: 'critical',
        label: '严重告警',
        value: counts.critical ?? 0,
        unit: '条',
        sub: `预警 ${counts.warning ?? 0}`,
      },
    ]
    return { kpi, alarm_counts: counts, ts: new Date().toISOString() }
  }
}

@Module({
  imports: [SurveillanceModule],
  controllers: [HealthController],
})
export class HealthModule {}
