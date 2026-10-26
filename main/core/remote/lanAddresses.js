import os from 'node:os'
import { isIP } from 'node:net'

// Rank likely physical Wi-Fi ahead of unknown/virtual adapters, but keep every
// valid candidate: interface names alone cannot prove reachability from a phone.
export function getLanIpv4Addresses(interfaces = os.networkInterfaces()) {
  const candidates = []
  for (const [name, items] of Object.entries(interfaces)) {
    const priority = /virtual|vbox|vmware|hyper-v|veth|docker|wsl|host.only|loopback|tap|tun\d|tailscale|zerotier/i.test(name)
      ? 2 : /wlan|wi-?fi|wireless|无线/i.test(name) ? 0 : 1
    for (const item of items || []) {
      if (!item || (item.family !== 'IPv4' && item.family !== 4) || item.internal
        || isIP(item.address || '') !== 4 || item.address.startsWith('169.254.')) continue
      candidates.push({address: item.address, priority})
    }
  }
  candidates.sort((a, b) => a.priority - b.priority || a.address.localeCompare(b.address, undefined, {numeric: true}))
  return [...new Set(candidates.map(item => item.address))]
}
