import { Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { Client } from 'minio'
import { config, DependencyState } from '../config'

/**
 * MinIO：抓拍图 / 告警附件 / 模型文件。
 *
 * 关键纪律：文件流不经过 NestJS —— 前端拿预签名 URL 直传/直下，
 * 应用只负责签发与权限。未配置时降级为占位图地址，不会让接口 500。
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private readonly log = new Logger('MinIO')
  private client: Client | null = null
  state: DependencyState = 'disabled'
  lastError = ''

  async onModuleInit(): Promise<void> {
    if (!config.minioEndPoint) {
      this.log.warn('未配置 MINIO_ENDPOINT，抓拍图返回占位地址')
      return
    }
    try {
      this.client = new Client({
        endPoint: config.minioEndPoint,
        port: config.minioPort,
        useSSL: false,
        accessKey: config.minioAccessKey,
        secretKey: config.minioSecretKey,
      })
      const exists = await this.client.bucketExists(config.minioBucket)
      if (!exists) await this.client.makeBucket(config.minioBucket)
      this.state = 'up'
      this.log.log(`MinIO 已连接: ${config.minioEndPoint}:${config.minioPort}/${config.minioBucket}`)
    } catch (err) {
      this.state = 'down'
      this.lastError = String((err as Error).message ?? err)
      this.log.warn(`MinIO 不可用（抓拍图降级为占位图）: ${this.lastError}`)
      this.client = null
    }
  }

  /** 前端直传用：预签名 PUT */
  async presignPut(key: string, expirySeconds = 600): Promise<string | null> {
    if (!this.client) return null
    return this.client.presignedPutObject(config.minioBucket, key, expirySeconds)
  }

  /** 前端直下用：预签名 GET（公网地址替换，便于浏览器直连） */
  async presignGet(key: string, expirySeconds = 3600): Promise<string | null> {
    if (!this.client) return null
    const url = await this.client.presignedGetObject(config.minioBucket, key, expirySeconds)
    return url.replace(/^http:\/\/[^/]+/, config.minioPublicUrl)
  }

  /** 演示用：把生成的抓拍图（SVG）写进对象存储 */
  async putObject(key: string, body: Buffer, contentType: string): Promise<boolean> {
    if (!this.client) return false
    try {
      await this.client.putObject(config.minioBucket, key, body, body.length, { 'Content-Type': contentType })
      return true
    } catch (err) {
      this.log.warn(`写入对象失败 ${key}: ${String((err as Error).message ?? err)}`)
      return false
    }
  }

  get bucket(): string {
    return config.minioBucket
  }
}
