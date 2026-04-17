/**
 * Copyright (C) 2026 Komorebi
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


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
