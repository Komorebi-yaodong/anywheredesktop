import {execFileSync} from 'node:child_process'
import {listPackage} from '@electron/asar'
import {existsSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const unpackedDir = path.resolve(process.env.WIN_UNPACKED_DIR || path.join(root, 'dist', 'win-unpacked'))
const asarPath = path.join(unpackedDir, 'resources', 'app.asar')
const electronPath = path.join(unpackedDir, 'anywhere-desktop.exe')

function fail(message) {
  console.error(`PACKAGED_RUNTIME_DEPENDENCY_ERROR: ${message}`)
  process.exit(1)
}

if (!existsSync(asarPath)) fail(`missing_asar:${asarPath}`)
if (!existsSync(electronPath)) fail(`missing_electron:${electronPath}`)

let asarEntries
try {
  asarEntries = listPackage(asarPath, {isPack: false})
    .filter(Boolean)
    .map(entry => entry.replaceAll('\\', '/').replace(/^\/+/, ''))
} catch (error) {
  fail(`asar_list_failed:${error instanceof Error ? error.message : String(error)}`)
}

const packagedEntries = new Set(asarEntries)
const packageRoots = [
  'selfsigned',
  '@peculiar/x509',
  '@peculiar/utils',
  '@peculiar/asn1-cms',
  '@peculiar/asn1-csr',
  '@peculiar/asn1-ecc',
  '@peculiar/asn1-pkcs9',
  '@peculiar/asn1-rsa',
  '@peculiar/asn1-schema',
  '@peculiar/asn1-x509',
  '@peculiar/asn1-x509-attr',
  'asn1js',
  'pkijs',
  'pvtsutils',
  'reflect-metadata',
  'tslib',
  'tsyringe',
]

const missingRoots = packageRoots.filter(
  packageName => !packagedEntries.has(`node_modules/${packageName}/package.json`),
)
if (missingRoots.length) fail(`missing_package_roots:${missingRoots.join(',')}`)

for (const entry of [
  'node_modules/selfsigned/index.js',
  'node_modules/@peculiar/x509/build/x509.cjs.js',
  'node_modules/@peculiar/utils/build/cjs/index.js',
  'node_modules/@peculiar/utils/build/cjs/converters/index.js',
  'node_modules/@peculiar/asn1-schema/build/cjs/index.js',
]) {
  if (!packagedEntries.has(entry)) fail(`missing_runtime_entry:${entry}`)
}

// Run the packaged Electron binary in Node mode. Generating a synthetic
// certificate exercises selfsigned's actual CommonJS dependency closure rather
// than only checking file names in the ASAR archive.
const runtimeProbe = `
  const path = require('node:path');
  const appAsar = process.argv[1];
  const selfsigned = require(path.join(appAsar, 'node_modules', 'selfsigned'));
  (async () => {
    const generated = await selfsigned.generate(
      [{ name: 'commonName', value: 'package-closure-test.invalid' }],
      { algorithm: 'sha256', keySize: 2048 },
    );
    if (!generated || !generated.cert || !generated.private) {
      throw new Error('selfsigned_result_invalid');
    }
    console.log('PACKAGED_SELF_SIGNED_RUNTIME_OK');
  })().catch(error => {
    console.error(error);
    process.exit(1);
  });
`

try {
  execFileSync(electronPath, ['-e', runtimeProbe, asarPath], {
    cwd: root,
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
    stdio: 'inherit',
    windowsHide: true,
  })
} catch (error) {
  fail(`runtime_probe_failed:${error instanceof Error ? error.message : String(error)}`)
}

console.log(JSON.stringify({
  ok: true,
  suite: 'verify-win-package',
  asarPath,
  packageRoots: packageRoots.length,
}))
