import { cp, mkdir, rm } from 'node:fs/promises'
import { build } from 'esbuild'
import sharp from 'sharp'

const e2e = process.argv.slice(2).includes('--e2e')
const define = { __DSH_E2E__: JSON.stringify(e2e) }
const desktopLogoFileName = 'dsh-desktop-logo.svg'
const desktopLogoSource = `assets/${desktopLogoFileName}`
const desktopLogoRuntimePath = `dist/assets/${desktopLogoFileName.replace(/\.svg$/, '.png')}`
await rm('dist', { recursive: true, force: true })
await Promise.all([
  build({ entryPoints: ['src/sidecar/index.ts'], outfile: 'dist/sidecar/index.js', bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/*', 'node-addon-require-builtin'], sourcemap: e2e, define }),
  build({ entryPoints: ['src/startup/index.ts'], outfile: 'dist/startup/index.js', bundle: true, platform: 'browser', format: 'esm', sourcemap: true, define })
])
// Tauri 仅打包 sidecar 与启动页资源，桌面主程序由 Rust 构建。
await mkdir('dist/startup', { recursive: true })
await mkdir('dist/assets', { recursive: true })
await Promise.all([
  cp('src/startup/index.html', 'dist/startup/index.html'),
  cp('src/startup/index.css', 'dist/startup/index.css'),
  cp(desktopLogoSource, `dist/assets/${desktopLogoFileName}`),
  sharp(desktopLogoSource).resize(1024, 1024).png().toFile(desktopLogoRuntimePath)
])

