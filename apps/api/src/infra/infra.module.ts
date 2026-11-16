import { Global, Module } from '@nestjs/common'
import { KafkaService } from './kafka.service'
import { MinioService } from './minio.service'
import { PgService } from './pg.service'
import { RedisService } from './redis.service'
import { TdengineService } from './tdengine.service'

/**
 * 基础设施全局模块。
 *
 * 这里只放「与业务无关的连接与客户端」，任何领域模块都可以注入；
 * 反向依赖（infra 依赖 domain）是禁止的，否则降级逻辑会被业务语义污染。
 */
@Global()
@Module({
  providers: [PgService, RedisService, TdengineService, KafkaService, MinioService],
  exports: [PgService, RedisService, TdengineService, KafkaService, MinioService],
})
export class InfraModule {}
