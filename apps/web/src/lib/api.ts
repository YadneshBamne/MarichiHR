import axios from 'axios'
import type { AxiosInstance, InternalAxiosRequestConfig, AxiosResponse } from 'axios'

const BASE_URL = import.meta.env.MARICHI_API_URL || 'http://localhost:4000/api/v1'

let accessToken: string | null = null
let refreshPromise: Promise<string | null> | null = null

export function setAccessToken(token: string | null) {
  accessToken = token
}

export function getAccessToken() {
  return accessToken
}

const api: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: false,
})

// Request interceptor — attach access token
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`
  }
  return config
})

// One refresh at a time, across tabs too: refresh tokens rotate, so two tabs (or React StrictMode's double effect)
// refreshing with the same token would revoke each other. Inside the lock the latest stored token is read, so a
// waiting tab uses the token the first one just received. Resolves to null when the session is really over (the
// server refused the token); throws on network/server errors so a sleeping or unreachable API never signs anyone out.
async function doRefresh(): Promise<string | null> {
  const refreshToken = localStorage.getItem('refreshToken')
  if (!refreshToken) return null
  try {
    const res = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken })
    setAccessToken(res.data.data.accessToken)
    localStorage.setItem('refreshToken', res.data.data.refreshToken)
    return res.data.data.accessToken
  } catch (err: any) {
    const status = err?.response?.status
    if (status !== 401 && status !== 400) throw err
    // Another tab may have rotated it a moment ago: then the stored token has changed and is still good
    if (localStorage.getItem('refreshToken') !== refreshToken) return doRefresh()
    setAccessToken(null)
    localStorage.removeItem('refreshToken')
    return null
  }
}

export function refreshSession(): Promise<string | null> {
  if (!refreshPromise) {
    const locks = (navigator as any).locks
    refreshPromise = (locks ? locks.request('marichihr-refresh', doRefresh) : doRefresh()).finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise!
}

// Response interceptor — auto-refresh on 401
api.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error) => {
    const originalRequest = error.config

    // A temporary password must be replaced before anything else works
    if (error.response?.status === 403 && error.response?.data?.code === 'PASSWORD_CHANGE_REQUIRED' && window.location.pathname !== '/change-password') {
      window.location.href = '/change-password'
      return Promise.reject(error)
    }

    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !originalRequest.url?.includes('/auth/refresh') &&
      !['/auth/login', '/auth/signup', '/auth/change-password', '/auth/mfa/verify', '/auth/google/exchange', '/auth/google/id-token'].some((u) => originalRequest.url?.includes(u))
    ) {
      originalRequest._retry = true
      let newToken: string | null
      try {
        newToken = await refreshSession()
      } catch {
        // Network or server trouble: keep the session and let the caller show the error
        return Promise.reject(error)
      }
      if (!newToken) {
        window.location.href = '/login'
        return Promise.reject(error)
      }
      originalRequest.headers.Authorization = `Bearer ${newToken}`
      return api(originalRequest)
    }

    return Promise.reject(error)
  }
)

export default api
