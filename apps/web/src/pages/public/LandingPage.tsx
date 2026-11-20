import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'

// The public page is a static file, public/landing.html (adapted from the 8B language-school template, MIT; see its header
// comment). The host serves it at "/" (vercel.json, nginx.conf); this route covers in-app navigation to "/" and the dev server.
export default function LandingPage() {
  const { isAuthenticated, isLoading } = useAuth()
  useEffect(() => {
    if (!isLoading && !isAuthenticated) window.location.replace('/landing.html')
  }, [isLoading, isAuthenticated])
  if (isLoading) return null
  if (isAuthenticated) return <Navigate to="/dashboard" replace />
  return null
}
