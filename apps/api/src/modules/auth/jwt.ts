/**
 * 最小 HS256 JWT：header.payload.signature（base64url）。
 *
 * 不引 @nestjs/jwt：签发/校验共 40 行，依赖面与攻击面都更小；
 * 格式是标准 JWT，将来换成 passport-jwt 或独立鉴权服务时无迁移成本。
 * 签名比较用 timingSafeEqual，避免时序侧信道。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

export interface JwtPayload {
  /** 用户名 */
  sub: string
  role: string
  /** 过期时间（秒，Unix） */
  exp: number
}

function hmac(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest()
}

export function signJwt(
  payload: Omit<JwtPayload, 'exp'>,
  secret: string,
  ttlHours: number,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlHours * 3600 }),
  ).toString('base64url')
  const signed = `${header}.${body}`
  return `${signed}.${hmac(signed, secret).toString('base64url')}`
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const body = `${parts[0]}.${parts[1]}`

  let given: Buffer
  try {
    given = Buffer.from(parts[2], 'base64url')
  } catch {
    return null
  }
  const expected = hmac(body, secret)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as JwtPayload
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
