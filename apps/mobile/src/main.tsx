import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { applyTheme } from './features/me/theme'
import { captureInstallPrompt, registerServiceWorker } from './platform/pwa'
import { startViewport } from './platform/viewport'
import './styles/app.css'

applyTheme()
startViewport()
captureInstallPrompt()
registerServiceWorker()
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
