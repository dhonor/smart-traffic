import { INestApplicationContext, Logger } from '@nestjs/common'
import { IoAdapter } from '@nestjs/platform-socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import { createClient } from 'redis'
import type { ServerOptions } from 'socket.io'

/**
 * Socket.IO 的 Redis Adapter 必须在**创建 io server 之前**挂好。
 *
 * 放在 Gateway 的 afterInit 里挂是错的：那时 server.adapter 已被使用过，
 * 而且 afterInit 拿到的是 Namespace 而不是 io 实例（会报 server.adapter is not a function）。
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly log = new Logger('RedisIoAdapter')
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null
  private clients: Array<ReturnType<typeof createClient>> = []

  constructor(app: INestApplicationContext) {
    super(app)
  }

  async connectToRedis(url: string): Promise<boolean> {
    try {
      const pub = createClient({ url })
      const sub = pub.duplicate()
      await Promise.all([pub.connect(), sub.connect()])
      this.clients = [pub, sub]
      this.adapterConstructor = createAdapter(pub as never, sub as never)
      this.log.log('Socket.IO 已挂载 Redis Adapter（多实例广播可用）')
      return true
    } catch (err) {
      this.log.warn(`Redis Adapter 不可用，退化为单实例: ${String((err as Error).message ?? err)}`)
      return false
    }
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options)
    if (this.adapterConstructor) server.adapter(this.adapterConstructor)
    return server
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((client) => client.quit().catch(() => undefined)))
  }
}
