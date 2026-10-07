import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import api, { setAccessToken } from '../lib/api'
import type { User } from '../types'

interface AuthContextType {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (email: string, password: string, tenantSlug: string) => Promise<void>
  logout: () => Promise<void>
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

  const login = async (email: string, password: string, tenantSlug: string) => {
    const res = await api.post('/auth/login', { email, password, tenantSlug })
    const { accessToken, refreshToken, user: userData } = res.data.data
    setAccessToken(accessToken)
    localStorage.setItem('refreshToken', refreshToken)
    setUser(userData)
  }

  const logout = async () => {
    const refreshToken = localStorage.getItem('refreshToken')
    try {
      if (refreshToken) await api.post('/auth/logout', { refreshToken })
    } catch {}
    setAccessToken(null)
    localStorage.removeItem('refreshToken')
    setUser(null)
  }

  const hasRole = (role: string) => user?.roles?.some((r) => r.name === role) ?? false

  const isHR = hasRole('hr_admin') || hasRole('system_admin') || hasRole('payroll_admin')
  const isManager = hasRole('manager') || isHR

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, login, logout, hasRole, isHR, isManager }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
