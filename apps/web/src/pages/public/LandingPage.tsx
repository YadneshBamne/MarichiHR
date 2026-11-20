import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'

// The public page is a static file, public/landing.html (adapted from the 8B language-school template, MIT; see its header
// comment). Every host serves it at "/" (vercel.json, nginx.conf, the Vite plugin), so this route only runs for in-app
// navigation to "/": a full reload of "/" brings the static page up and keeps the address bar clean.
// ponytail: the flag stops a reload loop on a host that has no rewrite for "/"; it then falls back to /landing.html.
export default function LandingPage() {
  const { isAuthenticated, isLoading } = useAuth()
  useEffect(() => {
    if (isLoading || isAuthenticated) return
    let again = false
    try { again = sessionStorage.getItem('landing-retry') === '1'; sessionStorage.setItem('landing-retry', '1') } catch { /* private mode */ }
    window.location.replace(again ? '/landing.html' : '/')
  }, [isLoading, isAuthenticated])
  if (isLoading) return null
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  return null
}
