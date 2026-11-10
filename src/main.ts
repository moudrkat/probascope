import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { report } from './errors'

const app = createApp(App)
app.config.errorHandler = (e, _instance, info) => report(e, info)
window.addEventListener('error', (ev) => report(ev.error ?? ev.message, 'window'))
window.addEventListener('unhandledrejection', (ev) => report(ev.reason, 'promise'))
app.mount('#app')
