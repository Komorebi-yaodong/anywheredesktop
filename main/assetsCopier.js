import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const rendererDir = path.join(__dirname, '../out/renderer')
const publicDir = path.join(__dirname, '../public')

const filesToCopy = ['user.png', 'icon.png']

export function copyPublicAssets() {
  if (!fs.existsSync(rendererDir)) return

  for (const file of filesToCopy) {
    const sourcePath = path.join(publicDir, file)
    const targetPath = path.join(rendererDir, file)

    if (!fs.existsSync(sourcePath)) continue

    try {
      fs.copyFileSync(sourcePath, targetPath)
    } catch (error) {
      console.error(`[assetsCopier] Failed to copy ${file}:`, error)
    }
  }
}
