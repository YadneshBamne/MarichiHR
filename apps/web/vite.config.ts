import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // MARICHI_* variables are exposed to the browser too (hosting dashboards reject VITE_ keys)
  envPrefix: ['VITE_', 'MARICHI_'],
})
