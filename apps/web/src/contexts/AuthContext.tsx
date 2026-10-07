import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import api, { setAccessToken } from '../lib/api'
import type { User } from '../types'

interface AuthContextType {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  // Resolves to an MFA step token when the account needs a TOTP code, otherwise signs in
  login: (email: string, password: string, tenantSlug: string) => Promise<string | null>
  verifyMfa: (mfaToken: string, code: string) => Promise<void>
  exchangeSso: (code: string) => Promise<string | null>
  logout: () => Promise<void>
  updateUser: (patch: Partial<User>) => void
  hasRole: (role: string) => boolean
  isHR: boolean
  isManager: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadUser = useCallback(async () => {
    const refreshToken = localStorage.getItem('refreshToken')
    if (!refreshToken) {
      setIsLoading(false)
      return
    }

    try {
      const refreshRes = await api.post('/auth/refresh', { refreshToken })
      const { accessToken, refreshToken: newRefresh } = refreshRes.data.data
      setAccessToken(accessToken)
      localStorage.setItem('refreshToken', newRefresh)

      const meRes = await api.get('/auth/me')
      setUser(meRes.data.data)
    } catch {
      setAccessToken(null)
      localStorage.removeItem('refreshToken')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadUser()
  }, [loadUser])

  const startSession = (data: any): string | null => {
    if (data.mfaRequired) return data.mfaToken
    setAccessToken(data.accessToken)
    localStorage.setItem('refreshToken', data.refreshToken)
    setUser(data.user)
    return null
  }

  const login = async (email: string, password: string, tenantSlug: string) =>
    startSession((await api.post('/auth/login', { email, password, tenantSlug })).data.data)

  const verifyMfa = async (mfaToken: string, code: string) => {
    startSession((await api.post('/auth/mfa/verify', { mfaToken, code })).data.data)
  }

  const exchangeSso = async (code: string) => startSession((await api.post('/auth/google/exchange', { code })).data.data)

  const logout = async () => {
    const refreshToken = localStorage.getItem('refreshToken')
    try {
      if (refreshToken) await api.post('/auth/logout', { refreshToken })
    } catch {}
    setAccessToken(null)
    localStorage.removeItem('refreshToken')
    setUser(null)
  }

  const updateUser = useCallback((patch: Partial<User>) => setUser((u) => (u ? { ...u, ...patch } : u)), [])

  const hasRole = (role: string) => user?.roles?.some((r) => r.name === role) ?? false

  const isHR = hasRole('hr_admin') || hasRole('system_admin') || hasRole('payroll_admin')
  const isManager = hasRole('manager') || isHR

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, login, verifyMfa, exchangeSso, logout, updateUser, hasRole, isHR, isManager }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
