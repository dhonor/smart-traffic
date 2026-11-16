import { Module } from '@nestjs/common'
import { RealtimeGateway } from './realtime.gateway'
import { VehicleSimService } from './vehicle-sim.service'

@Module({
  providers: [RealtimeGateway, VehicleSimService],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
