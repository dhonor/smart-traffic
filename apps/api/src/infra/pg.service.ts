import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common'
import { Pool, QueryResultRow } from 'pg'
import { config, DependencyState } from '../config'

/**
 * PostGIS 访问层。
 *
 * 纪律（来自架构决策）：空间谓词一律写原生参数化 SQL，不在 ORM 里拼 `find`。
 * 这里只提供 `query` 一个入口，避免上层各写各的连接管理。
 */
@Injectable()
export class PgService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Pg')
  private pool: Pool | null = null
  state: DependencyState = 'down'
  lastError = ''

  async onModuleInit(): Promise<void> {
    try {
      this.pool = new Pool({ connectionString: config.pgUrl, max: 10, idleTimeoutMillis: 30_000 })
      await this.pool.query('SELECT 1')
      this.state = 'up'
      this.log.log(`PostGIS 已连接: ${config.pgUrl.replace(/:[^:@]+@/, ':***@')}`)
    } catch (err) {
      this.state = 'down'
      this.lastError = String((err as Error).message ?? err)
      this.log.error(`PostGIS 连接失败（服务继续启动，空间接口返回 503）: ${this.lastError}`)
      this.pool = null
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => undefined)
  }

  get available(): boolean {
    return this.pool !== null && this.state === 'up'
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.pool) {
      throw new ServiceUnavailableException('PostGIS 未连接，请先启动 docker compose up -d postgis 并执行 pnpm db:seed')
    }
    const started = Date.now()
    const result = await this.pool.query<T>(sql, params as never[])
    const cost = Date.now() - started
    if (cost > 300) this.log.warn(`慢查询 ${cost}ms: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`)
    return result.rows
  }

  async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }
}
