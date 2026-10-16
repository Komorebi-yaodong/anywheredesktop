<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { Connection, CopyDocument, Delete, Document, Refresh, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const visible = ref(false)
const loading = ref(false)
const pairingLoading = ref(false)
const status = ref({
  running: false,
  enabled: false,
  host: '0.0.0.0',
  port: 17860,
  publicEndpoint: '',
  endpoints: [],
  certificateFingerprint: '',
  lastError: '',
  devicesOnline: 0,
  protocolVersion: 2
})
const settings = ref({ enabled: false, host: '0.0.0.0', port: 17860, publicEndpoint: '' })
const pairing = ref(null)
const qrZoomVisible = ref(false)

const advancedOpen = ref(false)
const auditOpen = ref(false)
const devices = ref([])
const auditEntries = ref([])
let removeStatusListener = null

const isEnabled = computed(() => settings.value.enabled === true)

const visibleAuditEntries = computed(() => auditOpen.value ? auditEntries.value : [])

function normalizeSettings(source = {}) {
  return {
    enabled: source.enabled === true,
    host: typeof source.host === 'string' && source.host.trim() ? source.host.trim() : '0.0.0.0',
    port: Number.isInteger(Number(source.port)) ? Number(source.port) : 17860,
    publicEndpoint: typeof source.publicEndpoint === 'string' ? source.publicEndpoint.trim() : ''
  }
}

function statusErrorText(code = '') {
  const map = {
    remote_port_in_use: '端口已被占用，请更换端口后重试。',
    remote_secure_storage_unavailable: '系统安全存储不可用，无法安全保存远程身份密钥。',
    remote_start_failed: '远程服务启动失败。',
    remote_endpoint_invalid: '公开连接地址必须是完整 HTTPS 地址。',
    remote_certificate_lan_address_changed: '网络地址已变化；已保留现有设备的证书信任，仅显示证书覆盖地址。请使用可用地址或 Tunnel；若需换证，请先明确撤销全部设备后重新生成二维码。'
  }
  return map[code] || (code ? `服务异常：${code}` : '')
}

async function refresh() {
  loading.value = true
  try {
    const [nextStatus, deviceResult, auditResult] = await Promise.all([
      window.api.getRemoteStatus(),
      window.api.listRemoteDevices(),
      window.api.getRemoteAuditLog()
    ])
    status.value = nextStatus || status.value
    settings.value = normalizeSettings(nextStatus || settings.value)
    devices.value = Array.isArray(deviceResult?.devices) ? deviceResult.devices : []
    auditEntries.value = Array.isArray(auditResult?.entries) ? auditResult.entries.slice(0, 8) : []
  } catch (error) {
    ElMessage.error(`读取手机远程状态失败：${error.message || error}`)
  } finally {
    loading.value = false
  }
}

async function saveAndConfigure(enabled = settings.value.enabled) {
  const port = Number(settings.value.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    ElMessage.warning('端口必须是 1024 至 65535 之间的整数。')
    return
  }
  const next = { ...settings.value, enabled: enabled === true, port }
  loading.value = true
  try {
    const result = await window.api.saveAndConfigureRemote(next)
    if (result?.ok === false) {
      status.value = result.status || status.value
      throw new Error(result?.error?.message || result?.status?.lastError || 'remote_start_failed')
    }
    status.value = result.status || status.value
    settings.value = normalizeSettings(status.value)
    pairing.value = null
    await refresh()
    ElMessage.success(next.enabled ? '手机远程服务已启动。' : '手机远程服务已关闭，所有手机连接已断开。')
  } catch (error) {
    ElMessage.error(statusErrorText(error?.message) || `保存远程服务失败：${error.message || error}`)
  } finally {
    loading.value = false
  }
}

async function createPairing() {
  if (!status.value.running) {
    ElMessage.warning('请先启用手机远程服务。')
    return
  }
  pairingLoading.value = true
  pairing.value = null
  qrZoomVisible.value = false
  try {
    pairing.value = await window.api.createRemotePairing()
  } catch (error) {
    ElMessage.error(statusErrorText(error?.message) || '生成配对二维码失败，请重新打开远程设置。')
  } finally {
    pairingLoading.value = false
  }
}

async function copyText(value, successMessage) {
  if (!value) return
  try {
    await window.api.copyText(value)
    ElMessage.success(successMessage)
  } catch (error) {
    ElMessage.error(`复制失败：${error.message || error}`)
  }
}

async function renameDevice(device) {
  try {
    const { value } = await ElMessageBox.prompt('请输入设备名称', '重命名已配对设备', {
      inputValue: device.displayName,
      inputPattern: /\S+/,
      inputErrorMessage: '设备名称不能为空。'
    })
    await window.api.renameRemoteDevice(device.deviceId, value)
    await refresh()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(`重命名失败：${error.message || error}`)
  }
}

async function revokeDevice(device) {
  try {
    await ElMessageBox.confirm(
      `撤销“${device.displayName}”后，该手机必须重新扫码并输入验证码配对。`,
      '撤销设备访问',
      { type: 'warning', confirmButtonText: '撤销', cancelButtonText: '取消' }
    )
    await window.api.revokeRemoteDevice(device.deviceId)
    await refresh()
    ElMessage.success('设备访问已撤销。')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(`撤销失败：${error.message || error}`)
  }
}

function formatTime(value = '') {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString()
}


function deviceSubtitle(device = {}) {
  const parts = [device.deviceModel || device.platform || '手机']
  if (device.appVersion) parts.push(`Anywhere Mobile ${device.appVersion}`)
  return parts.join(' · ')
}

async function openDialog() {
  visible.value = true
  pairing.value = null
  await refresh()
  if (!removeStatusListener && window.api?.onRemoteStatusChanged) {
    removeStatusListener = window.api.onRemoteStatusChanged((nextStatus) => {
      status.value = nextStatus || status.value
      settings.value = normalizeSettings(status.value)
      if (visible.value) {
        window.api.listRemoteDevices().then((result) => {
          devices.value = Array.isArray(result?.devices) ? result.devices : []
        }).catch(() => {})
      }
    })
  }
}

onBeforeUnmount(() => {
  removeStatusListener?.()
  removeStatusListener = null
})

defineExpose({ openDialog })
</script>

<template>
  <el-dialog v-model="visible" title="手机远程" width="760px" :close-on-click-modal="false" class="remote-v2-dialog">
    <div v-loading="loading" class="remote-v2-content">
      <section class="remote-service-card">
        <div class="service-state">
          <span :class="['status-dot', status.running ? 'online' : 'offline']" />
          <div class="service-title-row">
            <h3>手机远程</h3>
            <span :class="['service-summary', status.running ? 'is-running' : '']">{{ status.running ? `服务已开启 · ${status.devicesOnline || 0} 台设备在线` : '服务未开启' }}</span>
          </div>
        </div>
        <div class="remote-service-actions">
          <span class="port-label">端口</span>
          <el-input-number v-model="settings.port" :min="1024" :max="65535" :step="1" :disabled="loading" controls-position="right" />
          <el-button plain :disabled="loading" @click="saveAndConfigure(settings.enabled)">保存配置</el-button>
          <el-button :type="isEnabled ? 'danger' : 'primary'" :icon="isEnabled ? VideoPause : VideoPlay" :loading="loading" @click="saveAndConfigure(!isEnabled)">
            {{ isEnabled ? '关闭服务' : '启用服务' }}
          </el-button>
        </div>
      </section>

      <el-alert v-if="status.lastError" :title="statusErrorText(status.lastError)" type="error" :closable="false" show-icon />

      <section class="advanced-section">
        <button class="section-toggle" type="button" @click="advancedOpen = !advancedOpen">
          <span>高级：公网连接</span>
          <span class="toggle-hint">{{ advancedOpen ? '收起' : '配置 Tunnel 或反向代理' }}</span>
        </button>
        <div v-show="advancedOpen" class="advanced-body">
          <p>填写 Cloudflare Tunnel、外网穿透或反向代理提供的 HTTPS 地址。</p>
          <el-input v-model="settings.publicEndpoint" placeholder="https://remote.example.com" :disabled="loading" @change="saveAndConfigure(settings.enabled)" />
        </div>
      </section>

      <template v-if="status.running">
        <section class="remote-section pairing-section">
          <div class="section-heading pairing-heading">
            <div>
              <h3>连接新手机</h3>
              <p>扫码成功，在手机端输入下面的 6 位验证码，有效期 2 分钟。</p>
            </div>
            <div class="pairing-actions">
              <el-tooltip placement="bottom-end" :show-after="150">
                <template #content>
                  <div class="endpoint-tooltip">
                    <strong>可用连接地址</strong>
                    <code v-for="endpoint in status.endpoints" :key="endpoint">{{ endpoint }}</code>
                    <span v-if="!status.endpoints?.length">未检测到可用地址</span>
                  </div>
                </template>
                <el-button circle aria-label="查看连接地址">?</el-button>
              </el-tooltip>
              <el-button type="primary" size="large" :icon="Refresh" :loading="pairingLoading" @click="createPairing">生成配对二维码</el-button>
            </div>
          </div>

          <div v-if="pairing" class="pairing-card">
            <button class="qr-preview" type="button" aria-label="放大配对二维码" @click="qrZoomVisible = true">
              <img :src="pairing.qrDataUrl" alt="手机远程配对二维码">
              <span>点击放大二维码</span>
            </button>
            <div class="pairing-details">
              <span class="pairing-kicker">配对验证码</span>
              <strong>{{ pairing.pairingCode }}</strong>
              <span class="pairing-expiry">{{ formatTime(pairing.expiresAt) }} 前有效</span>
              <div class="pairing-divider" />
              <span class="pairing-note">二维码不包含验证码，请在手机端单独输入。</span>
              <el-button link :icon="CopyDocument" @click="copyText(pairing.qrPayload, '二维码内容已复制，可在手机中粘贴。')">复制二维码内容</el-button>
            </div>
          </div>
          <div v-else class="pairing-empty">
            <span>生成二维码后，用 Anywhere Mobile 扫码即可开始配对。</span>
          </div>
        </section>

        <section class="remote-section">
          <div class="section-heading">
            <div>
              <h3>已配对设备</h3>
              <p>{{ devices.length ? `已授权 ${devices.length} 台设备` : '暂无已配对设备' }}</p>
            </div>
            <el-button :icon="Refresh" circle aria-label="刷新设备" @click="refresh" />
          </div>
          <el-empty v-if="devices.length === 0" description="暂无已配对设备" :image-size="60" />
          <div v-else class="remote-device-list">
            <article v-for="device in devices" :key="device.deviceId" class="remote-device-item">
              <div class="device-icon-wrap"><el-icon class="device-icon"><Connection /></el-icon></div>
              <div class="device-meta">
                <strong>{{ device.displayName }}</strong>
                <span>{{ deviceSubtitle(device) }}</span>
                <span :class="['device-status', device.online ? 'is-online' : '']">{{ device.online ? '在线' : `最后连接 ${formatTime(device.lastSeenAt)}` }}</span>
              </div>
              <div class="device-actions">
                <el-button link @click="renameDevice(device)">重命名</el-button>
                <el-button link type="danger" :icon="Delete" @click="revokeDevice(device)">撤销</el-button>
              </div>
            </article>
          </div>
        </section>

        <section class="advanced-section audit-section">
          <button class="section-toggle" type="button" @click="auditOpen = !auditOpen">
            <span>连接记录 <em v-if="auditEntries.length">{{ auditEntries.length }}</em></span>
            <span class="toggle-hint">{{ auditOpen ? '收起' : '显示最近活动' }}</span>
          </button>
          <div v-show="auditOpen" class="audit-body" :class="{ expanded: auditOpen }">
            <el-empty v-if="auditEntries.length === 0" description="最近 30 天暂无连接记录" :image-size="44" />
            <div v-else class="audit-list">
              <div v-for="entry in visibleAuditEntries" :key="`${entry.at}-${entry.action}-${entry.deviceName}`" class="audit-row">
                <el-icon><Document /></el-icon>
                <strong>{{ entry.action }}</strong>
                <span>{{ entry.deviceName || '本机服务' }}</span>
                <time>{{ formatTime(entry.at) }}</time>
              </div>
            </div>
          </div>
        </section>
      </template>

      <el-dialog v-model="qrZoomVisible" title="扫描配对二维码" width="min(88vw, 760px)" append-to-body>
        <img v-if="pairing" class="qr-fullsize" :src="pairing.qrDataUrl" alt="放大的手机配对二维码">
        <p class="qr-dialog-note">请点击放大后的二维码进行扫描；验证码请从原配对面板单独读取。</p>
      </el-dialog>
    </div>
  </el-dialog>
</template>

<style scoped>
.remote-v2-content { display: grid; gap: 14px; padding: 2px 0 4px; }
.remote-service-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 14px; background: linear-gradient(135deg, var(--el-fill-color-light), var(--el-fill-color-lighter)); }
.service-state, .service-title-row, .remote-service-actions, .pairing-actions, .device-actions { display: flex; align-items: center; }.service-state { gap: 10px; min-width: 0; }.service-title-row { gap: 9px; flex-wrap: wrap; }.status-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: var(--el-color-info-light-5); box-shadow: 0 0 0 3px var(--el-fill-color); }.status-dot.online { background: var(--el-color-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--el-color-success) 14%, transparent); }.service-summary { color: var(--el-text-color-secondary); font-size: 12px; }.service-summary.is-running { color: var(--el-color-success); }
h3, p { margin: 0; } h3 { font-size: 15px; font-weight: 680; color: var(--el-text-color-primary); } p, .toggle-hint { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
.remote-service-actions { gap: 7px; flex-shrink: 0; }.remote-service-actions :deep(.el-input-number) { width: 105px; }.port-label { color: var(--el-text-color-secondary); font-size: 12px; }
.remote-section { display: grid; gap: 10px; }.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }.pairing-heading { align-items: center; }.pairing-actions { gap: 8px; flex-shrink: 0; }.pairing-actions :deep(.el-button--large) { box-shadow: 0 7px 14px color-mix(in srgb, var(--el-color-primary) 22%, transparent); font-weight: 650; }
.advanced-section { border: 1px solid var(--el-border-color-lighter); border-radius: 11px; overflow: hidden; background: var(--el-fill-color-lighter); }.section-toggle { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 13px; color: var(--el-text-color-primary); font: inherit; font-size: 13px; font-weight: 650; border: 0; background: transparent; cursor: pointer; text-align: left; }.section-toggle:hover { background: var(--el-fill-color); }.section-toggle em { margin-left: 6px; color: var(--el-text-color-secondary); font-style: normal; font-weight: 500; }.advanced-body { display: grid; gap: 8px; padding: 0 13px 13px; border-top: 1px solid var(--el-border-color-lighter); }.advanced-body p { padding-top: 8px; }
.pairing-card { display: grid; grid-template-columns: 240px 1fr; align-items: center; gap: 22px; padding: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 15px; background: var(--el-fill-color-lighter); }.qr-preview { display: grid; justify-items: center; gap: 7px; padding: 9px; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; background: #fff; cursor: zoom-in; color: var(--el-color-primary); font-size: 12px; font-weight: 600; }.qr-preview img { display: block; width: 220px; height: 220px; image-rendering: pixelated; }.pairing-details { display: grid; align-content: center; justify-items: start; gap: 8px; min-width: 0; }.pairing-kicker { color: var(--el-text-color-secondary); font-size: 12px; }.pairing-details strong { color: var(--el-text-color-primary); font-size: 31px; letter-spacing: 6px; line-height: 1; }.pairing-expiry { color: var(--el-text-color-secondary); font-size: 12px; }.pairing-divider { width: 100%; height: 1px; background: var(--el-border-color-lighter); margin: 3px 0; }.pairing-note { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.55; }.pairing-empty { display: grid; place-items: center; min-height: 105px; border: 1px dashed var(--el-border-color); border-radius: 12px; color: var(--el-text-color-secondary); font-size: 13px; }
.endpoint-tooltip { display: grid; gap: 7px; max-width: 360px; }.endpoint-tooltip strong { font-size: 12px; }.endpoint-tooltip code { overflow-wrap: anywhere; font-size: 11px; opacity: .9; }
.remote-device-list { display: grid; gap: 7px; }.remote-device-item { display: flex; align-items: center; gap: 10px; min-height: 50px; padding: 9px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 11px; background: var(--el-fill-color-lighter); }.device-icon-wrap { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 auto; border-radius: 9px; background: color-mix(in srgb, var(--el-color-primary) 10%, transparent); }.device-icon { font-size: 16px; color: var(--el-color-primary); }.device-meta { display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0; }.device-meta strong { white-space: nowrap; font-size: 13px; }.device-meta > span:not(.device-status) { overflow: hidden; color: var(--el-text-color-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.device-status { padding: 2px 6px; border-radius: 99px; background: var(--el-fill-color); color: var(--el-text-color-secondary); font-size: 10px; white-space: nowrap; }.device-status.is-online { background: color-mix(in srgb, var(--el-color-success) 13%, transparent); color: var(--el-color-success); }.device-actions { gap: 3px; flex: 0 0 auto; }
.audit-section { background: transparent; }.audit-body { display: grid; gap: 7px; padding: 0 13px; max-height: 122px; overflow: hidden; }.audit-body.expanded { padding-bottom: 10px; overflow-y: auto; }.audit-list { display: grid; gap: 0; }.audit-row { display: grid; grid-template-columns: 17px auto minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 34px; padding: 5px 0; border-bottom: 1px solid var(--el-border-color-lighter); }.audit-row:last-child { border-bottom: 0; }.audit-row strong, .audit-row span, .audit-row time { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }.audit-row strong { font-weight: 600; }.audit-row span, .audit-row time { color: var(--el-text-color-secondary); }.audit-row time { font-size: 11px; }.qr-fullsize { display: block; width: min(100%, 680px); height: auto; margin: auto; image-rendering: pixelated; background: #fff; }.qr-dialog-note { margin-top: 10px; text-align: center; }
@media (max-width: 640px) { .remote-service-card, .remote-service-actions { align-items: stretch; flex-direction: column; }.remote-service-actions :deep(.el-input-number) { width: 100%; }.pairing-card { grid-template-columns: 1fr; gap: 14px; }.qr-preview { justify-self: center; }.pairing-details { justify-items: center; text-align: center; }.device-meta { flex-wrap: wrap; }.device-actions { flex-direction: column; align-items: flex-end; }.audit-row { grid-template-columns: 17px minmax(0, 1fr) auto; }.audit-row strong { grid-column: 2; }.audit-row span { grid-column: 2; }.audit-row time { grid-column: 3; grid-row: 1 / span 2; }.pairing-actions :deep(.el-button--large) { font-size: 12px; } }
</style>
