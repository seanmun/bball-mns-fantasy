import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
// The preview harness: the real components with the API and the league
// context swapped for fixtures. Built to preview-dist/ and screenshotted
// by scripts/preview-shots.sh. Never deployed.
export default defineConfig({
  root: 'preview',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^(\.\.\/)+hooks\/useApi$/, replacement: path.resolve(__dirname, 'preview/mocks/useApi.ts') },
      { find: /^(\.\.\/)+contexts\/LeagueContext$/, replacement: path.resolve(__dirname, 'preview/mocks/LeagueContext.tsx') },
      { find: '@clerk/clerk-react', replacement: path.resolve(__dirname, 'preview/mocks/clerk.ts') },
    ],
  },
  build: { outDir: path.resolve(__dirname, 'preview-dist'), emptyOutDir: true },
})
