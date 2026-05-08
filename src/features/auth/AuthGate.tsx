import { useEffect, useState, type ReactNode } from 'react'
import {
  exchangeFeishuLogin,
  fetchAuthState,
  formatAuthError,
  logoutFeishu,
  startFeishuLogin,
  type AuthState,
} from '../../shared/auth/feishuAuth'
import { Watermark } from './Watermark'

const INITIAL_AUTH: AuthState = {
  status: 'checking',
  authRequired: false,
  user: null,
  displayName: '',
  error: '',
}

function LoginScreen({ state, onRetry }: { state: AuthState; onRetry: () => void }) {
  const [submitting, setSubmitting] = useState(false)
  const isChecking = state.status === 'checking'
  const isBackendError = state.status === 'error'
  const needsLogin = state.authRequired && state.status !== 'authenticated' && !isChecking && !isBackendError

  let title = '正在连接后端'
  let description = '正在检查当前后端是否要求登录认证。'
  let actionLabel = '重新检查'
  let action = onRetry

  if (isBackendError) {
    title = '后端暂不可用'
    description = state.error || '请检查网络连接和服务状态后再重试。'
  } else if (needsLogin) {
    title = '请先登录飞书'
    description = state.error || '当前系统要求先完成飞书认证后，才能继续查看 BI 看板。'
    actionLabel = '使用飞书登录'
    action = () => {
      setSubmitting(true)
      void startFeishuLogin().catch((error) => {
        setSubmitting(false)
        window.alert(formatAuthError(error, '飞书登录失败。'))
      })
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-label="飞书认证状态">
        <span className="eyebrow">feishu auth</span>
        <h1>{title}</h1>
        <p>{description}</p>
        <button className="auth-card__button" type="button" disabled={isChecking || submitting} onClick={action}>
          {isChecking || submitting ? '请稍候' : actionLabel}
        </button>
      </section>
    </main>
  )
}

function FeishuCallback() {
  const [message, setMessage] = useState('正在完成飞书登录。')

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')
    const error = params.get('error_description') ?? params.get('error')
    if (error) {
      setMessage(error)
      return
    }
    if (!code || !state) {
      setMessage('飞书登录回调缺少 code 或 state。')
      return
    }
    void exchangeFeishuLogin(code, state)
      .then((payload) => {
        window.location.replace(payload.next || '/')
      })
      .catch((exchangeError) => {
        setMessage(formatAuthError(exchangeError, '飞书登录失败，请重新尝试。'))
      })
  }, [])

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-live="polite">
        <span className="eyebrow">feishu auth</span>
        <h1>飞书登录</h1>
        <p>{message}</p>
        {message !== '正在完成飞书登录。' && (
          <button className="auth-card__button" type="button" onClick={() => window.location.replace('/')}>
            返回看板
          </button>
        )}
      </section>
    </main>
  )
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(INITIAL_AUTH)

  const refresh = () => {
    setState((current) => ({ ...current, status: 'checking', error: '' }))
    void fetchAuthState()
      .then(setState)
      .catch((error) => {
        setState({ ...INITIAL_AUTH, status: 'error', error: formatAuthError(error) })
      })
  }

  useEffect(refresh, [])

  if (window.location.pathname === '/auth/feishu/callback') {
    return <FeishuCallback />
  }

  const ready = state.status !== 'checking' && (!state.authRequired || state.status === 'authenticated')
  if (!ready) {
    return <LoginScreen state={state} onRetry={refresh} />
  }

  return (
    <>
      {children}
      <Watermark displayName={state.displayName} />
      {state.authRequired && (
        <button
          className="auth-logout"
          type="button"
          onClick={() => {
            void logoutFeishu().finally(() => refresh())
          }}
        >
          退出：{state.displayName || '飞书用户'}
        </button>
      )}
    </>
  )
}
