import { createApp } from 'vue'
import App from './App.vue'
import { tipDirective } from './tooltip.js'
import './style.css'

createApp(App).directive('tip', tipDirective).mount('#app')

// diagnostics hook (e.g. tests can lower memorySettings.inlinePreviewLimit)
import { memorySettings } from './core/store.js'
window.__deepdf = { memorySettings }
