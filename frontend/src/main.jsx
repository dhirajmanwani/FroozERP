import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { RUNTIME_FAILURE_EVENT, describeRequestFailure } from './local/startupResilience'

export const RuntimeMountGuard = ({ children }) => {
  useEffect(() => {
    writeLog('INFO', 'React mounted successfully')
    recordStartupTransition('react-mounted')
  }, [])
  return children
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

const recordStartupTransition = (state, detail = '') => {
  const root = document.getElementById('root')
  if (root) root.dataset.startupState = state
  window.__FROOZERP_STARTUP_TRANSITIONS__ = window.__FROOZERP_STARTUP_TRANSITIONS__ || []
  window.__FROOZERP_STARTUP_TRANSITIONS__.push({ state, detail, at: new Date().toISOString() })
  void withTimeout(invokeTauri('record_startup_transition', { state, detail }), 1600)
}

window.__FROOZERP_RECORD_STARTUP_TRANSITION__ = recordStartupTransition

window.onerror = (message, source, lineno, colno, error) => {
  const detail = error?.stack || `${message} at ${source}:${lineno}:${colno}`
  writeLog('ERROR', `window.onerror: ${detail}`)
  window.dispatchEvent(new CustomEvent(RUNTIME_FAILURE_EVENT, { detail: { message: error?.message || String(message), source } }))
}

window.onunhandledrejection = (event) => {
  const reason = event?.reason
  const detail = reason?.stack || reason?.message || String(reason || 'Unhandled rejection')
  const request = describeRequestFailure(reason)
  writeLog('ERROR', `unhandledrejection: ${detail}; request=${JSON.stringify(request)}`)
  event.preventDefault?.()
  window.dispatchEvent(new CustomEvent(RUNTIME_FAILURE_EVENT, { detail: request }))
}

const boot = async () => {
  let logPath = ''
  readLogPath().then((path) => {
    logPath = path || ''
    return writeLog('INFO', `Frontend boot started. Log path: ${logPath || 'not available'}`)
  })

  recordStartupTransition('neutral-shell-painting')
  await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
  await withTimeout(invokeTauri('show_main_window'), 1600)
  recordStartupTransition('neutral-shell-visible')

  try {
    recordStartupTransition('app-module-loading')
    const { default: App } = await import('./App.jsx')
    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <RuntimeMountGuard>
          <App />
        </RuntimeMountGuard>
      </StrictMode>,
    )
    recordStartupTransition('react-render-scheduled')
  } catch (error) {
    await writeLog('ERROR', `React startup failed: ${error?.stack || error?.message || String(error)}`)
    recordStartupTransition('bootstrap-stalled', error?.message || String(error))
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
