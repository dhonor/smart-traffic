import 'reflect-metadata'
import { Logger, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { RedisIoAdapter } from './infra/redis-io.adapter'
import { config } from './config'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { cors: false })
  const log = new Logger('Bootstrap')

  const wsAdapter = new RedisIoAdapter(app)
  await wsAdapter.connectToRedis(config.redisUrl)
  app.useWebSocketAdapter(wsAdapter)

  app.setGlobalPrefix('api')
  app.enableCors({ origin: config.corsOrigin, credentials: false })
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidUnknownValues: false }))
  app.enableShutdownHooks()

  await app.listen(config.port, '0.0.0.0')
  log.log(`API 就绪: http://localhost:${config.port}/api/health`)
  log.log(`WebSocket: ws://localhost:${config.port}/realtime（namespace）`)
}

void bootstrap()
