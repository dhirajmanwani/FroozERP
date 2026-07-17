import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { RUNTIME_FAILURE_EVENT, describeRequestFailure, shouldShowFatalStartup } from './local/startupResilience'

let reactMounted = false

export const RuntimeMountGuard = ({ children }) => {
  useEffect(() => {
    reactMounted = true
    writeLog('INFO', 'React mounted successfully')
  }, [])
  return children
}

const showStartupFailure = (error, logPath = '') => {
  const root = document.getElementById('root')
  if (!root) return
  const message = error?.stack || error?.message || String(error || 'Unknown startup error')
  root.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#f8fafc;font-family:Inter,Segoe UI,Arial,sans-serif;padding:32px;">
      <section style="max-width:760px;width:100%;background:#111827;border:1px solid #334155;border-radius:12px;padding:24px;box-shadow:0 24px 60px rgba(0,0,0,.35);">
        <h1 style="font-size:24px;margin:0 0 10px;">FroozERP could not start</h1>
        <p style="margin:0 0 16px;color:#cbd5e1;">The application hit a startup error. Share this screen and the log file with support.</p>
        ${logPath ? `<p style="margin:0 0 16px;color:#e2e8f0;"><strong>Log file:</strong><br><code style="word-break:break-all;">${logPath}</code></p>` : ''}
        <pre style="white-space:pre-wrap;word-break:break-word;background:#020617;border:1px solid #1e293b;border-radius:8px;padding:14px;color:#fecaca;max-height:360px;overflow:auto;">${message.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))}</pre>
      </section>
    </main>
  `
}

const invokeTauri = async (command, payload) => {
  if (!window.__TAURI_INTERNALS__ && !window.__TAURI__) return null
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, payload)
}

const withTimeout = (promise, timeoutMs = 1200) =>
  Promise.race([
    promise,
    new Promise((resolve) => {
      window.setTimeout(() => resolve(null), timeoutMs)
    }),
  ])

const readLogPath = async () => {
  try {
    return (await withTimeout(invokeTauri('app_log_path'))) || ''
  } catch {
    return ''
  }
}

const writeLog = async (level, message) => {
  try {
    await withTimeout(invokeTauri('app_log', { level, message }))
  } catch {
    // The fallback screen still shows the error if the bridge is unavailable.
  }
}

window.onerror = (message, source, lineno, colno, error) => {
  const detail = error?.stack || `${message} at ${source}:${lineno}:${colno}`
  writeLog('ERROR', `window.onerror: ${detail}`)
  if (shouldShowFatalStartup({ reactMounted })) {
    readLogPath().then((logPath) => showStartupFailure(error || detail, logPath))
    return
  }
  window.dispatchEvent(new CustomEvent(RUNTIME_FAILURE_EVENT, { detail: { message: error?.message || String(message), source } }))
}

window.onunhandledrejection = (event) => {
  const reason = event?.reason
  const detail = reason?.stack || reason?.message || String(reason || 'Unhandled rejection')
  const request = describeRequestFailure(reason)
  writeLog('ERROR', `unhandledrejection: ${detail}; request=${JSON.stringify(request)}`)
  if (shouldShowFatalStartup({ reactMounted })) {
    readLogPath().then((logPath) => showStartupFailure(reason || detail, logPath))
    return
  }
  event.preventDefault?.()
  window.dispatchEvent(new CustomEvent(RUNTIME_FAILURE_EVENT, { detail: request }))
}

const boot = async () => {
  let logPath = ''
  readLogPath().then((path) => {
    logPath = path || ''
    return writeLog('INFO', `Frontend boot started. Log path: ${logPath || 'not available'}`)
  })

  try {
    const { default: App } = await import('./App.jsx')
    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <RuntimeMountGuard>
          <App />
        </RuntimeMountGuard>
      </StrictMode>,
    )
  } catch (error) {
    await writeLog('ERROR', `React startup failed: ${error?.stack || error?.message || String(error)}`)
    showStartupFailure(error, logPath)
  }
}

boot()

if ('serviceWorker' in navigator && import.meta.env.PROD && !window.__TAURI_INTERNALS__ && !window.__TAURI__) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      writeLog('WARN', `FroozERP service worker registration failed: ${error?.message || String(error)}`)
      console.warn('FroozERP service worker registration failed', error)
    })
  })
}
