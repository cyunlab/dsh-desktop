import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024

/** 通过 HTTPS 获取有界响应字节。 */
async function fetchBounded(url, maximumBytes, fetcher) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error(`update smoke URL must use HTTPS: ${parsed.hostname}`)
  const response = await fetcher(parsed.href, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`update smoke object is unreachable (${response.status})`)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error('update smoke object exceeds the byte bound')
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length <= 0 || body.length > maximumBytes) throw new Error('update smoke object size is out of bounds')
  return body
}

/** 验证 updater 包的原生容器 magic，不以扩展名冒充真实产物。 */
function verifyPackageMagic(target, body) {
  if (target === 'windows-x86_64') {
    if (body.subarray(0, 2).toString('ascii') !== 'MZ' || (!body.includes(Buffer.from('Nullsoft')) && !body.includes(Buffer.from('NSIS')))) {
      throw new Error('Windows updater is not an NSIS PE container')
    }
    return
  }
  if (target === 'linux-x86_64') {
    if (!body.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || !body.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]))) {
      throw new Error('Linux updater is not an AppImage type-2 container')
    }
    return
  }
  if (!target.startsWith('darwin-') || !body.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) {
    throw new Error('macOS updater is not a gzip application archive')
  }
}

/** 从权威 manifest 选择唯一 target，下载并验证 content-addressed updater 与 literal signature。 */
export async function prepareUpdateSmokeAsset(options, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch
  const manifestUrl = new URL(options.manifestUrl)
  if (options.label === 'candidate' && /\/channels\/stable\/latest\.json$/.test(manifestUrl.pathname)) {
    throw new Error('candidate smoke must use an isolated manifest, not Stable')
  }
  const manifestBody = await fetchBounded(manifestUrl.href, MAX_MANIFEST_BYTES, fetcher)
  let manifest
  try { manifest = JSON.parse(manifestBody.toString('utf8')) } catch { throw new Error('update smoke manifest is not valid JSON') }
  if (manifest.version !== options.expectedVersion) throw new Error(`manifest version does not match expected ${options.label} version`)
  const entry = manifest.platforms?.[options.target]
  if (!entry) throw new Error(`target is missing from ${options.label} manifest: ${options.target}`)
  if (typeof entry.signature !== 'string' || entry.signature.length === 0 || entry.signature.length > 32 * 1024) {
    throw new Error(`literal updater signature is missing or invalid for ${options.target}`)
  }
  const artifactUrl = new URL(entry.url)
  if (artifactUrl.protocol !== 'https:') throw new Error('updater package URL must use HTTPS')
  const basename = path.posix.basename(artifactUrl.pathname)
  const digestPrefix = /^([0-9a-f]{64})-/.exec(basename)?.[1]
  if (!digestPrefix) throw new Error('updater package URL is not content-addressed')
  const packageBody = await fetchBounded(artifactUrl.href, MAX_PACKAGE_BYTES, fetcher)
  const packageSha256 = createHash('sha256').update(packageBody).digest('hex')
  if (packageSha256 !== digestPrefix) throw new Error('package digest does not match immutable URL')
  verifyPackageMagic(options.target, packageBody)
  const outputRoot = path.join(options.outputDirectory, options.label)
  await mkdir(outputRoot, { recursive: true })
  const artifactPath = path.join(outputRoot, basename)
  const signaturePath = `${artifactPath}.sig`
  const manifestPath = path.join(outputRoot, 'manifest.json')
  await Promise.all([
    writeFile(artifactPath, packageBody, { flag: 'wx' }),
    writeFile(signaturePath, entry.signature, { flag: 'wx' }),
    writeFile(manifestPath, manifestBody, { flag: 'wx' })
  ])
  const result = Object.freeze({
    artifactPath,
    signaturePath,
    manifestPath,
    artifactUrl: artifactUrl.href,
    packageSha256,
    signatureSha256: createHash('sha256').update(entry.signature).digest('hex'),
    manifestSha256: createHash('sha256').update(manifestBody).digest('hex')
  })
  await writeFile(path.join(outputRoot, 'asset.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  return result
}

/** 解析 prepare CLI 的成对参数。 */
function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid update smoke asset argument: ${name ?? ''}`)
    const key = name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
    values[key] = value
  }
  return values
}

/** 执行 asset preparer CLI 并仅输出结构化公开元数据。 */
async function main() {
  const result = await prepareUpdateSmokeAsset(parseArguments(process.argv.slice(2)))
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
