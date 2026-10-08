import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import api, { setAccessToken, refreshSession } from '../lib/api'
import { queryClient } from '../lib/queryClient'
import type { User } from '../types'

// Either email + password, or googleCode from Continue with Google (email and photo then come from Google)
export type SignupInput = { companyName: string; fullName: string } & ({ email: string; password: string } | { googleCode: string })

interface AuthContextType {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  // Resolves to an MFA step token when the account needs a TOTP code, otherwise signs in
  login: (email: string, password: string, tenantSlug?: string) => Promise<string | null>
  signup: (input: SignupInput) => Promise<string>
  verifyMfa: (mfaToken: string, code: string) => Promise<void>
  exchangeSso: (code: string) => Promise<string | null>
  googleLogin: (credential: string, tenantSlug?: string) => Promise<string | null>
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  logout: () => Promise<void>
  refreshMe: () => Promise<void>
  updateUser: (patch: Partial<User>) => void
  hasRole: (role: string) => boolean
  hasApp: (app: string) => boolean
  isHR: boolean
  isManager: boolean
  isAdmin: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Signed-in state survives browser restarts: the refresh token lives in localStorage (no third-party cookies
  // needed between the web and API domains) and every refresh extends it, so only logout or 30 idle days end it
  // While the API is unreachable (redeploying, waking up) the loading screen keeps retrying for about a minute
  // instead of showing the sign-in page; the stored session is never dropped for a network error
  const loadUser = useCallback(async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if (await refreshSession()) {
          const meRes = await api.get('/auth/me')
          setUser(meRes.data.data)
        }
        break
      } catch (err: any) {
        if (err?.response && err.response.status < 500) break
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    setIsLoading(false)
  }, [])

  useEffect(() => {
    loadUser()
  }, [loadUser])

  // A new session never sees the previous user's cached data (several companies can share one browser)
  const startSession = (data: any): string | null => {
    if (data.mfaRequired) return data.mfaToken
    queryClient.clear()
    setAccessToken(data.accessToken)
    localStorage.setItem('refreshToken', data.refreshToken)
    setUser(data.user)
    return null
  }

  const login = async (email: string, password: string, tenantSlug?: string) =>
    startSession((await api.post('/auth/login', { email, password, ...(tenantSlug && { tenantSlug }) })).data.data)

  const signup = async (input: SignupInput) => {
    const data = (await api.post('/auth/signup', input)).data.data
    startSession(data)
    return data.workspace as string
  }

  const verifyMfa = async (mfaToken: string, code: string) => {
    startSession((await api.post('/auth/mfa/verify', { mfaToken, code })).data.data)
  }

  const exchangeSso = async (code: string) => startSession((await api.post('/auth/google/exchange', { code })).data.data)

  const googleLogin = async (credential: string, tenantSlug?: string) =>
    startSession((await api.post('/auth/google/id-token', { credential, intent: 'login', ...(tenantSlug && { tenantSlug }) })).data.data)

  const changePassword = async (currentPassword: string, newPassword: string) => {
    startSession((await api.post('/auth/change-password', { currentPassword, newPassword })).data.data)
  }

  const logout = async () => {
    const refreshToken = localStorage.getItem('refreshToken')
    try {
      if (refreshToken) await api.post('/auth/logout', { refreshToken })
    } catch { /* signing out locally is enough */ }
    setAccessToken(null)
    localStorage.removeItem('refreshToken')
    queryClient.clear()
    setUser(null)
  }

  const refreshMe = useCallback(async () => {
    const me = await api.get('/auth/me')
    setUser(me.data.data)
  }, [])

  const updateUser = useCallback((patch: Partial<User>) => setUser((u) => (u ? { ...u, ...patch } : u)), [])

  const hasRole = (role: string) => user?.roles?.some((r) => r.name === role) ?? false
  const hasApp = (app: string) => user?.tenant?.modules?.includes(app) ?? false

  const isHR = hasRole('hr_admin') || hasRole('system_admin') || hasRole('payroll_admin')
  // People with a team to approve for (payroll staff are not approvers)
  const isManager = hasRole('manager') || hasRole('hr_admin') || hasRole('system_admin')
  const isAdmin = hasRole('hr_admin') || hasRole('system_admin')

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, login, signup, verifyMfa, exchangeSso, googleLogin, changePassword, logout, refreshMe, updateUser, hasRole, hasApp, isHR, isManager, isAdmin }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
