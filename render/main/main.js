import './assets/main.css'

import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import { createI18n } from 'vue-i18n'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'

import en from './locales/en.json'
import zh from './locales/zh.json'

const getInitialLocale = () => {
  const savedLanguage = localStorage.getItem('language')
  if (savedLanguage && ['en', 'zh'].includes(savedLanguage)) {
    return savedLanguage
  }

  const browserLanguage = navigator.language.split('-')[0]
  if (['zh', 'en'].includes(browserLanguage)) {
    return browserLanguage
  }

  return 'zh'
}

const i18n = createI18n({
  legacy: false,
  locale: getInitialLocale(),
  fallbackLocale: 'zh',
  messages: {
    en,
    zh
  }
})

const app = createApp(App)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(ElementPlus)
app.use(i18n)
app.mount('#app')
