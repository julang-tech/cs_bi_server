export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'error'

export type AuthUser = {
  name?: string
  email?: string
  avatar_url?: string
  open_id?: string
  tenant_key?: string
  [key: string]: unknown
}

export type AuthState = {
  status: AuthStatus
  authRequired: boolean
  user: AuthUser | null
  displayName: string
  error: string
}

type HealthResponse = {
  auth_required?: boolean
  authRequired?: boolean
}

type MeResponse = {
  auth_required?: boolean
  authRequired?: boolean
  user?: AuthUser | null
  display_name?: string
  displayName?: string
}

type LoginStartResponse = {
  authorize_url?: string
  authorizeUrl?: string
}

type LoginExchangeResponse = {
  user?: AuthUser | null
  next?: string
}

const DEFAULT_ERROR = '认证服务暂不可用，请稍后重试。'

function getErrorMessage(error: unknown, fallback = DEFAULT_ERROR): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return fallback
}

function getUserDisplayName(user: AuthUser | null, displayName?: string): string {
  return displayName || String(user?.name || user?.email || user?.open_id || '飞书用户')
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { detail?: string; message?: string; error?: string }
    return payload.detail || payload.message || payload.error || `请求失败：${response.status}`
  } catch {
    return `请求失败：${response.status}`
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  if (!response.ok) throw new Error(await readError(response))
  return response.json() as Promise<T>
}

export async function fetchAuthState(): Promise<AuthState> {
  const health = await requestJson<HealthResponse>('/healthz')
  const authRequired = Boolean(health.auth_required ?? health.authRequired)
  if (!authRequired) {
    try {
      const me = await requestJson<MeResponse>('/auth/feishu/me')
      const user = me.user ?? null
      return {
        status: 'unauthenticated',
        authRequired: false,
        user,
        displayName: user ? getUserDisplayName(user, me.display_name ?? me.displayName) : '',
        error: '',
      }
    } catch {
      return { status: 'unauthenticated', authRequired: false, user: null, displayName: '', error: '' }
    }
  }

  try {
    const me = await requestJson<MeResponse>('/auth/feishu/me')
    const user = me.user ?? null
    return {
      status: user ? 'authenticated' : 'unauthenticated',
      authRequired: true,
      user,
      displayName: getUserDisplayName(user, me.display_name ?? me.displayName),
      error: '',
    }
  } catch (error) {
    return {
      status: 'unauthenticated',
      authRequired: true,
      user: null,
      displayName: '',
      error: getErrorMessage(error, '请先登录飞书。'),
    }
  }
}

export async function startFeishuLogin(): Promise<void> {
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/'
  const payload = await requestJson<LoginStartResponse>('/auth/feishu/login/start', {
    method: 'POST',
    body: JSON.stringify({ next }),
  })
  const authorizeUrl = payload.authorize_url ?? payload.authorizeUrl
  if (!authorizeUrl) throw new Error('登录开始接口缺少 authorize_url。')
  window.location.assign(authorizeUrl)
}

export async function exchangeFeishuLogin(code: string, state: string): Promise<LoginExchangeResponse> {
  return requestJson<LoginExchangeResponse>('/auth/feishu/login/exchange', {
    method: 'POST',
    body: JSON.stringify({ code, state }),
  })
}

export async function logoutFeishu(): Promise<void> {
  await requestJson('/auth/feishu/logout', { method: 'POST' })
}

export function formatAuthError(error: unknown, fallback?: string): string {
  return getErrorMessage(error, fallback)
}
