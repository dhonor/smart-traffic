import {
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Post,
  Query,
} from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { config } from '../../config'
import { KafkaService } from '../../infra/kafka.service'
import { MinioService } from '../../infra/minio.service'
import { PgService } from '../../infra/pg.service'
import { RedisService } from '../../infra/redis.service'
import { TdengineService } from '../../infra/tdengine.service'
import { RealtimeGateway } from '../realtime/realtime.gateway'
import { SurveillanceModule, SurveillanceService } from '../surveillance/surveillance.module'
import { RealtimeModule } from '../realtime/realtime.module'
import { Roles } from '../auth/auth.module'
import type { AlarmEvent, PassageEvent, RoadStatusPatch } from '@traffic/shared-types'

interface CheckpointMeta {
  name: string
  road_id: string
}

/**
 * 卡口检测流水线。
 *
 * 双通道（生产，KAFKA_BROKERS 存在）：
 *   group `realtime-push`  → 去重 → 规则匹配 → WS 推送（不等落库）
 *   group `persistence`    → TDengine 落库 → 聚合成路况
 * 直接模式（未配置 Kafka）：HTTP 进来后两条链路同步各跑一遍，语义一致。
 */
@Injectable()
export class CheckpointService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Checkpoint')
  private readonly meta = new Map<string, CheckpointMeta>()
  private readonly window: Array<{ ts: number; checkpoint_id: string; speed: number }> = []
  private statsTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly pg: PgService,
    private readonly tdengine: TdengineService,
    private readonly kafka: KafkaService,
    private readonly redis: RedisService,
    private readonly minio: MinioService,
    private readonly gateway: RealtimeGateway,
    private readonly surveillance: SurveillanceService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.loadCheckpointMeta()

    if (this.kafka.enabled && this.kafka.state === 'up') {
      await this.kafka.createConsumer('realtime-push', [config.kafkaTopicPassage], async (payload) => {
        await this.ingestRealtime(payload as PassageEvent)
      })
      await this.kafka.createConsumer('persistence', [config.kafkaTopicPassage], async (payload) => {
        await this.ingestPersist(payload as PassageEvent)
      })
    } else {
      this.log.warn('未启用 Kafka：过车事件走 POST /api/checkpoints/ingest（直接模式）')
    }

    this.statsTimer = setInterval(() => void this.flushRoadStatus(), 5000)
  }

  onModuleDestroy(): void {
    if (this.statsTimer) clearInterval(this.statsTimer)
  }

  private async loadCheckpointMeta(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const rows = await this.pg.query<{ id: string; name: string; road_id: string }>(
          `SELECT id, name, road_id FROM checkpoint`,
        )
        for (const row of rows) this.meta.set(row.id, { name: row.name, road_id: row.road_id })
        if (rows.length) return
      } catch {
        /* PostGIS 可能还没起 */
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    this.log.warn('未加载到卡口元数据（先执行 pnpm db:seed）')
  }

  /** 直接模式：两条链路都跑 */
  async ingestDirect(passage: PassageEvent): Promise<{ ok: boolean; alarm?: AlarmEvent }> {
    const alarm = await this.ingestRealtime(passage)
    await this.ingestPersist(passage)
    return { ok: true, alarm: alarm ?? undefined }
  }

  /** 实时通道：去重 → 规则匹配 → 推送，不等待落库 */
  async ingestRealtime(passage: PassageEvent): Promise<AlarmEvent | null> {
    const unique = await this.redis.dedupe(`${passage.plate_no}:${passage.checkpoint_id}`, 2)
    if (!unique) return null

    this.gateway.emitPassage(passage)

    const hit = this.surveillance.match(passage)
    if (!hit) return null

    const alarm: AlarmEvent = {
      ...hit,
      id: `ALM-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      ts: new Date().toISOString(),
      checkpoint_name: this.meta.get(passage.checkpoint_id)?.name ?? passage.checkpoint_id,
    }
    alarm.snapshot_url = await this.createSnapshot(alarm).catch(() => undefined)

    await this.surveillance.saveAlarm(alarm, { snapshot_url: alarm.snapshot_url })
    this.gateway.emitAlarm(alarm)
    await this.kafka.publish(config.kafkaTopicAlarm, alarm)
    return alarm
  }

  /** 落库通道：TDengine + 路况聚合窗口 */
  async ingestPersist(passage: PassageEvent): Promise<void> {
    await this.tdengine.insertPassage(passage)
    this.window.push({
      ts: Date.parse(passage.ts),
      checkpoint_id: passage.checkpoint_id,
      speed: passage.speed_kph,
    })
    if (this.window.length > 5000) this.window.splice(0, this.window.length - 5000)
  }

  /**
   * 抓拍图：生成 SVG 并写入 MinIO，返回预签名 URL。
   * 文件流不经过 API 进程，这里只是「生成 + 直传」的替身。
   */
  private async createSnapshot(alarm: AlarmEvent): Promise<string | undefined> {
    if (this.minio.state !== 'up') return undefined
    const key = `${alarm.id}.svg`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
      <rect width="640" height="360" fill="#0b1220"/>
      <rect x="16" y="16" width="608" height="328" fill="none" stroke="#1f6feb" stroke-width="2" rx="8"/>
      <text x="320" y="150" fill="#e6f1ff" font-family="monospace" font-size="42" text-anchor="middle">${alarm.plate_no}</text>
      <text x="320" y="200" fill="#7ee787" font-family="monospace" font-size="20" text-anchor="middle">${alarm.kind.toUpperCase()} · ${alarm.speed_kph ?? '-'} km/h</text>
      <text x="320" y="240" fill="#8b949e" font-family="monospace" font-size="16" text-anchor="middle">${alarm.checkpoint_name}</text>
      <text x="320" y="268" fill="#8b949e" font-family="monospace" font-size="14" text-anchor="middle">${alarm.ts}</text>
    </svg>`
    const uploaded = await this.minio.putObject(key, Buffer.from(svg), 'image/svg+xml')
    if (!uploaded) return undefined
    return (await this.minio.presignGet(key)) ?? undefined
  }

  /** 每 5 秒把窗口内的过车速度按路段聚合，写回 PostGIS 并推送路况 */
  private async flushRoadStatus(): Promise<void> {
    if (!this.window.length || !this.pg.available) return
    const cutoff = Date.now() - 60_000
    while (this.window.length && this.window[0].ts < cutoff) this.window.shift()
    if (!this.window.length) return

    const bucket = new Map<string, { sum: number; count: number }>()
    for (const row of this.window) {
      const road = this.meta.get(row.checkpoint_id)?.road_id
      if (!road) continue
      const item = bucket.get(road) ?? { sum: 0, count: 0 }
      item.sum += row.speed
      item.count += 1
      bucket.set(road, item)
    }
    if (!bucket.size) return

    const ids = [...bucket.keys()]
    const values = ids.map((id) => {
      const item = bucket.get(id)!
      return Math.round((item.sum / item.count) * 10) / 10
    })

    try {
      await this.pg.query(
        `UPDATE road AS r SET speed_kph = v.speed
           FROM (SELECT unnest($1::text[]) AS id, unnest($2::numeric[]) AS speed) AS v
          WHERE r.id = v.id`,
        [ids, values],
      )
    } catch (err) {
      this.log.warn(`路况写回失败: ${String((err as Error).message ?? err)}`)
      return
    }

    const patches: RoadStatusPatch[] = ids.map((id, i) => ({
      id,
      speed_kph: values[i],
      congestion: values[i] >= 55 ? 'free' : values[i] >= 30 ? 'slow' : 'jam',
    }))
    this.gateway.emitRoadStatus(patches)
  }

  recentPassages(limit: number): Promise<PassageEvent[]> {
    return this.tdengine.recentPassages(limit)
  }

  /** 演示/压测用：批量生成过车事件（不依赖 Kafka） */
  async simulate(count: number): Promise<{ produced: number }> {
    const ids = [...this.meta.keys()]
    if (!ids.length) return { produced: 0 }
    let produced = 0
    for (let i = 0; i < count; i += 1) {
      const checkpointId = ids[Math.floor(Math.random() * ids.length)]
      const speed = Math.round((20 + Math.random() * 90) * 10) / 10
      const passage: PassageEvent = {
        ts: new Date().toISOString(),
        checkpoint_id: checkpointId,
        plate_no: `粤B${String(10000 + Math.floor(Math.random() * 89999))}`,
        lane: 1 + Math.floor(Math.random() * 4),
        speed_kph: speed,
      }
      await this.ingestDirect(passage)
      produced += 1
    }
    return { produced }
  }
}

@Controller('checkpoints')
export class CheckpointController {
  constructor(private readonly service: CheckpointService) {}

  @Get('passages')
  async passages(@Query('limit') limit = '50') {
    const items = await this.service.recentPassages(Number(limit))
    return { count: items.length, items }
  }

  @Roles('admin')
  @Post('ingest')
  ingest(@Body() passage: PassageEvent) {
    return this.service.ingestDirect(passage)
  }

  @Roles('admin')
  @Post('simulate')
  simulate(@Query('count') count = '5') {
    return this.service.simulate(Math.min(Number(count) || 5, 200))
  }
}

@Module({
  imports: [RealtimeModule, SurveillanceModule],
  controllers: [CheckpointController],
  providers: [CheckpointService],
  exports: [CheckpointService],
})
export class CheckpointModule {}
