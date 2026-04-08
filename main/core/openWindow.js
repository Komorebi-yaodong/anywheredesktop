/**
 * openWindow.js - 独立对话窗口创建核心逻辑
 * 
 * 功能：
 * 1. 根据配置和消息类型计算窗口位置
 * 2. 避免窗口重叠
 * 3. 创建 BrowserWindow 并发送初始化消息
 * 4. 管理 windowMap（存活的独立对话窗口）
 */

import { BrowserWindow, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import icon from '../../resources/icon.png?asset'
import { resolveDefaultAssistantModel } from './data.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/** @type {Map<string, BrowserWindow>} */
export const windowMap = new Map()

/**
 * 计算窗口位置
 * @param {object} config - 配置对象
 * @param {string} promptCode - 快捷助手代码
 * @param {object|null} msg - 消息对象
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function getPosition(config, promptCode, msg = null) {
  const prompts = config?.prompts || {}
  const promptConfig = prompts[promptCode] || {}
  
  const OVERFLOW_ALLOWANCE = 10
  let width = Number(promptConfig?.window_width) || 580
  let height = Number(promptConfig?.window_height) || 740
  
  let windowX = 0
  let windowY = 0
  
  const primaryDisplay = screen.getPrimaryDisplay()
  const baseBounds = primaryDisplay.workArea || primaryDisplay.bounds
  
  let currentDisplay
  
  // --- 1. 定时任务 -> 右上角 ---
  if (msg && msg.type === 'task') {
    const padding = 30
    windowX = baseBounds.x + baseBounds.width - width - padding
    windowY = baseBounds.y + padding
    currentDisplay = primaryDisplay
  }
  // --- 2. 召唤任务 (Summon) -> 右下角 ---
  else if (msg && msg.type === 'summon') {
    const padding = 30
    windowX = baseBounds.x + baseBounds.width - width - padding
    windowY = baseBounds.y + baseBounds.height - height - padding
    currentDisplay = primaryDisplay
  }
  // --- 3. 普通唤起 -> 依据设置 (固定位置 或 屏幕中央) ---
  else {
    const hasFixedPosition = 
      config?.fix_position && 
      promptConfig?.position_x != null && 
      promptConfig?.position_y != null
    
    if (hasFixedPosition) {
      const set_position = {
        x: Number(promptConfig.position_x),
        y: Number(promptConfig.position_y)
      }
      currentDisplay = screen.getDisplayNearestPoint(set_position) || primaryDisplay
      windowX = Math.floor(set_position.x)
      windowY = Math.floor(set_position.y)
    } else {
      // 默认：屏幕中央
      currentDisplay = primaryDisplay
      windowX = baseBounds.x + (baseBounds.width - width) / 2
      windowY = baseBounds.y + (baseBounds.height - height) / 2
    }
  }
  
  // --- 边界溢出检查 ---
  if (currentDisplay) {
    const display = currentDisplay.bounds
    
    if (width > display.width) width = display.width
    if (height > display.height) height = display.height
    
    const minX = display.x - OVERFLOW_ALLOWANCE
    const maxX = display.x + display.width - width + OVERFLOW_ALLOWANCE
    const minY = display.y - OVERFLOW_ALLOWANCE
    const maxY = display.y + display.height - height + OVERFLOW_ALLOWANCE
    
    // 如果完全跑出屏幕，重置到屏幕中心
    if (
      (windowX + width < display.x) || 
      (windowX > display.x + display.width) ||
      (windowY + height < display.y) || 
      (windowY > display.y + display.height)
    ) {
      windowX = display.x + (display.width - width) / 2
      windowY = display.y + (display.height - height) / 2
    } else {
      // 贴边修正
      if (windowX < minX) windowX = minX
      if (windowX > maxX) windowX = maxX
      if (windowY < minY) windowY = minY
      if (windowY > maxY) windowY = maxY
    }
  }
  
  return { x: Math.round(windowX), y: Math.round(windowY), width, height }
}

/**
 * 清理已销毁的窗口引用
 */
export function cleanupDestroyedWindows() {
  for (const [senderId, win] of windowMap.entries()) {
    if (win.isDestroyed()) {
      windowMap.delete(senderId)
    }
  }
}

/**
 * 创建独立对话窗口
 * 
 * @param {object} config - 配置对象
 * @param {object} msg - 消息对象 { code, type, payload, ... }
 * @returns {Promise<string>} - 返回 senderId
 */
export async function createDialogWindow(config, msg) {
  const promptCode = msg?.originalCode || msg?.code || '__DEFAULT__'
  const promptConfig = config?.prompts?.[promptCode] || {}
  
  // 清理已销毁窗口
  cleanupDestroyedWindows()
  
  // 计算窗口位置
  let { x, y, width, height } = getPosition(config, promptCode, msg)
  
  // 重叠避免
  const OFFSET_STEP = 30
  const maxAttempts = 12
  let attempts = 0
  const originalX = x
  const originalY = y
  const primaryDisplay = screen.getPrimaryDisplay()
  const displayArea = screen.getDisplayNearestPoint({ x, y })?.workArea || primaryDisplay.workArea
  
  while (attempts < maxAttempts) {
    let isOverlap = false
    for (const win_instance of windowMap.values()) {
      if (!win_instance.isDestroyed() && win_instance.isVisible()) {
        try {
          const bounds = win_instance.getBounds()
          if (Math.abs(bounds.x - x) < 5 && Math.abs(bounds.y - y) < 5) {
            isOverlap = true
            break
          }
        } catch {
          // 忽略销毁窗口错误
        }
      }
    }
    
    if (!isOverlap) break
    
    attempts++
    let newX = originalX + attempts * OFFSET_STEP
    let newY = originalY + attempts * OFFSET_STEP
    
    if (displayArea && (newX + width > displayArea.x + displayArea.width || newY + height > displayArea.y + displayArea.height)) {
      newX = originalX - attempts * OFFSET_STEP
      newY = originalY - attempts * OFFSET_STEP
      
      if (newX < displayArea.x || newY < displayArea.y) {
        newX = Math.max(displayArea.x, newX)
        newY = Math.max(displayArea.y, newY)
        x = newX
        y = newY
        break
      }
    }
    
    x = newX
    y = newY
  }
  
  // 生成唯一 senderId
  const senderId = randomUUID()
  
  // 主题配置
  const isDarkMode = config?.isDarkMode ?? true
  const backgroundColor = isDarkMode ? 'rgba(33, 33, 33, 1)' : 'rgba(255, 255, 253, 1)'
  const isAlwaysOnTop = promptConfig?.isAlwaysOnTop ?? true
  
  // 窗口选项
  const windowOptions = {
    show: false,
    backgroundColor,
    title: `Anywhere - ${promptCode}`,
    width,
    height,
    x,
    y,
    alwaysOnTop: isAlwaysOnTop,
    frame: false,
    transparent: false,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/window_preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  }
  
  // 构建 URL
  const darkParam = isDarkMode ? '?dark=1' : ''
  const devPath = `/window/index.html${darkParam}`
  const prodPath = path.join(__dirname, `../renderer/window/index.html${darkParam}`)
  
  return new Promise((resolve) => {
    const win = new BrowserWindow(windowOptions)
    
    // 添加到 windowMap
    windowMap.set(senderId, win)
    
    // 窗口关闭时清理
    win.on('closed', () => {
      windowMap.delete(senderId)
    })
    
    // 加载页面
    if (is.dev && process.env.ELECTRON_RENDERER_URL) {
      win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${devPath}`)
    } else {
      win.loadFile(prodPath)
    }
    
    // 开发模式下打开 DevTools
    if (is.dev) {
      win.webContents.openDevTools({ mode: 'detach' })
    }
    
    // 发送初始化消息
    win.webContents.once('did-finish-load', () => {
      win.show()
      
      // 构建初始化消息
      const initMsg = {
        ...msg,
        senderId,
        code: msg?.code || promptCode,
        type: msg?.type || 'over',
        payload: msg?.payload || '',
        os: process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux',
        isAlwaysOnTop,
        config: {
          prompts: config?.prompts || {},
          providers: config?.providers || {},
          modelList: config?.modelList || [],
          mcpServers: config?.mcpServers || {},
          tasks: config?.tasks || {},
          isDarkMode,
          defaultTaskModel: config?.defaultTaskModel || '',
          systemPrompt: config?.systemPrompt || '',
          stream: config?.stream ?? true,
          CtrlEnterToSend: config?.CtrlEnterToSend ?? false,
          inputLayout: config?.inputLayout || 'bottom',
          voiceList: config?.voiceList || [],
          ...msg?.config
        }
      }
      
      // 如果是 __DEFAULT__，注入默认 prompt 配置
      if (promptCode === '__DEFAULT__' && !initMsg.config.prompts['__DEFAULT__']) {
        initMsg.config.prompts['__DEFAULT__'] = {
          type: 'general',
          prompt: '',
          showMode: 'window',
          model: resolveDefaultAssistantModel(config),
          stream: true,
          isAlwaysOnTop: true,
          autoCloseOnBlur: config?.autoCloseOnBlur_global ?? true,
          window_width: 580,
          window_height: 740,
          icon: ''
        }
      }
      
      try {
        win.webContents.send('window', initMsg)
      } catch (e) {
        console.error('[openWindow] Failed to send init message:', e)
      }
    })
    
    resolve(senderId)
  })
}

/**
 * 获取所有存活的对话窗口 ID
 * @returns {string[]}
 */
export function getAliveWindowIds() {
  const ids = []
  for (const [id, win] of windowMap.entries()) {
    if (!win.isDestroyed()) {
      ids.push(id)
    }
  }
  return ids
}

/**
 * 根据 ID 获取窗口
 * @param {string} senderId 
 * @returns {BrowserWindow|null}
 */
export function getWindowById(senderId) {
  const win = windowMap.get(senderId)
  if (!win || win.isDestroyed()) return null
  return win
}

/**
 * 向指定窗口发送事件
 * @param {string} senderId 
 * @param {string} channel 
 * @param {any} payload 
 */
export function sendToWindow(senderId, channel, payload) {
  const win = getWindowById(senderId)
  if (!win) return false
  
  try {
    win.webContents.send(channel, payload)
    return true
  } catch {
    return false
  }
}