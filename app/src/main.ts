import './styles.css'
import { isNativePlatform } from './native.js'
import { mount } from './app.js'

const el = document.getElementById('app')
if (el) void mount(el)

if (import.meta.env.PROD && !isNativePlatform() && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline first boot — fine */ })
  })
}
