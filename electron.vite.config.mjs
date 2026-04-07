import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('main/index.js')
        }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          main_preload: resolve('preload/main_preload.js'),
          window_preload: resolve('preload/window_preload.js'),
          fast_input_preload: resolve('preload/fast_input_preload.js'),
          quick_preload: resolve('preload/quick_preload.js')
        }
      }
    }
  },
  renderer: {
    root: 'render',
    resolve: {
      alias: {
        '@main': resolve('render/main'),
        '@window': resolve('render/window'),
        '@fastInput': resolve('render/fast_input'),
        '@quick': resolve('render/quick')
      }
    },
    build: {
      rollupOptions: {
        input: {
          main: resolve('render/main/index.html'),
          window: resolve('render/window/index.html'),
          fast_input: resolve('render/fast_input/index.html'),
          quick: resolve('render/quick/index.html')
        }
      }
    },
    plugins: [vue()]
  }
})
