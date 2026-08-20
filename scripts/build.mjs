import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { build } from 'esbuild'
import sharp from 'sharp'

const e2e = process.argv.slice(2).includes('--e2e')
const define = { __DSH_E2E__: JSON.stringify(e2e) }
const desktopLogoFileName = 'dsh-desktop-logo.svg'
const desktopLogoSource = `assets/${desktopLogoFileName}`
const desktopLogoRuntimePath = `dist/assets/${desktopLogoFileName.replace(/\.svg$/, '.png')}`
const e2eObserver = {
  name: 'e2e-observer-build-variant',
  setup(builder) {
    if (e2e) return
    builder.onResolve({ filter: /\/e2e-observer\.js$/ }, () => ({ path: 'disabled', namespace: 'e2e-observer' }))
    builder.onLoad({ filter: /.*/, namespace: 'e2e-observer' }, () => ({
      contents: 'export function recordE2EEvent() {}\nexport function shouldSuppressExternalOpen() { return false }',
      loader: 'js'
    }))
  }
}
await rm('dist', { recursive: true, force: true })
await Promise.all([
  build({ entryPoints: ['src/sidecar/index.ts'], outfile: 'dist/sidecar/index.js', bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/*', 'node-addon-require-builtin'], sourcemap: e2e, define }),
  build({ entryPoints: ['src/startup/index.ts'], outfile: 'dist/startup/index.js', bundle: true, platform: 'browser', format: 'esm', sourcemap: true, external: ['@tauri-apps/api/*'] })
])
// Tauri only ships the sidecar and startup assets; the Electron main artifact gate is obsolete.
await mkdir('dist/startup', { recursive: true })
await mkdir('dist/assets', { recursive: true })
await Promise.all([
  cp('src/startup/index.html', 'dist/startup/index.html'),
  cp('src/startup/index.css', 'dist/startup/index.css'),
  cp(desktopLogoSource, `dist/assets/${desktopLogoFileName}`),
  sharp(desktopLogoSource).resize(1024, 1024).png().toFile(desktopLogoRuntimePath)
])

async function mainArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => {
    const target = `${directory}/${entry.name}`
    return entry.isDirectory() ? mainArtifacts(target) : [target]
  }))).flat()
}
