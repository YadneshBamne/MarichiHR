import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The public page is the static public/landing.html. Hosts serve it at "/" (vercel.json, nginx.conf); this does the same for
// the dev and preview servers, so the address bar shows "/" and never "/landing.html".
const landingAtRoot = (): Plugin => {
  const serve = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url === '/' || req.url?.startsWith('/?')) req.url = '/landing.html' + req.url.slice(1)
    next()
  }
  return {
    name: 'landing-at-root',
    configureServer: (server) => { server.middlewares.use(serve) },
    configurePreviewServer: (server) => { server.middlewares.use(serve) },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [landingAtRoot(), react()],
  // MARICHI_* variables are exposed to the browser too (hosting dashboards reject VITE_ keys)
  envPrefix: ['VITE_', 'MARICHI_'],
})
