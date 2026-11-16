import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import axios from 'axios'
import { config, DependencyState } from '../config'
import type { PassageEvent } from '@traffic/shared-types'

/**
 * TDengine：卡口过车原始记录（高频写入）。
 *
 * 用 REST（taosAdapter:6041）而不是原生驱动 —— 免去 C 客户端依赖，
 * 容器里也不需要编译工具链。写入失败只降级，不影响实时链路。
 *
 * 建模：超级表 `traffic.passage`，一卡口一子表（`passage_<checkpoint>`），
 * checkpoint_id 同时作为普通列（便于直接 select）与 tag（便于按卡口过滤）。
 */
@Injectable()
export class TdengineService implements OnModuleInit {
  private readonly log = new Logger('TDengine')
  private readonly ring: PassageEvent[] = []
  state: DependencyState = 'disabled'
  lastError = ''

  async onModuleInit(): Promise<void> {
    if (!config.tdengineUrl) {
      this.log.warn('未配置 TDENGINE_URL，过车记录降级为进程内环形缓冲（最近 500 条）')
      return
    }
    try {
      await this.exec('SHOW DATABASES')
      await this.exec('CREATE DATABASE IF NOT EXISTS traffic')
      await this.exec(
        'CREATE STABLE IF NOT EXISTS traffic.passage ' +
          '(ts TIMESTAMP, checkpoint_id NCHAR(32), plate NCHAR(16), speed FLOAT, lane INT) ' +
          "TAGS (cp NCHAR(32))",
      )
      this.state = 'up'
      this.log.log(`TDengine 已连接: ${config.tdengineUrl}`)
    } catch (err) {
      this.state = 'down'
      this.lastError = String((err as Error).message ?? err)
      this.log.warn(`TDengine 不可用（过车记录降级为内存缓冲）: ${this.lastError}`)
    }
  }

  private async exec(sql: string): Promise<any> {
    const response = await axios.post(`${config.tdengineUrl}/rest/sql`, sql, {
      auth: { username: config.tdengineUser, password: config.tdenginePassword },
      timeout: 4000,
      headers: { 'Content-Type': 'text/plain' },
    })
    if (response.data?.code !== 0 && response.data?.code !== undefined) {
      throw new Error(`TDengine ${response.data.code}: ${response.data.desc}`)
    }
    return response.data
  }

  async insertPassage(event: PassageEvent): Promise<void> {
    this.pushRing(event)
    if (this.state !== 'up') return

    const safeId = event.checkpoint_id.replace(/[^a-zA-Z0-9_]/g, '_')
    const table = `traffic.passage_${safeId}`
    const ts = new Date(event.ts).getTime()
    const plate = event.plate_no.replace(/'/g, '')
    const sql =
      `INSERT INTO ${table} USING traffic.passage TAGS ('${event.checkpoint_id}') ` +
      `VALUES (${ts}, '${event.checkpoint_id}', '${plate}', ${event.speed_kph}, ${event.lane})`
    try {
      await this.exec(sql)
    } catch (err) {
      this.state = 'down'
      this.lastError = String((err as Error).message ?? err)
      this.log.warn('TDengine 写入失败，降级为内存缓冲')
    }
  }

  private pushRing(event: PassageEvent): void {
    this.ring.push(event)
    if (this.ring.length > 500) this.ring.splice(0, this.ring.length - 500)
  }

  /** 最近的过车记录：TDengine 可用时读库，否则读环形缓冲 */
  async recentPassages(limit = 50): Promise<PassageEvent[]> {
    if (this.state !== 'up') {
      return this.ring.slice(-limit).reverse()
    }
    try {
      const payload = await this.exec(
        `SELECT ts, checkpoint_id, plate, speed, lane FROM traffic.passage ORDER BY ts DESC LIMIT ${limit}`,
      )
      const rows: any[][] = payload?.data ?? []
      return rows.map((row) => ({
        ts: new Date(Number(row[0])).toISOString(),
        checkpoint_id: String(row[1]),
        plate_no: String(row[2]),
        speed_kph: Number(row[3]),
        lane: Number(row[4]),
      }))
    } catch {
      return this.ring.slice(-limit).reverse()
    }
  }
}
