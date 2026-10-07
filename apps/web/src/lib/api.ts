import axios from 'axios'
import type { AxiosInstance, InternalAxiosRequestConfig, AxiosResponse } from 'axios'

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api/v1'

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

// Response interceptor — auto-refresh on 401
api.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error) => {
    const originalRequest = error.config

    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !originalRequest.url?.includes('/auth/refresh') &&
      !['/auth/login', '/auth/mfa/verify', '/auth/google/exchange'].some((u) => originalRequest.url?.includes(u))
    ) {
      originalRequest._retry = true

      try {
        if (!refreshPromise) {
          const refreshToken = localStorage.getItem('refreshToken')
          if (!refreshToken) {
            setAccessToken(null)
            window.location.href = '/login'
            return Promise.reject(error)
          }

          refreshPromise = api
            .post('/auth/refresh', { refreshToken })
            .then((res) => {
              const newToken = res.data.data.accessToken
              const newRefresh = res.data.data.refreshToken
              setAccessToken(newToken)
              localStorage.setItem('refreshToken', newRefresh)
              return newToken
            })
            .catch(() => {
              setAccessToken(null)
              localStorage.removeItem('refreshToken')
              window.location.href = '/login'
              return null
            })
            .finally(() => {
              refreshPromise = null
            })
        }

        const newToken = await refreshPromise
        if (newToken) {
          originalRequest.headers.Authorization = `Bearer ${newToken}`
          return api(originalRequest)
        }
      } catch {
        setAccessToken(null)
        localStorage.removeItem('refreshToken')
        window.location.href = '/login'
      }
    }

    return Promise.reject(error)
  }
)

export default api
