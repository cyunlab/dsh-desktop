import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'

const packageRoot = path.resolve(import.meta.dirname, '..')
const outputRoot = path.join(packageRoot, 'lib')
const packageName = '@cyunlab/dsh-desktop-update-client'

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

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
await build({
  entryPoints: [path.join(packageRoot, 'src', 'index.ts')],
  outfile: path.join(outputRoot, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
})
await build({
  entryPoints: [path.join(packageRoot, 'src', 'client', 'index.tsx')],
  outfile: path.join(outputRoot, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-sidebar/client',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-locale',
  ],
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; }});' },
})
await runTypeScript([
  '-p', 'tsconfig.build.json',
  '--declaration',
  '--emitDeclarationOnly',
  '--noEmit', 'false',
  '--outDir', 'lib/types',
])
