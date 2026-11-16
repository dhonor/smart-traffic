import { Module } from '@nestjs/common'
import { InfraModule } from './infra/infra.module'
import { AuthModule } from './modules/auth/auth.module'
import { CheckpointModule } from './modules/checkpoint/checkpoint.module'
import { DeviceModule } from './modules/device/device.module'
import { Gb28181Module } from './modules/gb28181/gb28181.module'
import { HealthModule } from './modules/health/health.module'
import { RealtimeModule } from './modules/realtime/realtime.module'
import { SpatialModule } from './modules/spatial/spatial.module'
import { SurveillanceModule } from './modules/surveillance/surveillance.module'
import { TrajectoryModule } from './modules/trajectory/trajectory.module'

/**
 * 模块化单体。
 *
 * 所有领域模块部署在同一进程，模块间通过 Service 接口 / 进程内调用通信，物理上不拆分；
 * 拆分触发信号见 docs/01（轨迹 CPU 瓶颈 / 信令独立部署 / 规则匹配复杂度）。
 * 拆分时把进程内调用换成 Kafka Topic，今天的 Service 接口就是明天的服务契约。
 */
@Module({
  imports: [
    InfraModule,
    AuthModule,
    RealtimeModule,
    SurveillanceModule,
    CheckpointModule,
    DeviceModule,
    SpatialModule,
    TrajectoryModule,
    Gb28181Module,
    HealthModule,
  ],
})
export class AppModule {}
