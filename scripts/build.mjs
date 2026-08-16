import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { build } from 'esbuild'

const e2e = process.argv.slice(2).includes('--e2e')
const define = { __DSH_E2E__: JSON.stringify(e2e) }
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
  build({ entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', bundle: true, platform: 'node', format: 'esm', external: ['electron', '@deepseek-ai/*', 'node-addon-require-builtin'], sourcemap: e2e, define, minifySyntax: true, plugins: [e2eObserver] }),
  build({ entryPoints: ['src/preload/startup.ts'], outfile: 'dist/preload/startup.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/startup/index.ts'], outfile: 'dist/startup/index.js', bundle: true, platform: 'browser', format: 'esm', sourcemap: true })
])
if (!e2e) {
  const forbiddenMarkers = ['DSH_DESKTOP_TEST_HOST', 'DSH_DESKTOP_TEST_FAILURES', 'DSH_DESKTOP_TEST_USER_DATA', 'DSH_DESKTOP_TEST_EVENTS', 'Synthetic Host startup failure']
  for (const artifact of await mainArtifacts('dist/main')) {
    const contents = await readFile(artifact, 'utf8')
    for (const forbidden of forbiddenMarkers) {
      if (contents.includes(forbidden)) throw new Error(`production main artifact ${artifact} contains E2E hook: ${forbidden}`)
    }
  }
}
await mkdir('dist/startup', { recursive: true })
await Promise.all([
  cp('src/startup/index.html', 'dist/startup/index.html'),
  cp('src/startup/index.css', 'dist/startup/index.css')
])

async function mainArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => {
    const target = `${directory}/${entry.name}`
    return entry.isDirectory() ? mainArtifacts(target) : [target]
  }))).flat()
}
