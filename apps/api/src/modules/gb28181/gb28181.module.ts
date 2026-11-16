import { Controller, Get, Logger, Module, Param, ServiceUnavailableException } from '@nestjs/common'
import axios from 'axios'
import { config, DependencyState } from '../../config'

/**
 * GB28181 适配器（**克制**的边界）。
 *
 * SIP 信令的异步/长连接/状态敏感特性与 HTTP 请求-响应模型不同，这里不实现 SIP 状态机，
 * 只做开源国标网关（WVP-PRO 等）的 REST 适配：目录查询、播放地址获取。
 * 媒体流由 ZLMediaKit/SRS 接收转封装，**不经过 API 进程**。
 *
 * 未配置 GB28181_GATEWAY 时，接口返回明确的「未接入」，而不是假装成功。
 */
@Controller('gb28181')
export class Gb28181Controller {
  private readonly log = new Logger('GB28181')
  state: DependencyState = 'disabled'
  lastError = ''

  private get configured(): boolean {
    return Boolean(config.gb28181Gateway)
  }

  @Get('status')
  async status() {
    if (!this.configured) {
      return { configured: false, state: 'disabled', note: '未配置 GB28181_GATEWAY（推荐接入 WVP-PRO 等开源网关）' }
    }
    try {
      await axios.get(`${config.gb28181Gateway}/api/v1/server/media_server/list`, { timeout: 2500 })
      this.state = 'up'
      return { configured: true, state: 'up', gateway: config.gb28181Gateway }
    } catch (err) {
      this.state = 'down'
      this.lastError = String((err as Error).message ?? err)
      return { configured: true, state: 'down', gateway: config.gb28181Gateway, error: this.lastError }
    }
  }

  @Get('devices')
  async devices() {
    if (!this.configured) throw new ServiceUnavailableException('未接入国标网关，无法查询设备目录')
    try {
      const { data } = await axios.get(`${config.gb28181Gateway}/api/v1/device/list`, { timeout: 4000 })
      return { count: data?.total ?? data?.data?.length ?? 0, items: data?.data ?? [] }
    } catch (err) {
      throw new ServiceUnavailableException(`国标网关不可达: ${String((err as Error).message ?? err)}`)
    }
  }

  /** 取播放地址；真正的视频流由媒体服务器直接发给浏览器 */
  @Get('stream/:code')
  async stream(@Param('code') code: string) {
    if (!this.configured) throw new ServiceUnavailableException('未接入国标网关，无法获取播放地址')
    try {
      const { data } = await axios.get(`${config.gb28181Gateway}/api/play/start/${code}`, { timeout: 5000 })
      return {
        code,
        // flv / hls / rtc 三种地址由网关返回，前端按低延迟优先选择
        urls: data?.data ?? data,
        note: '媒体流由 ZLMediaKit/SRS 直接对浏览器输出，不经过 API 进程',
      }
    } catch (err) {
      throw new ServiceUnavailableException(`取流失败: ${String((err as Error).message ?? err)}`)
    }
  }
}

@Module({
  controllers: [Gb28181Controller],
})
export class Gb28181Module {}
