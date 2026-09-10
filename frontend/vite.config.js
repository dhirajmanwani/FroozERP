import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { describeBuildApiMode } from './src/local/apiModeResolution.js'

// Which file on disk actually sets VITE_API_MODE.
//
// `loadEnv` merges four gitignored files and the shell and tells you only the answer, never where
// it came from -- and "where" is the entire difficulty. The shop's app shipped permanently offline
// out of a `.env.local` written months earlier that nobody remembered, and the two days that cost
// were spent looking everywhere except at a file the repository cannot see.
const apiModeSource = (cwd, mode) => {
  const candidates = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
  const found = candidates.filter((name) => {
    const file = path.join(cwd, name)
    return fs.existsSync(file) && /^\s*VITE_API_MODE\s*=/m.test(fs.readFileSync(file, 'utf8'))
  })
  if (process.env.VITE_API_MODE) found.push('the shell (VITE_API_MODE is set in this terminal)')
  return found
}

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
  const env = loadEnv(mode, process.cwd(), '')
  const verdict = describeBuildApiMode(env.VITE_API_MODE, {
    acknowledged: process.env.FROOZERP_ALLOW_LOCAL_ONLY_BUILD === '1',
  })

  if (command === 'build') {
    if (!verdict.ok) throw new Error(`\n\n${verdict.message}\n`)
    if (verdict.acknowledged) {
      console.warn(`[build] VITE_API_MODE=${verdict.mode}, acknowledged by FROOZERP_ALLOW_LOCAL_ONLY_BUILD=1.`)
    }
  } else if (!verdict.ok) {
    // A dev server is not refused -- running the app deliberately offline is a real thing to want,
    // and refusing would only teach people to set the acknowledgement permanently.
    //
    // But it must not be silent. `npm run app:disposable` is a dev server, and it is the rehearsal
    // that stands between a change and every counter in the shop. In LOCAL_ONLY the app cannot
    // reach the cloud at all, so signing in simply fails with nothing to explain it -- which is
    // exactly what happened during the first rehearsal after this guard was added to `build` and
    // not to `serve`. The earlier reasoning here was that somebody at a keyboard can change it
    // back in a second; the flaw is that they have to know it is set, and nobody did.
    const sources = apiModeSource(process.cwd(), mode)
    console.warn(
      `\n[dev] VITE_API_MODE=${verdict.mode}. This app cannot reach the cloud, so signing in with\n`
      + `      cloud credentials will fail and nothing on screen will say why.\n`
      + `      Set by: ${sources.length ? sources.join(', ') : 'an env file or the shell'}\n`
      + `      (files under frontend/, all gitignored except .env)\n`,
    )
  }

  return {
    base: './',
    plugins: [react()],
  }
})
