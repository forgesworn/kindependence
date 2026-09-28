import './styles.css'
import { mount } from './app.js'

const el = document.getElementById('app')
if (el) void mount(el)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline first boot — fine */ })
  })
}
