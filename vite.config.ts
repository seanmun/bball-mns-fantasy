import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// One codebase, one deployment per sport. VITE_SPORT picks the adapter
// (src/lib/sport) at runtime; this file only has to stamp the static
// <head> — title, app name, description — which no runtime code can
// reach. Keep these lines in step with the adapter's branding.
const HEAD: Record<string, { title: string; short: string; desc: string }> = {
  wnba: {
    title: 'WNBA MNS Fantasy',
    short: 'MNS WNBA',
    desc: 'Money Never Sleeps WNBA — Dynasty Fantasy Basketball Keeper Manager',
  },
  nba: {
    title: 'NBA MNS Fantasy',
    short: 'MNS NBA',
    desc: 'Money Never Sleeps NBA — Dynasty Fantasy Basketball Keeper Manager',
  },
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env }
  const key = env.VITE_SPORT
  const head = key ? HEAD[key] : undefined
  if (!head) {
    throw new Error(
      `VITE_SPORT must be one of ${Object.keys(HEAD).join(', ')} — got ${JSON.stringify(key)}. Set it in .env.local and on the Vercel project.`
    )
  }
  return {
    plugins: [
      react(),
      {
        name: 'mns-sport-head',
        transformIndexHtml(html) {
          return html
            .replaceAll('%APP_TITLE%', head.title)
            .replaceAll('%APP_SHORT%', head.short)
            .replaceAll('%APP_DESC%', head.desc)
        },
      },
    ],
    build: {
      chunkSizeWarningLimit: 600,
    },
    server: {
      port: 5173,
    },
  }
})
