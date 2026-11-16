/**
 * 运行配置。
 *
 * 原则：每个外部依赖都有「缺失时的降级路径」，服务不会因为少一个中间件就起不来。
 * 降级状态会如实出现在 /api/health，前端顶部据此显示「直连 / Kafka」等标签。
 */

const bool = (value: string | undefined, fallback = false): boolean =>
  value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())

export const config = {
  port: Number(process.env.API_PORT ?? 8080),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5174,http://127.0.0.1:5174')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),

  pgUrl: process.env.DATABASE_URL ?? 'postgresql://traffic:traffic@localhost:5432/traffic',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

  /** 为空 => 直接模式：不依赖 Kafka，过车事件走 HTTP 直连（开发/演示默认） */
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? '').split(',').filter(Boolean),
  kafkaTopicPassage: process.env.KAFKA_TOPIC_PASSAGE ?? 'checkpoint.passage',
  kafkaTopicAlarm: process.env.KAFKA_TOPIC_ALARM ?? 'alarm.events',

  /** 为空 => 时序写入降级为进程内环形缓冲，接口照常可读 */
  tdengineUrl: process.env.TDENGINE_URL ?? '',
  tdengineUser: process.env.TDENGINE_USER ?? 'root',
  tdenginePassword: process.env.TDENGINE_PASSWORD ?? 'taosdata',

  /** 三个都为空 => 不启用对象存储，抓拍图返回占位地址 */
  minioEndPoint: process.env.MINIO_ENDPOINT ?? '',
  minioPort: Number(process.env.MINIO_PORT ?? 9000),
  minioAccessKey: process.env.MINIO_ACCESS_KEY ?? 'traffic',
  minioSecretKey: process.env.MINIO_SECRET_KEY ?? 'traffic123',
  minioBucket: process.env.MINIO_BUCKET ?? 'snapshots',
  minioPublicUrl: process.env.MINIO_PUBLIC_URL ?? 'http://localhost:9000',

  /** 国标网关（WVP-PRO 等）REST 地址；为空 => 适配器返回「未接入」而非报错 */
  gb28181Gateway: process.env.GB28181_GATEWAY ?? '',

  /** 车辆状态模拟推送周期（生产由定位流驱动，这里只做演示） */
  vehicleTickMs: Number(process.env.VEHICLE_TICK_MS ?? 1000),
  // 700 是"看得见车流"与"集显扛得住"的折中；调大会线性拉高加性光条的过绘制
  vehicleCount: Number(process.env.VEHICLE_COUNT ?? 700),

  enableSimulator: bool(process.env.ENABLE_SIMULATOR, true),

  /**
   * 鉴权：HS256 JWT + 环境变量用户表。
   * 默认密钥/账号仅供本机演示，生产必须注入 AUTH_JWT_SECRET 与真实用户（DB + bcrypt）。
   * AUTH_USERS 格式：name:password:role,name:password:role（role = admin | viewer）
   */
  authJwtSecret: process.env.AUTH_JWT_SECRET ?? 'dev-secret-change-me',
  authTtlHours: Number(process.env.AUTH_TTL_HOURS ?? 168),
  authUsers: (process.env.AUTH_USERS ?? 'admin:admin123:admin,viewer:viewer123:viewer')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [name = '', password = '', role = 'viewer'] = item.split(':')
      return { name, password, role: role === 'admin' ? ('admin' as const) : ('viewer' as const) }
    })
    .filter((user) => user.name && user.password),
}

export type DependencyState = 'up' | 'down' | 'disabled'
