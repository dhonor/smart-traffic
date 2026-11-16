import { Body, Controller, Delete, Get, Injectable, Logger, Module, Param, Post, Query } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { PgService } from '../../infra/pg.service'
import { RedisService } from '../../infra/redis.service'
import { RealtimeGateway } from '../realtime/realtime.gateway'
import { RealtimeModule } from '../realtime/realtime.module'
import { Roles } from '../auth/auth.module'
import type { AlarmEvent, PassageEvent, SurveillanceRule } from '@traffic/shared-types'

const RULES_CHANNEL = 'chan:rules'

const DEFAULT_RULES: SurveillanceRule[] = [
  { id: 'RULE-SPEED', name: '快速路超速 20%', kind: 'speeding', speed_threshold: 96, active: true },
  { id: 'RULE-BLACK', name: '重点车辆布控', kind: 'blacklist', plate_pattern: '粤B9', active: true },
  { id: 'RULE-SLOW', name: '异常低速（疑似抛锚）', kind: 'speeding', speed_threshold: 10, active: false },
]

/**
 * 布控引擎。
 *
 * 规则单一真源在 PostGIS（surveillance_rule 表），重启不丢；
 * 内存副本只读、匹配不查库（高吞吐前提）；变更经 Redis Pub/Sub 通知各实例重载。
 * PostGIS 不可用时降级为内存规则（重启回退默认值），降级状态见于 /api/health。
 */
@Injectable()
export class SurveillanceService {
  private readonly log = new Logger('Surveillance')
  private rules: SurveillanceRule[] = [...DEFAULT_RULES]

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly gateway: RealtimeGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.pg.available) {
      try {
        await this.ensureRuleTable()
        this.rules = await this.loadRulesFromDb()
      } catch (err) {
        this.log.warn(`规则表不可用，降级为内存规则: ${String((err as Error).message ?? err)}`)
      }
    }
    if (this.redis.available) {
      const subscriber = await this.redis.duplicateSubscriber()
      if (subscriber) {
        await subscriber.subscribe(RULES_CHANNEL, async (raw?: string) => {
          let message: { rules?: SurveillanceRule[] } | null = null
          try {
            message = raw ? (JSON.parse(raw) as { rules?: SurveillanceRule[] }) : null
          } catch {
            message = null
          }
          // 有库的实例从库里重载；PG 降级实例直接用广播里的规则数组
          if (this.pg.available) {
            const fresh = await this.loadRulesFromDb().catch(() => null)
            if (fresh) this.rules = fresh
          } else if (message?.rules) {
            this.rules = message.rules
          }
          this.log.log(`规则副本已刷新: ${this.rules.filter((r) => r.active).length} 条生效`)
        })
      }
    }
    this.log.log(`布控规则就绪: ${this.rules.filter((r) => r.active).length} 条生效`)
  }

  /** 首次运行自动建表 + 播种默认规则（与 seed.ts 一致），老环境无需重跑 db:seed */
  private async ensureRuleTable(): Promise<void> {
    await this.pg.query(
      `CREATE TABLE IF NOT EXISTS surveillance_rule (
         id              text PRIMARY KEY,
         name            text NOT NULL,
         kind            text NOT NULL DEFAULT 'speeding',
         plate_pattern   text,
         speed_threshold numeric(5, 1),
         zone_id         text,
         active          boolean NOT NULL DEFAULT true,
         updated_at      timestamptz NOT NULL DEFAULT now()
       )`,
    )
    const row = await this.pg.one<{ total: string }>(
      `SELECT count(*)::text AS total FROM surveillance_rule`,
    )
    if (Number(row?.total ?? 0) === 0) {
      for (const rule of DEFAULT_RULES) {
        await this.pg.query(
          `INSERT INTO surveillance_rule (id, name, kind, plate_pattern, speed_threshold, zone_id, active)
           VALUES ($1, $2, $3, $4, $5, NULL, $6)
           ON CONFLICT (id) DO NOTHING`,
          [rule.id, rule.name, rule.kind, rule.plate_pattern ?? null, rule.speed_threshold ?? null, rule.active],
        )
      }
    }
  }

  private async loadRulesFromDb(): Promise<SurveillanceRule[]> {
    const rows = await this.pg.query<any>(
      `SELECT id, name, kind, plate_pattern, speed_threshold, zone_id, active
         FROM surveillance_rule
        ORDER BY id`,
    )
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      plate_pattern: row.plate_pattern ?? undefined,
      speed_threshold: row.speed_threshold === null ? undefined : Number(row.speed_threshold),
      zone_id: row.zone_id ?? undefined,
      active: row.active,
    }))
  }

  listRules(): SurveillanceRule[] {
    return this.rules
  }

  async saveRule(input: Partial<SurveillanceRule>): Promise<SurveillanceRule> {
    const rule: SurveillanceRule = {
      id: input.id ?? `RULE-${randomUUID().slice(0, 8)}`,
      name: input.name ?? '未命名规则',
      kind: input.kind ?? 'speeding',
      plate_pattern: input.plate_pattern,
      speed_threshold: input.speed_threshold,
      zone_id: input.zone_id,
      active: input.active ?? true,
    }

    if (this.pg.available) {
      // upsert 进库（单一真源），失败则退回内存副本，接口不 500
      await this.pg
        .query(
          `INSERT INTO surveillance_rule (id, name, kind, plate_pattern, speed_threshold, zone_id, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, kind = EXCLUDED.kind,
             plate_pattern = EXCLUDED.plate_pattern,
             speed_threshold = EXCLUDED.speed_threshold,
             zone_id = EXCLUDED.zone_id, active = EXCLUDED.active,
             updated_at = now()`,
          [rule.id, rule.name, rule.kind, rule.plate_pattern ?? null, rule.speed_threshold ?? null, rule.zone_id ?? null, rule.active],
        )
        .catch((err) => this.log.warn(`规则落库失败，仅内存生效: ${String(err.message ?? err)}`))
    }

    const index = this.rules.findIndex((item) => item.id === rule.id)
    if (index >= 0) this.rules[index] = rule
    else this.rules.push(rule)

    // 广播：带库实例重载自库，降级实例直接拿数组
    const payload = this.pg.available
      ? { at: Date.now() }
      : { at: Date.now(), rules: this.rules }
    await this.redis.publish(RULES_CHANNEL, payload)
    this.gateway.emitRuleChanged()
    return rule
  }

  async deleteRule(id: string): Promise<{ ok: boolean }> {
    if (this.pg.available) {
      await this.pg
        .query(`DELETE FROM surveillance_rule WHERE id = $1`, [id])
        .catch((err) => this.log.warn(`规则删除失败，仅内存生效: ${String(err.message ?? err)}`))
    }
    this.rules = this.rules.filter((rule) => rule.id !== id)

    const payload = this.pg.available
      ? { at: Date.now() }
      : { at: Date.now(), rules: this.rules }
    await this.redis.publish(RULES_CHANNEL, payload)
    this.gateway.emitRuleChanged()
    return { ok: true }
  }

  /** 规则匹配在内存完成，不查库 */
  match(passage: PassageEvent): Omit<AlarmEvent, 'id' | 'ts' | 'checkpoint_name'> | null {
    for (const rule of this.rules) {
      if (!rule.active) continue

      if (rule.kind === 'speeding' && rule.speed_threshold !== undefined) {
        if (passage.speed_kph > rule.speed_threshold) {
          return {
            checkpoint_id: passage.checkpoint_id,
            plate_no: passage.plate_no,
            kind: 'speeding',
            level: 'warning',
            speed_kph: passage.speed_kph,
          }
        }
        // 低速规则用同一 kind，阈值语义由规则名表达
        if (rule.speed_threshold < 20 && passage.speed_kph < rule.speed_threshold) {
          return {
            checkpoint_id: passage.checkpoint_id,
            plate_no: passage.plate_no,
            kind: 'speeding',
            level: 'info',
            speed_kph: passage.speed_kph,
          }
        }
      }

      if (rule.kind === 'blacklist' && rule.plate_pattern) {
        if (passage.plate_no.startsWith(rule.plate_pattern)) {
          return {
            checkpoint_id: passage.checkpoint_id,
            plate_no: passage.plate_no,
            kind: 'blacklist',
            level: 'critical',
            speed_kph: passage.speed_kph,
          }
        }
      }
    }
    return null
  }

  async alarmCounts(): Promise<Record<string, number>> {
    if (!this.pg.available) return { critical: 0, warning: 0, info: 0 }
    const rows = await this.pg.query<{ level: string; count: string }>(
      `SELECT level, count(*)::text AS count FROM alarm WHERE acked_at IS NULL GROUP BY level`,
    )
    const counts: Record<string, number> = { critical: 0, warning: 0, info: 0 }
    for (const row of rows) counts[row.level] = Number(row.count)
    return counts
  }

  async saveAlarm(alarm: AlarmEvent, payload: Record<string, unknown> = {}): Promise<void> {
    if (this.pg.available) {
      await this.pg
        .query(
          `INSERT INTO alarm (id, checkpoint_id, plate_no, kind, level, ts, speed_kph, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING`,
          [
            alarm.id,
            alarm.checkpoint_id,
            alarm.plate_no,
            alarm.kind,
            alarm.level,
            alarm.ts,
            alarm.speed_kph ?? null,
            JSON.stringify(payload),
          ],
        )
        .catch((err) => this.log.warn(`告警落库失败: ${String(err.message ?? err)}`))
    }
  }

  /**
   * 告警历史查询：分页（limit/offset）+ 条件筛选（车牌/类型/级别/时间范围）。
   * 条件拼进 WHERE，参数一律走占位符，total 用同一 WHERE 保证翻页口径一致。
   */
  async listAlarms(
    opts: {
      limit?: number
      offset?: number
      openOnly?: boolean
      plate?: string
      kind?: string
      level?: string
      from?: string
      to?: string
    } = {},
  ): Promise<{ total: number; items: AlarmEvent[] }> {
    if (!this.pg.available) return { total: 0, items: [] }

    const conditions: string[] = []
    const params: unknown[] = []
    const bind = (value: unknown): string => `$${params.push(value)}`

    if (opts.openOnly) conditions.push('a.acked_at IS NULL')
    if (opts.plate) conditions.push(`a.plate_no LIKE ${bind(`%${opts.plate}%`)}`)
    if (opts.kind) conditions.push(`a.kind = ${bind(opts.kind)}`)
    if (opts.level) conditions.push(`a.level = ${bind(opts.level)}`)
    if (opts.from) conditions.push(`a.ts >= ${bind(opts.from)}::timestamptz`)
    if (opts.to) conditions.push(`a.ts <= ${bind(opts.to)}::timestamptz`)
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const totalRows = await this.pg.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM alarm a ${where}`,
      params,
    )

    const rows = await this.pg.query<any>(
      `SELECT a.id, a.checkpoint_id, coalesce(c.name, a.checkpoint_id) AS checkpoint_name,
              a.plate_no, a.kind, a.level, a.ts, a.speed_kph, a.payload, a.acked_at
         FROM alarm a LEFT JOIN checkpoint c ON c.id = a.checkpoint_id
        ${where}
        ORDER BY a.ts DESC
        LIMIT ${bind(opts.limit ?? 50)} OFFSET ${bind(opts.offset ?? 0)}`,
      params,
    )
    const items = rows.map((row) => ({
      id: row.id,
      checkpoint_id: row.checkpoint_id,
      checkpoint_name: row.checkpoint_name,
      plate_no: row.plate_no,
      kind: row.kind,
      level: row.level,
      ts: new Date(row.ts).toISOString(),
      speed_kph: row.speed_kph === null ? undefined : Number(row.speed_kph),
      snapshot_url: row.payload?.snapshot_url,
      acked_at: row.acked_at ? new Date(row.acked_at).toISOString() : null,
    }))
    return { total: Number(totalRows[0]?.total ?? 0), items }
  }

  async ack(id: string): Promise<{ ok: boolean }> {
    if (this.pg.available) {
      await this.pg.query(`UPDATE alarm SET acked_at = now() WHERE id = $1`, [id])
    }
    return { ok: true }
  }
}

@Controller('surveillance')
export class SurveillanceController {
  constructor(private readonly service: SurveillanceService) {}

  @Get('rules')
  rules() {
    return { items: this.service.listRules() }
  }

  @Roles('admin')
  @Post('rules')
  save(@Body() body: Partial<SurveillanceRule>) {
    return this.service.saveRule(body)
  }

  @Roles('admin')
  @Delete('rules/:id')
  remove(@Param('id') id: string) {
    return this.service.deleteRule(id)
  }

  @Get('alarms')
  async alarms(
    @Query('limit') limit = '50',
    @Query('offset') offset = '0',
    @Query('open') open = 'false',
    @Query('plate') plate?: string,
    @Query('kind') kind?: string,
    @Query('level') level?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const { total, items } = await this.service.listAlarms({
      limit: Math.min(Math.max(Number(limit) || 50, 1), 1000),
      offset: Math.max(Number(offset) || 0, 0),
      openOnly: open === 'true',
      plate: plate?.trim() || undefined,
      kind: kind?.trim() || undefined,
      level: level?.trim() || undefined,
      from: from?.trim() || undefined,
      to: to?.trim() || undefined,
    })
    return { count: items.length, total, items, counts: await this.service.alarmCounts() }
  }

  @Roles('admin')
  @Post('alarms/:id/ack')
  ack(@Param('id') id: string) {
    return this.service.ack(id)
  }
}

@Module({
  imports: [RealtimeModule],
  controllers: [SurveillanceController],
  providers: [SurveillanceService],
  exports: [SurveillanceService],
})
export class SurveillanceModule {}
