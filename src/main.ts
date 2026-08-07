import './style.css'
import { initApp } from './app'
import { initUiScale } from './ui-scale'
import { maybeMountSafeAreaProbe } from './safe-area-probe'
import { registerServiceWorker } from './sw/register'
import { count } from './counter'

const appEl = document.getElementById('app')
if (!appEl) throw new Error('#app element not found')

// Before the first view mounts, so nothing lays out at stock size first.
initUiScale()
initApp(appEl)
maybeMountSafeAreaProbe()
registerServiceWorker()
count('boot')
