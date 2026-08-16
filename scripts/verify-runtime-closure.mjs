import { access, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { verifyRequiredRuntimeAssets } from './runtime-assets.mjs'

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    manifest: { type: 'string' },
    'target-platform': { type: 'string' },
    'target-arch': { type: 'string' },
    'graph-only': { type: 'boolean', default: false }
  }
})
const appDir = await realpath(path.resolve(values['app-dir'] ?? '.'))
const target = {
  platform: values['target-platform'] ?? process.platform,
  arch: values['target-arch'] ?? process.arch
}
if (!['darwin', 'linux', 'win32'].includes(target.platform) || !['arm64', 'x64'].includes(target.arch)) {
  throw new Error(`unsupported runtime target: ${target.platform}-${target.arch}`)
}
const failures = []
const visited = new Set()
const queue = [{
  manifestPath: path.resolve(values.manifest ?? path.join(appDir, 'package.json')),
  resolveDir: appDir,
  chain: []
}]

while (queue.length > 0) {
  const current = queue.shift()
  const canonical = await realManifest(current.manifestPath)
  if (visited.has(canonical)) continue
  visited.add(canonical)
  const manifest = JSON.parse(await readFile(canonical, 'utf8'))
  const packageDir = current.resolveDir ?? path.dirname(canonical)
  const required = { ...manifest.dependencies }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true) required[name] = range
  }
  const optional = manifest.optionalDependencies ?? {}
  for (const name of Object.keys(required).sort()) {
    const dependency = await findPackageManifest(name, packageDir, appDir)
    if (dependency === undefined) {
      failures.push(`${[...current.chain, manifest.name ?? canonical, name].join(' -> ')} (missing required package)`)
    } else {
      queue.push({ manifestPath: dependency, chain: [...current.chain, manifest.name ?? canonical] })
    }
  }
  for (const name of Object.keys(optional).sort()) {
    const dependency = await findPackageManifest(name, packageDir, appDir)
    if (dependency !== undefined) queue.push({ manifestPath: dependency, chain: [...current.chain, manifest.name ?? canonical] })
  }

  for (const asset of ['cordis.patch.yml', 'cordis.patch.yaml']) {
    const assetPath = path.join(packageDir, asset)
    if (!await exists(assetPath)) continue
    const contents = await readFile(assetPath, 'utf8')
    const configured = [...contents.matchAll(/^\s*(?:-\s*)?name:\s*['"]?(@?[^'"\s#]+)['"]?\s*(?:#.*)?$/gm)]
      .map(match => match[1])
    for (const name of configured) {
      const dependency = await findPackageManifest(packageNameFromSpecifier(name), packageDir, appDir)
      if (dependency === undefined) {
        failures.push(`${manifest.name}/${asset} -> ${name} (missing dynamically configured package)`)
      } else {
        queue.push({ manifestPath: dependency, chain: [...current.chain, manifest.name ?? canonical] })
      }
    }
  }
}

if (!values['graph-only']) {
  for (const missing of await verifyRequiredRuntimeAssets(appDir, target)) {
    failures.push(`required runtime asset -> ${missing}`)
  }
}

if (failures.length > 0) {
  console.error('verify-runtime-closure: staged application is incomplete:')
  for (const failure of failures.sort()) console.error(`  ${failure}`)
  process.exitCode = 1
} else {
  console.log(`verify-runtime-closure: runtime closure verified (${visited.size} packages).`)
}

async function findPackageManifest(name, fromDir, root) {
  const segments = name.split('/')
  let cursor = fromDir
  while (isWithin(root, cursor)) {
    const candidate = path.join(cursor, 'node_modules', ...segments, 'package.json')
    if (await exists(candidate)) return candidate
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const rootCandidate = path.join(root, 'node_modules', ...segments, 'package.json')
  return await exists(rootCandidate) ? rootCandidate : undefined
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function realManifest(manifestPath) {
  return realpath(manifestPath)
}

function packageNameFromSpecifier(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

async function exists(target) {
  try { await access(target); return true } catch { return false }
}
