/**
 * 客户端鉴权状态：JWT 存 localStorage（简单可靠，XSS 风险由内容安全策略与框架转义兜底）。
 * 401 时由 http 层广播 `AUTH_REQUIRED_EVENT`，App.vue 据此弹出登录层。
 */

export interface AuthUser {
  name: string
  role: 'admin' | 'viewer'
}

const STORAGE_KEY = 'traffic.auth'
export const AUTH_REQUIRED_EVENT = 'traffic:auth-required'

interface StoredAuth extends AuthUser {
  token: string
}

function read(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredAuth) : null
  } catch {
    return null
  }
}

export function loadAuth(): AuthUser | null {
  const auth = read()
  return auth ? { name: auth.name, role: auth.role } : null
}

export function getToken(): string | null {
  return read()?.token ?? null
}

export function saveAuth(user: AuthUser, token: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...user, token }))
}

export function clearAuth(): void {
  localStorage.removeItem(STORAGE_KEY)
}
