import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import {getLanIpv4Addresses} from '../main/core/remote/lanAddresses.js'
const ipv4 = address => ({address, family: 'IPv4', internal: false})
const fixture = {
  'Ethernet 5': [ipv4('192.168.56.1')],
  WLAN: [ipv4('192.168.77.17')],
  'VirtualBox Host-Only': [ipv4('192.168.56.1')],
  lo: [{...ipv4('127.0.0.1'), internal: true}],
  unused: [ipv4('169.254.1.1'), {address: '::1', family: 'IPv6'}, ipv4('invalid')],
}
assert.deepEqual(getLanIpv4Addresses(fixture), ['192.168.77.17', '192.168.56.1'])
assert.deepEqual(getLanIpv4Addresses({Ethernet: [ipv4('10.0.0.2')], Docker: [ipv4('10.0.0.1')]}), ['10.0.0.2', '10.0.0.1'])
assert.deepEqual(getLanIpv4Addresses({Ethernet: [ipv4('10.0.0.2'), ipv4('10.0.0.2')]}), ['10.0.0.2'])
const source = await fs.readFile(new URL('../main/core/remote/index.js', import.meta.url), 'utf8')
const start = source.indexOf('function buildEndpoints(')
const end = source.indexOf('\nfunction statusErrorCode', start)
const build = vm.runInNewContext(source.slice(start, end) + '; buildEndpoints', {getLanIpv4Addresses, certificateCoversHost: (_cert, host) => !host.startsWith('uncovered')})
assert.deepEqual(Array.from(build({host: '0.0.0.0', port: 17860}, {lanAddresses: getLanIpv4Addresses(fixture)})), ['https://192.168.77.17:17860', 'https://192.168.56.1:17860'])
assert.deepEqual(Array.from(build({host: '0.0.0.0', port: 17860, publicEndpoint: 'https://synthetic.example.test'}, {lanAddresses: ['192.168.77.17', 'uncovered.example']})), ['https://synthetic.example.test', 'https://192.168.77.17:17860'])
console.log(JSON.stringify({ok: true, suite: 'remote-lan-priority', currentLocalCandidateOrder: getLanIpv4Addresses(os.networkInterfaces())}))
