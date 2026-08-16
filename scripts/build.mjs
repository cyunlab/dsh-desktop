import { cp, mkdir, rm } from 'node:fs/promises'
import { build } from 'esbuild'

await rm('dist', { recursive: true, force: true })
await Promise.all([
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', bundle: true, platform: 'node', format: 'esm', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/preload/startup.ts'], outfile: 'dist/preload/startup.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/startup/index.ts'], outfile: 'dist/startup/index.js', bundle: true, platform: 'browser', format: 'esm', sourcemap: true })
])
await mkdir('dist/startup', { recursive: true })
await Promise.all([
  cp('src/startup/index.html', 'dist/startup/index.html'),
  cp('src/startup/index.css', 'dist/startup/index.css')
])
