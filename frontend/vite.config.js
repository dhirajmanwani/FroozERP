import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { describeBuildApiMode } from './src/local/apiModeResolution.js'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // Refuse to bake a permanently offline app.
  //
  // `loadEnv(mode, cwd, '')` reads the same files Vite itself will read -- .env, .env.local,
  // .env.[mode], .env.[mode].local -- plus the shell. All of those except .env are gitignored,
  // which is exactly why this check has to live at the build and not in a test: on 2026-09-07 the
  // shop's app shipped with VITE_API_MODE=LOCAL_ONLY out of a .env.local written months earlier,
  // and nothing in the repository could see it. See `describeBuildApiMode` for what that costs.
  //
  // Only on `build`. A dev server is somebody at a keyboard who can change it back in a second.
  if (command === 'build') {
    const env = loadEnv(mode, process.cwd(), '')
    const verdict = describeBuildApiMode(env.VITE_API_MODE, {
      acknowledged: process.env.FROOZERP_ALLOW_LOCAL_ONLY_BUILD === '1',
    })
    if (!verdict.ok) throw new Error(`\n\n${verdict.message}\n`)
    if (verdict.acknowledged) {
      console.warn(`[build] VITE_API_MODE=${verdict.mode}, acknowledged by FROOZERP_ALLOW_LOCAL_ONLY_BUILD=1.`)
    }
  }

  return {
    base: './',
    plugins: [react()],
  }
})
