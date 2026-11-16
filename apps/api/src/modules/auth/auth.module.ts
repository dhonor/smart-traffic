import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Post,
  Req,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import { IsString, MinLength } from 'class-validator'
import { config } from '../../config'
import { signJwt, verifyJwt } from './jwt'

export type Role = 'admin' | 'viewer'

export interface AuthUser {
  name: string
  role: Role
}

const IS_PUBLIC = 'auth:public'
const ROLES = 'auth:roles'

/** 豁免鉴权（登录接口、健康检查——探活不能要求登录） */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true)

/** 角色限制：admin 可写，viewer 只读；未标注的接口登录即可访问 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES, roles)

@Injectable()
export class AuthService {
  private readonly users: Array<AuthUser & { password: string }> = config.authUsers

  authenticate(name: string, password: string): AuthUser | null {
    const user = this.users.find((item) => item.name === name)
    if (user && user.password === password) return { name: user.name, role: user.role }
    // 注：演示用明文比对；防时序探测需 DB + bcrypt，生产化待办见 docs/02 §6
    return null
  }

  issue(user: AuthUser): { token: string; expiresInHours: number } {
    return {
      token: signJwt({ sub: user.name, role: user.role }, config.authJwtSecret, config.authTtlHours),
      expiresInHours: config.authTtlHours,
    }
  }

  verify(token: string): AuthUser | null {
    const payload = verifyJwt(token, config.authJwtSecret)
    return payload ? { name: payload.sub, role: payload.role === 'admin' ? 'admin' : 'viewer' } : null
  }
}

/**
 * 全局守卫（APP_GUARD）：默认所有路由要求 Bearer 令牌，
 * @Public() 豁免，@Roles() 限定角色。REST 与 WS 走同一套 JWT。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler()
    const klass = context.getClass()
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, klass])) return true

    const request = context.switchToHttp().getRequest()
    const header: string | undefined = request.headers?.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const user = this.auth.verify(token)
    if (!user) throw new UnauthorizedException('缺少或无效的令牌，请先登录')

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, [handler, klass])
    if (roles?.length && !roles.includes(user.role)) {
      throw new ForbiddenException(`需要 ${roles.join('/')} 权限`)
    }

    request.user = user
    return true
  }
}

class LoginDto {
  @IsString()
  @MinLength(1)
  name!: string

  @IsString()
  @MinLength(1)
  password!: string
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    const user = this.auth.authenticate(dto.name, dto.password)
    if (!user) throw new UnauthorizedException('用户名或密码错误')
    return { ...this.auth.issue(user), name: user.name, role: user.role }
  }

  @Get('me')
  me(@Req() request: { user?: AuthUser }) {
    return request.user
  }
}

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
