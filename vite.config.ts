import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves this repo under /climbing-coach-web/, so all
  // asset URLs must be relative to that subpath (absolute /assets/...
  // paths 404 at the domain root and render a blank page).
  base: '/climbing-coach-web/',
})
