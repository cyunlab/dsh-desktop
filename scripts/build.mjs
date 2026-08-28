import { cp, mkdir, rm } from 'node:fs/promises'
import { build } from 'esbuild'
import sharp from 'sharp'
import { prepareRuntimeClosure } from './runtime-closure.mjs'

const e2e = process.argv.slice(2).includes('--e2e')
const define = { __DSH_E2E__: JSON.stringify(e2e) }
const desktopLogoFileName = 'dsh-desktop-logo.svg'
const desktopLogoSource = `assets/${desktopLogoFileName}`
const desktopLogoRuntimePath = `dist/assets/${desktopLogoFileName.replace(/\.svg$/, '.png')}`
await rm('dist', { recursive: true, force: true })
await build({ entryPoints: ['src/startup/index.ts'], outfile: 'dist/startup/index.js', bundle: true, platform: 'browser', format: 'esm', sourcemap: true, define })
await build({ entryPoints: ['src/update/index.ts'], outfile: 'dist/startup/update.js', bundle: true, platform: 'browser', format: 'esm', sourcemap: true, define })
// Tauri 打包启动页与 published CLI runtime closure，桌面主程序由 Rust 构建。
await mkdir('dist/startup', { recursive: true })
await mkdir('dist/startup/assets', { recursive: true })
await mkdir('dist/assets', { recursive: true })
await Promise.all([
  cp('src/startup/index.html', 'dist/startup/index.html'),
  cp('src/startup/index.css', 'dist/startup/index.css'),
  cp('src/update/index.html', 'dist/startup/update.html'),
  cp(desktopLogoSource, `dist/startup/assets/${desktopLogoFileName}`),
  cp(desktopLogoSource, `dist/assets/${desktopLogoFileName}`),
  sharp(desktopLogoSource).resize(1024, 1024).png().toFile(desktopLogoRuntimePath)
])
await prepareRuntimeClosure({ projectRoot: process.cwd(), outputRoot: 'dist' })
