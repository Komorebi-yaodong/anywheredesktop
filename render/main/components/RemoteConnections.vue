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
const devices = ref([])
const auditEntries = ref([])
let removeStatusListener = null

const primaryEndpoint = computed(() => status.value.endpoints?.[0] || '')
const isEnabled = computed(() => settings.value.enabled === true)

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
    remote_endpoint_invalid: '公开连接地址必须是完整 HTTPS 地址。'
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
  try {
    pairing.value = await window.api.createRemotePairing()
  } catch (error) {
    ElMessage.error(`生成配对二维码失败：${error.message || error}`)
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
  <el-dialog v-model="visible" title="手机远程（Remote v2）" width="720px" :close-on-click-modal="false" class="remote-v2-dialog">
    <div v-loading="loading" class="remote-v2-content">
      <el-alert
        title="默认关闭。启用后仅允许经二维码配对、应用层端到端加密的手机连接；关闭服务会立即断开全部已连接设备。"
        type="warning"
        :closable="false"
        show-icon
      />

      <section class="remote-service-card">
        <div>
          <h3>局域网服务</h3>
          <p v-if="status.running">正在监听 {{ status.host }}:{{ status.port }}，在线设备 {{ status.devicesOnline || 0 }} 台。</p>
          <p v-else>关闭状态。启用后，手机可在同一局域网扫码配对。</p>
        </div>
        <div class="remote-service-actions">
          <el-input-number v-model="settings.port" :min="1024" :max="65535" :step="1" :disabled="loading" controls-position="right" />
          <el-button plain :disabled="loading" @click="saveAndConfigure(settings.enabled)">应用配置</el-button>
          <el-button :type="isEnabled ? 'danger' : 'primary'" :icon="isEnabled ? VideoPause : VideoPlay" :loading="loading" @click="saveAndConfigure(!isEnabled)">
            {{ isEnabled ? '关闭服务' : '启用服务' }}
          </el-button>
        </div>
      </section>

      <el-alert v-if="status.lastError" :title="statusErrorText(status.lastError)" type="error" :closable="false" show-icon />

      <section class="remote-section">
        <div class="section-heading">
          <div>
            <h3>高级：公开 Tunnel 地址</h3>
            <p>可填写 Cloudflare Tunnel、Tailscale Funnel 或反向代理提供的 HTTPS 地址。Tunnel 仅传输密文，仍由应用层端到端加密保护内容。</p>
          </div>
        </div>
        <el-input v-model="settings.publicEndpoint" placeholder="https://remote.example.com（可选）" :disabled="loading" @change="saveAndConfigure(settings.enabled)" />
      </section>

      <template v-if="status.running">
        <section class="remote-section">
          <div class="section-heading">
            <div>
              <h3>连接新手机</h3>
              <p>扫码后，手机还必须输入下面的 6 位验证码。二维码不包含验证码，2 分钟后自动失效。</p>
            </div>
            <el-button :icon="Refresh" :loading="pairingLoading" @click="createPairing">生成二维码</el-button>
          </div>

          <div class="endpoint-list">
            <div v-for="endpoint in status.endpoints" :key="endpoint" class="endpoint-row">
              <code>{{ endpoint }}</code>
              <el-button link :icon="CopyDocument" @click="copyText(endpoint, '连接地址已复制。')">复制</el-button>
            </div>
            <el-empty v-if="!status.endpoints?.length" description="未检测到可用局域网 IPv4 地址" :image-size="56" />
          </div>

          <div v-if="pairing" class="pairing-card">
            <img :src="pairing.qrDataUrl" alt="手机远程配对二维码">
            <div class="pairing-details">
              <h3>扫描二维码配对</h3>
              <span class="pairing-label">在手机上输入验证码</span>
              <strong>{{ pairing.pairingCode }}</strong>
              <small>有效至 {{ formatTime(pairing.expiresAt) }}</small>
              <small>证书指纹：{{ pairing.certificateFingerprint }}</small>
              <el-button link :icon="CopyDocument" @click="copyText(primaryEndpoint, '连接地址已复制。')">复制当前连接地址</el-button>
            </div>
          </div>
        </section>

        <section class="remote-section">
          <div class="section-heading">
            <div>
              <h3>已配对设备</h3>
              <p>撤销设备会立即断开它的连接，并使其无法再次登录。</p>
            </div>
            <el-button :icon="Refresh" circle @click="refresh" />
          </div>
          <el-empty v-if="devices.length === 0" description="暂无已配对设备" :image-size="60" />
          <div v-else class="remote-device-list">
            <article v-for="device in devices" :key="device.deviceId" class="remote-device-item">
              <el-icon class="device-icon"><Connection /></el-icon>
              <div class="device-meta">
                <strong>{{ device.displayName }}</strong>
                <span>{{ device.platform || 'unknown' }}{{ device.appVersion ? ` · ${device.appVersion}` : '' }}</span>
                <small>{{ device.online ? '在线' : `最后在线：${formatTime(device.lastSeenAt)}` }}</small>
              </div>
              <div class="device-actions">
                <el-button link @click="renameDevice(device)">重命名</el-button>
                <el-button link type="danger" :icon="Delete" @click="revokeDevice(device)">撤销</el-button>
              </div>
            </article>
          </div>
        </section>

        <section class="remote-section">
          <div class="section-heading">
            <div>
              <h3>安全审计</h3>
              <p>仅记录时间、设备 ID、操作类型和结果；不记录消息正文、配置秘密、附件或密钥。</p>
            </div>
            <el-button :icon="Refresh" circle @click="refresh" />
          </div>
          <el-empty v-if="auditEntries.length === 0" description="暂无审计事件" :image-size="48" />
          <div v-else class="audit-list">
            <div v-for="entry in auditEntries" :key="`${entry.at}-${entry.type}-${entry.deviceId}`" class="audit-row">
              <el-icon><Document /></el-icon>
              <span>{{ formatTime(entry.at) }}</span>
              <strong>{{ entry.type }}</strong>
              <small>{{ entry.deviceId ? entry.deviceId.slice(0, 12) : '桌面端' }} · {{ entry.result || '—' }}</small>
            </div>
          </div>
        </section>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.remote-v2-content { display: grid; gap: 16px; }
.remote-service-card, .remote-device-item { display: flex; align-items: center; gap: 16px; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; padding: 16px; }
.remote-service-card { justify-content: space-between; background: var(--el-fill-color-lighter); }
.remote-service-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.remote-service-actions :deep(.el-input-number) { width: 124px; }
.remote-section { display: grid; gap: 10px; }
.section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
h3, p { margin: 0; }
h3 { font-size: 15px; font-weight: 650; }
p { margin-top: 5px; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.5; }
.endpoint-list, .remote-device-list, .audit-list { display: grid; gap: 8px; }
.endpoint-row, .audit-row { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 8px; background: var(--el-fill-color-light); }
.endpoint-row { justify-content: space-between; }
.endpoint-row code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pairing-card { display: flex; align-items: center; gap: 16px; padding: 14px; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; background: var(--el-fill-color-lighter); }
.pairing-card img { width: 152px; height: 152px; border-radius: 8px; background: white; image-rendering: pixelated; }
.pairing-details { display: grid; gap: 6px; min-width: 0; }
.pairing-details strong { font-size: 28px; letter-spacing: 4px; }
.pairing-label, .pairing-details small { color: var(--el-text-color-secondary); font-size: 12px; word-break: break-all; }
.device-icon { font-size: 24px; color: var(--el-color-primary); }
.device-meta { display: grid; gap: 2px; flex: 1; min-width: 0; }
.device-meta span, .device-meta small { color: var(--el-text-color-secondary); font-size: 12px; }
.device-actions { display: flex; gap: 4px; }
.audit-row { font-size: 12px; }
.audit-row > span { color: var(--el-text-color-secondary); width: 145px; }
.audit-row > strong { flex: 1; font-weight: 550; }
.audit-row > small { color: var(--el-text-color-secondary); }
@media (max-width: 640px) {
  .remote-service-card, .pairing-card { align-items: stretch; flex-direction: column; }
  .remote-service-actions { justify-content: space-between; }
  .pairing-card img { width: 180px; height: 180px; align-self: center; }
  .audit-row > span { width: auto; }
}
</style>
