import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Consumer, Kafka, Producer } from 'kafkajs'
import { config, DependencyState } from '../config'

/**
 * Kafka 生产者 + 消费者工厂。
 *
 * 双消费者组是这套架构的关键：`realtime-push` 只做规则匹配与推送（轻、快、不等落库），
 * `persistence` 负责批量落库（TDengine + PostGIS），两者独立 offset、互不阻塞。
 *
 * 未配置 KAFKA_BROKERS 时整体降级为「直接模式」：过车事件走 HTTP 直连，
 * 上面那条流水线在进程内同步执行一遍，行为与双通道一致（只是没有缓冲与背压能力）。
 */
@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Kafka')
  private kafka: Kafka | null = null
  private producer: Producer | null = null
  private consumers: Consumer[] = []
  state: DependencyState = 'disabled'
  lastError = ''

  get enabled(): boolean {
    return config.kafkaBrokers.length > 0
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.log.warn('未配置 KAFKA_BROKERS，使用直接模式（无缓冲/无背压）')
      return
    }
    try {
      this.kafka = new Kafka({
        clientId: 'traffic-api',
        brokers: config.kafkaBrokers,
        retry: { retries: 3, initialRetryTime: 300 },
      })
      this.producer = this.kafka.producer({ allowAutoTopicCreation: true })
      await this.producer.connect()
      this.state = 'up'
      this.log.log(`Kafka 已连接: ${config.kafkaBrokers.join(',')}`)
    } catch (err) {
      this.state = 'down'
      this.lastError = String((err as Error).message ?? err)
      this.log.warn(`Kafka 不可用，退到直接模式: ${this.lastError}`)
      this.kafka = null
      this.producer = null
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => consumer.disconnect().catch(() => undefined)))
    await this.producer?.disconnect().catch(() => undefined)
  }

  async publish(topic: string, message: unknown): Promise<void> {
    if (!this.producer || this.state !== 'up') return
    try {
      await this.producer.send({
        topic,
        messages: [{ value: JSON.stringify(message), timestamp: Date.now().toString() }],
      })
    } catch (err) {
      this.log.warn(`Kafka 发送失败 ${topic}: ${String((err as Error).message ?? err)}`)
    }
  }

  /**
   * 创建消费者。分区数 ≥ 消费者实例数是扩容前提（见架构文档 §5）。
   */
  async createConsumer(groupId: string, topics: string[], handler: (payload: any) => Promise<void>): Promise<void> {
    if (!this.kafka) return
    const consumer = this.kafka.consumer({ groupId, sessionTimeout: 30_000 })
    this.consumers.push(consumer)
    try {
      await consumer.connect()
      for (const topic of topics) {
        await consumer.subscribe({ topic, fromBeginning: false })
      }
      await consumer.run({
        eachMessage: async ({ message, topic }) => {
          if (!message.value) return
          try {
            await handler(JSON.parse(message.value.toString()))
          } catch (err) {
            // 毒消息不阻塞主链路：这里落日志，生产环境应投递 DLQ 并告警
            this.log.error(`消费失败 topic=${topic} group=${groupId}: ${String((err as Error).message ?? err)}`)
          }
        },
      })
      this.log.log(`消费者组 ${groupId} 已启动，订阅 ${topics.join(',')}`)
    } catch (err) {
      this.log.warn(`消费者组 ${groupId} 启动失败: ${String((err as Error).message ?? err)}`)
    }
  }
}
