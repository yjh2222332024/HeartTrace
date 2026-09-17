import { createApp } from 'vue'
import App from './App.vue'
import './style.css'
import { installPrivacyConsent } from './api.js'

installPrivacyConsent()
createApp(App).mount('#app')
