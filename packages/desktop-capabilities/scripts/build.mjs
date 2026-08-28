import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const packageRoot = path.resolve(import.meta.dirname, '..')
const outputRoot = path.join(packageRoot, 'lib')

/** 运行声明生成器并保留真实退出状态。 */
function runTypeScript(argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(packageRoot, '..', '..', 'node_modules', 'typescript', 'bin', 'tsc'), ...argumentsList], {
      cwd: packageRoot,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`tsc exited with ${code ?? signal ?? 'unknown'}`))
    })
  })
}

/** 将一个能力包入口构建为可发布的浏览器 ESM。 */
async function buildEntry(source, output) {
  await build({
    entryPoints: [path.join(packageRoot, 'src', source)],
    outfile: path.join(outputRoot, output),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['@tauri-apps/api/core', '@tauri-apps/api/event'],
  })
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
await Promise.all([
  buildEntry('index.ts', 'index.js'),
  buildEntry('testing.ts', 'testing.js'),
])
await runTypeScript([
  '-p', 'tsconfig.build.json',
  '--declaration',
  '--emitDeclarationOnly',
  '--noEmit', 'false',
  '--outDir', 'lib/types',
])
