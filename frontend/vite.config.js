import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
      // The backend also exposes a handful of routes without the /api
      // prefix (features.py's original endpoints, migrated into app.py) —
      // these need explicit proxy entries too, or Vite serves its own
      // SPA fallback (index.html) instead of forwarding to Flask.
      '/insights': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
      '/handoff': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
      '/points': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
      '/bills': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
      '/reminders': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
      '/emergency': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
    }
  }
})