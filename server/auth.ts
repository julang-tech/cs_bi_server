import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AppEnv, FeishuAuthEnv } from './config/env.js'

export type AuthUser = {
  name?: string
  email?: string
  avatar_url?: string
  open_id?: string
  union_id?: string
  tenant_key?: string
  [key: string]: unknown
}

type SessionPayload = {
  user: AuthUser
  access_token?: string
  refresh_token?: string
  expires_at?: number
}

type OAuthStatePayload = {
  state: string
  redirect_uri: string
  code_verifier: string
  next: string
  created_at: number
}

type FeishuApiPayload = {
  code?: number
  msg?: string
  message?: string
  error?: string
  error_description?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

const SESSION_COOKIE = 'cs_bi_session'
const OAUTH_STATE_COOKIE = 'cs_bi_oauth_state'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60

const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
const FEISHU_USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info'

function base64UrlEncode(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

function timingSafeEqualText(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer)
}

function serializeSignedCookie(payload: unknown, secret: string): string {
  const body = base64UrlEncode(JSON.stringify(payload))
  return `${body}.${sign(body, secret)}`
}

function parseSignedCookie<T>(value: string | undefined, secret: string): T | null {
  if (!value) return null
  const [body, signature] = value.split('.')
  if (!body || !signature) return null
  if (!timingSafeEqualText(signature, sign(body, secret))) return null
  try {
    return JSON.parse(base64UrlDecode(body)) as T
  } catch {
    return null
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {}
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((part) => {
        const [name, ...rest] = part.trim().split('=')
        return [decodeURIComponent(name), decodeURIComponent(rest.join('='))]
      })
      .filter(([name]) => name),
  )
}

function setCookie(reply: FastifyReply, name: string, value: string, options: {
  maxAge?: number
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
} = {}) {
  const parts = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    'Path=/',
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ]
  if (options.httpOnly !== false) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  reply.header('Set-Cookie', parts.join('; '))
}

function clearCookie(reply: FastifyReply, name: string) {
  setCookie(reply, name, '', { maxAge: 0 })
}

function getCookie(request: FastifyRequest, name: string): string | undefined {
  return parseCookies(request.headers.cookie)[name]
}

function isSameOriginPath(pathname: string): boolean {
  return pathname.startsWith('/') && !pathname.startsWith('//')
}

function resolveRedirectUri(request: FastifyRequest, config: FeishuAuthEnv): string {
  if (config.redirectUri) return config.redirectUri
  const proto = request.headers['x-forwarded-proto'] ?? 'http'
  const host = request.headers['x-forwarded-host'] ?? request.headers.host
  return `${Array.isArray(proto) ? proto[0] : proto}://${Array.isArray(host) ? host[0] : host}/auth/feishu/callback`
}

function getUserDisplayName(user: AuthUser): string {
  return String(user.name || user.en_name || user.email || user.open_id || '飞书用户')
}

function normalizeUser(data: Record<string, unknown>): AuthUser {
  return {
    ...data,
    name: typeof data.name === 'string'
      ? data.name
      : typeof data.en_name === 'string'
        ? data.en_name
        : undefined,
    email: typeof data.email === 'string' ? data.email : undefined,
    avatar_url: typeof data.avatar_url === 'string' ? data.avatar_url : undefined,
    open_id: typeof data.open_id === 'string' ? data.open_id : undefined,
    union_id: typeof data.union_id === 'string' ? data.union_id : undefined,
    tenant_key: typeof data.tenant_key === 'string' ? data.tenant_key : undefined,
  }
}

function isAllowedDomain(user: AuthUser, allowedDomains: string[]): boolean {
  if (!allowedDomains.length) return true
  const domain = typeof user.email === 'string' ? user.email.split('@')[1]?.toLowerCase() : ''
  return Boolean(domain && allowedDomains.includes(domain))
}

function createCodeVerifier(): string {
  return crypto.randomBytes(48).toString('base64url')
}

function createCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url')
}

function getFeishuErrorMessage(payload: FeishuApiPayload, fallback: string): string {
  return String(
    payload.error_description ||
    payload.error ||
    payload.msg ||
    payload.message ||
    fallback,
  )
}

async function readFeishuJson(response: Response): Promise<FeishuApiPayload> {
  try {
    return await response.json() as FeishuApiPayload
  } catch {
    return { code: response.ok ? 0 : response.status, msg: response.statusText }
  }
}

async function postFeishuToken(body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(FEISHU_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await readFeishuJson(response)
  if (!response.ok || payload.code !== 0) {
    throw new Error(`飞书 OAuth v2 token 请求失败：${getFeishuErrorMessage(payload, response.statusText)}`)
  }
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload
  return data
}

async function getFeishuUserInfo(accessToken: string): Promise<AuthUser> {
  const response = await fetch(FEISHU_USER_INFO_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const payload = await readFeishuJson(response)
  if (!response.ok || payload.code !== 0) {
    throw new Error(`飞书用户信息请求失败：${getFeishuErrorMessage(payload, response.statusText)}`)
  }
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {}
  return normalizeUser(data)
}

async function exchangeCodeForSession(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  config: FeishuAuthEnv,
): Promise<SessionPayload> {
  const token = await postFeishuToken({
    grant_type: 'authorization_code',
    client_id: config.appId,
    client_secret: config.appSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })
  const accessToken = token.access_token
  if (typeof accessToken !== 'string' || !accessToken.trim()) {
    throw new Error('飞书 OAuth v2 token 响应缺少 access_token。')
  }
  const user = await getFeishuUserInfo(accessToken)
  if (!user.open_id) {
    throw new Error('飞书用户信息响应缺少 open_id。')
  }
  return {
    user,
    access_token: accessToken,
    refresh_token: typeof token.refresh_token === 'string' ? token.refresh_token : undefined,
    expires_at: typeof token.expires_in === 'number' ? Date.now() + token.expires_in * 1000 : undefined,
  }
}

export function getAuthSession(request: FastifyRequest, env: AppEnv): SessionPayload | null {
  if (!env.feishuAuth.authRequired) return null
  return parseSignedCookie<SessionPayload>(getCookie(request, SESSION_COOKIE), env.feishuAuth.sessionSecret)
}

export async function registerAuth(app: FastifyInstance, env: AppEnv) {
  app.decorateRequest('authUser', null)

  app.addHook('onRequest', async (request, reply) => {
    if (!env.feishuAuth.authRequired) return
    const pathname = new URL(request.url, 'http://local').pathname
    if (!pathname.startsWith('/api/bi')) return

    const session = getAuthSession(request, env)
    if (!session?.user) {
      return reply.status(401).send({ detail: '请先登录飞书。' })
    }
    request.authUser = session.user
  })

  app.post('/auth/feishu/login/start', async (request, reply) => {
    if (!env.feishuAuth.authRequired) {
      return { auth_required: false }
    }
    const body = (request.body ?? {}) as { next?: string }
    // OAuth redirect_uri：飞书 OAuth 授权码回跳地址。优先使用后端 FEISHU_REDIRECT_URI；
    // 不要与飞书事件订阅/长连接的回调配置混淆。
    const redirectUri = resolveRedirectUri(request, env.feishuAuth)
    const next = body.next && isSameOriginPath(body.next) ? body.next : '/'
    const state = crypto.randomBytes(32).toString('base64url')
    const codeVerifier = createCodeVerifier()
    const statePayload: OAuthStatePayload = {
      state,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      next,
      created_at: Date.now(),
    }
    setCookie(reply, OAUTH_STATE_COOKIE, serializeSignedCookie(statePayload, env.feishuAuth.sessionSecret), {
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
      secure: env.feishuAuth.cookieSecure,
    })
    const authorizeUrl = new URL(FEISHU_AUTHORIZE_URL)
    authorizeUrl.searchParams.set('client_id', env.feishuAuth.appId)
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('code_challenge', createCodeChallenge(codeVerifier))
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    if (env.feishuAuth.scope) authorizeUrl.searchParams.set('scope', env.feishuAuth.scope)
    return { authorize_url: authorizeUrl.toString(), state }
  })

  app.post('/auth/feishu/login/exchange', async (request, reply) => {
    if (!env.feishuAuth.authRequired) {
      return { auth_required: false, user: null }
    }
    const body = (request.body ?? {}) as { code?: string; state?: string }
    if (!body.code || !body.state) {
      return reply.status(400).send({ detail: '飞书登录回调缺少 code 或 state。' })
    }
    const statePayload = parseSignedCookie<OAuthStatePayload>(
      getCookie(request, OAUTH_STATE_COOKIE),
      env.feishuAuth.sessionSecret,
    )
    if (!statePayload || statePayload.state !== body.state || Date.now() - statePayload.created_at > OAUTH_STATE_MAX_AGE_SECONDS * 1000) {
      return reply.status(400).send({ detail: '飞书登录状态已失效，请重新登录。' })
    }
    const session = await exchangeCodeForSession(
      body.code,
      statePayload.redirect_uri,
      statePayload.code_verifier,
      env.feishuAuth,
    )
    if (!isAllowedDomain(session.user, env.feishuAuth.allowedDomains)) {
      return reply.status(403).send({ detail: '当前飞书账号不在允许访问的邮箱域名内。' })
    }
    setCookie(reply, SESSION_COOKIE, serializeSignedCookie(session, env.feishuAuth.sessionSecret), {
      maxAge: SESSION_MAX_AGE_SECONDS,
      secure: env.feishuAuth.cookieSecure,
    })
    clearCookie(reply, OAUTH_STATE_COOKIE)
    return { user: session.user, next: statePayload.next }
  })

  app.get('/auth/feishu/me', async (request, reply) => {
    if (!env.feishuAuth.authRequired) {
      return {
        auth_required: false,
        user: env.feishuAuth.devUser,
        display_name: env.feishuAuth.devUser ? getUserDisplayName(env.feishuAuth.devUser) : '',
      }
    }
    const session = getAuthSession(request, env)
    if (!session?.user) {
      return reply.status(401).send({ detail: '请先登录飞书。' })
    }
    return { auth_required: true, user: session.user, display_name: getUserDisplayName(session.user) }
  })

  app.post('/auth/feishu/logout', async (_request, reply) => {
    clearCookie(reply, SESSION_COOKIE)
    return { ok: true }
  })
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser | null
  }
}
