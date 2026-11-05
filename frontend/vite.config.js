import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true, // listen on the LAN, not just localhost
    // python -m backend (from the repo root); same origin, so no CORS / mixed content
    proxy: { '/scan': 'http://localhost:8000', '/books': 'http://localhost:8000', '/images': 'http://localhost:8000', '/stats': 'http://localhost:8000', '/tts': 'http://localhost:8000', '/question': 'http://localhost:8000', '/turn': 'http://localhost:8000',
      '/listen': { target: 'ws://localhost:8000', ws: true } },
  },
})