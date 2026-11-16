import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { createClient, RedisClientType } from 'redis'
import { config, DependencyState } from '../config'

/**
 * Redis：热点缓存 / 布控规则副本 / 去重 / 跨实例广播。
 *
 * key 前缀按用途隔离：`cache:` `rule:` `dedupe:` `chan:`，便于排查与清理。
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Redis')
  private client: RedisClientType | null = null
  state: DependencyState = 'down'
  lastError = ''

  async onModuleInit(): Promise<void> {
    try {
      const client = createClient({ url: config.redisUrl }) as RedisClientType
      client.on('error', (err) => {
        this.state = 'down'
        this.lastError = String(err?.message ?? err)
      })
      await client.connect()
      await client.ping()
      this.client = client
      this.state = 'up'
      this.log.log(`Redis 已连接: ${config.redisUrl}`)
    } catch (err) {
      this.state = 'down'
      this.lastError = String((err as Error).message ?? err)
      this.log.warn(`Redis 不可用（缓存降级为内存，跨实例广播关闭）: ${this.lastError}`)
      this.client = null
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined)
  }

  get available(): boolean {
    return this.state === 'up' && this.client !== null
  }

  get raw(): RedisClientType | null {
    return this.client
  }

  async getJson<T>(key: string): Promise<T | null> {
    if (!this.client) return null
    const raw = await this.client.get(key)
    return raw ? (JSON.parse(raw) as T) : null
  }

  async setJson(key: string, value: unknown, ttlSeconds = 30): Promise<void> {
    if (!this.client) return
    await this.client.set(key, JSON.stringify(value), { EX: ttlSeconds })
  }

  /** 短窗口去重：同一 plate+checkpoint 在 N 秒内只处理一次 */
  async dedupe(key: string, ttlSeconds: number): Promise<boolean> {
    if (!this.client) return true
    const result = await this.client.set(`dedupe:${key}`, '1', { NX: true, EX: ttlSeconds })
    return result === 'OK'
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    if (!this.client) return
    await this.client.publish(channel, JSON.stringify(payload))
  }

  async duplicateSubscriber(): Promise<RedisClientType | null> {
    if (!this.client) return null
    const sub = this.client.duplicate() as RedisClientType
    await sub.connect()
    return sub
  }
}
