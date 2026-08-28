import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TARGETS = Object.freeze([
  'windows-x86_64',
  'linux-x86_64',
  'darwin-aarch64',
  'darwin-x86_64'
])

/** 以对象内容 SHA-256 为 canonical 文件名增加不可变地址前缀。 */
function contentAddressedName(filename, body) {
  return `${createHash('sha256').update(body).digest('hex')}-${filename}`
}

/** 将 GitHub Release tag 解析为 Stable channel 使用的语义版本。 */
function releaseVersion(tag) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(tag ?? '')
  if (!match) throw new Error(`release tag is not a semantic version: ${tag ?? ''}`)
  return tag.startsWith('v') ? tag.slice(1) : tag
}

/** 去除对象键首尾斜杠，防止逃离应用专属 OSS 前缀。 */
function normalizePrefix(prefix) {
  const normalized = String(prefix ?? '').replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('a safe OSS application prefix is required')
  }
  return normalized
}

/** 定位某个目标唯一的更新包及其字面签名文件。 */
async function readTargetArtifact(directory, target) {
  const targetDirectory = path.join(directory, target)
  const names = await readdir(targetDirectory)
  const suffix = target === 'windows-x86_64'
    ? '.exe'
    : target === 'linux-x86_64'
      ? '.AppImage'
      : '.app.tar.gz'
  const packages = names.filter(name => name === `dsh-desktop-${target}-updater${suffix}`)
  if (packages.length !== 1) throw new Error(`expected exactly one updater package for ${target}`)
  const filename = packages[0]
  const signatureName = `${filename}.sig`
  if (!names.includes(signatureName)) throw new Error(`updater signature is missing for ${target}`)
  const [body, signatureBody] = await Promise.all([
    readFile(path.join(targetDirectory, filename)),
    readFile(path.join(targetDirectory, signatureName))
  ])
  if (target === 'windows-x86_64' && !(body[0] === 0x4d && body[1] === 0x5a)) {
    throw new Error('invalid Windows updater executable')
  }
  if (target === 'linux-x86_64' && !(
    body[0] === 0x7f && body[1] === 0x45 && body[2] === 0x4c && body[3] === 0x46 &&
    body[8] === 0x41 && body[9] === 0x49 && body[10] === 0x02
  )) throw new Error('invalid Linux AppImage updater')
  if (target.startsWith('darwin-') && !(body[0] === 0x1f && body[1] === 0x8b && body[2] === 0x08)) {
    throw new Error('invalid macOS updater archive')
  }
  const signature = signatureBody.toString('utf8')
  if (!signature) throw new Error(`updater signature is empty for ${target}`)
  return {
    filename,
    artifactPath: path.join(targetDirectory, filename),
    signaturePath: path.join(targetDirectory, signatureName),
    body,
    signature,
    signatureBody
  }
}

/** 以无 shell 子进程运行 minisign 并要求签名验证成功。 */
export function runMinisignCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('minisign', args, {
      env: options.env ?? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`minisign verification failed (${code}): ${stderr.trim()}`))
      else resolve()
    })
  })
}

/** 使用嵌入发布环境的公钥验证单个 Tauri updater 签名。 */
export async function verifyTauriSignature(artifactPath, signaturePath, publicKey, runMinisign = runMinisignCommand) {
  const normalizedPublicKey = String(publicKey ?? '').trim()
  if (!normalizedPublicKey) throw new Error('TAURI_SIGNING_PUBLIC_KEY is required')
  await runMinisign(
    ['-Vm', artifactPath, '-x', signaturePath, '-P', normalizedPublicKey],
    { shell: false, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }
  )
}

/** 以无 shell 子进程运行 ossutil，并仅收集命令结果。 */
export function runOssutilCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ossutil', args, {
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout = []
    let stderr = ''
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`ossutil exited ${code}: ${stderr.trim()}`))
      else resolve({ stdout: Buffer.concat(stdout), stderr })
    })
  })
}

/** 创建使用短期 STS 环境变量的 OSS 存储适配器。 */
export function createOssutilStorage(options) {
  const runOssutil = options.runOssutil ?? runOssutilCommand
  const credentials = options.credentials
  const prefix = normalizePrefix(options.prefix)
  if (!credentials?.accessKeyId || !credentials.accessKeySecret || !credentials.securityToken) {
    throw new Error('short-lived Alibaba Cloud STS credentials are required')
  }
  const commandEnvironment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
  /** 为单次 ossutil 调用创建最小权限配置，并在调用结束后销毁。 */
  async function withOssutilConfig(run) {
    const directory = await mkdtemp(path.join(tmpdir(), 'dsh-ossutil-config-'))
    const configFile = path.join(directory, 'ossutilconfig')
    try {
      await chmod(directory, 0o700)
      await writeFile(configFile, [
        '[Credentials]',
        `endpoint=oss-${options.region}.aliyuncs.com`,
        `accessKeyID=${credentials.accessKeyId}`,
        `accessKeySecret=${credentials.accessKeySecret}`,
        `stsToken=${credentials.securityToken}`,
        ''
      ].join('\n'), { mode: 0o600 })
      await chmod(configFile, 0o600)
      return await run(configFile)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  /** 构造限定在已配置 bucket 内的 OSS URI。 */
  function objectUri(key) {
    if (key.startsWith('/') || key.split('/').some(segment => segment === '..')) throw new Error('unsafe OSS object key')
    if (!key.startsWith(`${prefix}/`)) throw new Error(`OSS object is outside the configured application prefix: ${key}`)
    return `oss://${options.bucket}/${key}`
  }
  /** 读取 OSS 对象的原始字节。 */
  async function readObject(key) {
    return withOssutilConfig(configFile => runOssutil(
      ['cat', objectUri(key), '--config-file', configFile],
      { env: commandEnvironment }
    )).then(result => Buffer.from(result.stdout))
  }
  /** 将内容写入临时文件后调用 ossutil cp。 */
  async function copyObject(key, body, metadata, allowOverwrite) {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-oss-promotion-'))
    const source = path.join(temporaryDirectory, 'object')
    try {
      await writeFile(source, body, { mode: 0o600 })
      const objectMetadata = [`Cache-Control:${metadata.cacheControl}`]
      if (metadata.contentType) objectMetadata.push(`Content-Type:${metadata.contentType}`)
      const args = ['cp', source, objectUri(key)]
      if (allowOverwrite) args.push('--force')
      args.push('--meta', objectMetadata.join('#'))
      await withOssutilConfig(configFile => runOssutil(
        [...args, '--config-file', configFile],
        { env: commandEnvironment }
      ))
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
  return {
    /** 确保 immutable 对象只写一次，并仅复用逐字节相同的已有对象。 */
    async ensureObject(key, body, metadata) {
      try {
        const existing = await readObject(key)
        if (!existing.equals(body)) throw new Error(`immutable OSS object already exists with different bytes: ${key}`)
        return 'reused'
      } catch (error) {
        if (!/NoSuchKey|StatusCode[=: ]+404|\b404\b|object does not exist|not found/i.test(String(error?.message ?? error))) throw error
      }
      await copyObject(key, body, metadata, false)
      return 'uploaded'
    },
    /** 覆盖 Stable manifest，并依赖 bucket versioning 保留历史版本。 */
    async replaceObject(key, body, metadata) { await copyObject(key, body, metadata, true) },
    readObject
  }
}

/** 从命令行参数中读取显式的 release promotion 字段。 */
function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid promotion argument: ${name ?? ''}`)
    values[name.slice(2)] = value
  }
  return values
}

/** 校验并读取 GitHub published Release event。 */
async function readPublishedRelease(eventPath, repository) {
  const event = JSON.parse(await readFile(eventPath, 'utf8'))
  if (event.action !== 'published' || event.release?.draft !== false) throw new Error('only a published GitHub Release can enter Stable')
  if (repository && event.repository?.full_name !== repository) throw new Error('GitHub Release repository does not match GITHUB_REPOSITORY')
  return event.release
}

/** 解析 CLI/environment，创建 OSS 适配器并执行 Stable promotion。 */
export async function runPromotionCli(environment = process.env, dependencies = {}, args = process.argv.slice(2)) {
  const credentials = {
    accessKeyId: environment.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: environment.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    securityToken: environment.ALIBABA_CLOUD_SECURITY_TOKEN
  }
  if (!credentials.accessKeyId || !credentials.accessKeySecret || !credentials.securityToken) {
    throw new Error('short-lived Alibaba Cloud STS credentials are required')
  }
  if (!environment.OSS_BUCKET || !environment.OSS_REGION || !environment.UPDATE_BASE_URL) {
    throw new Error('OSS_BUCKET, OSS_REGION, and UPDATE_BASE_URL are required')
  }
  if (!environment.TAURI_SIGNING_PUBLIC_KEY) throw new Error('TAURI_SIGNING_PUBLIC_KEY is required')
  const values = parseArguments(args)
  const prefix = values.prefix ?? 'dsh-desktop'
  const release = values.tag && values.notes && values['published-at']
    ? { tag_name: values.tag, body: values.notes, published_at: values['published-at'] }
    : await readPublishedRelease(environment.GITHUB_EVENT_PATH, environment.GITHUB_REPOSITORY)
  const createStorage = dependencies.createStorage ?? createOssutilStorage
  const promote = dependencies.promote ?? promoteStableRelease
  const verifySignature = dependencies.verifySignature
    ?? ((artifactPath, signaturePath) => verifyTauriSignature(
      artifactPath,
      signaturePath,
      environment.TAURI_SIGNING_PUBLIC_KEY,
      dependencies.runMinisign
    ))
  const storage = createStorage({ bucket: environment.OSS_BUCKET, region: environment.OSS_REGION, prefix, credentials })
  return promote({
    tag: release.tag_name,
    releaseBody: release.body,
    publishedAt: release.published_at,
    artifactsDirectory: values.assets ?? environment.PROMOTION_ARTIFACTS_DIR ?? 'artifacts',
    downloadOrigin: environment.UPDATE_BASE_URL,
    prefix
  }, storage, { verifySignature })
}

/** 构造完成密码学验证的四目标 manifest 与不可变发布对象。 */
async function buildReleaseBundle(options, dependencies) {
  const version = releaseVersion(options.tag)
  const prefix = normalizePrefix(options.prefix)
  const origin = new URL(options.downloadOrigin)
  if (origin.protocol !== 'https:') throw new Error('update download origin must use HTTPS')
  if (!String(options.releaseBody ?? '').trim()) throw new Error('GitHub Release body is required')
  const publishedAt = new Date(options.publishedAt)
  if (!options.publishedAt || Number.isNaN(publishedAt.valueOf())) throw new Error('published release timestamp is required')
  if (!dependencies.verifySignature) throw new Error('a Tauri signature verifier is required')
  const platforms = {}
  const objects = []
  const artifacts = []
  for (const target of TARGETS) {
    const artifact = await readTargetArtifact(options.artifactsDirectory, target)
    artifacts.push(artifact)
    const releasePrefix = `${prefix}/releases/${version}/${target}`
    const key = `${releasePrefix}/${contentAddressedName(artifact.filename, artifact.body)}`
    const signatureKey = `${releasePrefix}/${contentAddressedName(`${artifact.filename}.sig`, artifact.signatureBody)}`
    objects.push(
      { key, body: artifact.body, contentType: 'application/octet-stream' },
      { key: signatureKey, body: artifact.signatureBody, contentType: 'text/plain; charset=utf-8' }
    )
    platforms[target] = {
      url: new URL(key, `${origin.href.replace(/\/$/, '')}/`).href,
      signature: artifact.signature
    }
  }
  for (const artifact of artifacts) {
    await dependencies.verifySignature(artifact.artifactPath, artifact.signaturePath)
  }
  return {
    version,
    prefix,
    origin,
    objects,
    manifest: {
      version,
      notes: options.releaseBody,
      pub_date: options.publishedAt,
      platforms
    }
  }
}

/** 上传并远端复核一组不可变 OSS 对象。 */
async function publishImmutableObjects(objects, storage) {
  for (const object of objects) {
    await storage.ensureObject(object.key, object.body, {
      cacheControl: 'public, max-age=31536000, immutable',
      contentType: object.contentType
    })
  }
  for (const object of objects) {
    const remote = await storage.readObject(object.key)
    if (!remote.equals(object.body)) throw new Error(`remote OSS object differs from uploaded bytes: ${object.key}`)
  }
}

/** 准备供四个原生 smoke 使用的不可变 candidate，但不修改 Stable pointer。 */
export async function prepareStableCandidate(options, storage, dependencies = {}) {
  if (!/^[0-9a-f]{40}$/.test(options.candidateCommit ?? '')) {
    throw new Error('candidate commit must be a full lowercase Git commit SHA')
  }
  const prefix = normalizePrefix(options.prefix)
  let previousStable
  let previousStableBody
  try {
    previousStableBody = await storage.readObject(`${prefix}/channels/stable/latest.json`)
    previousStable = JSON.parse(previousStableBody.toString('utf8'))
  } catch {
    throw new Error('previous Stable manifest is required; bootstrap promotion is not allowed')
  }
  const previousVersion = releaseVersion(previousStable?.version)
  const bundle = await buildReleaseBundle(options, dependencies)
  if (previousVersion === bundle.version) throw new Error('candidate version must differ from previous Stable')
  await publishImmutableObjects(bundle.objects, storage)
  const manifestBody = Buffer.from(`${JSON.stringify(bundle.manifest, null, 2)}\n`)
  const manifestSha256 = createHash('sha256').update(manifestBody).digest('hex')
  const manifestKey = `${bundle.prefix}/candidates/${bundle.version}/${options.candidateCommit}/${manifestSha256}-latest.json`
  await publishImmutableObjects([{
    key: manifestKey,
    body: manifestBody,
    contentType: 'application/json; charset=utf-8'
  }], storage)
  return {
    schema_version: 1,
    candidate_tag: options.tag,
    candidate_commit: options.candidateCommit,
    previous_stable_tag: `v${previousVersion}`,
    previous_stable_version: previousVersion,
    previous_stable_url: new URL(`${prefix}/channels/stable/latest.json`, `${bundle.origin.href.replace(/\/$/, '')}/`).href,
    previous_stable_manifest_sha256: createHash('sha256').update(previousStableBody).digest('hex'),
    manifest_url: new URL(manifestKey, `${bundle.origin.href.replace(/\/$/, '')}/`).href,
    manifest_sha256: manifestSha256,
    manifest: bundle.manifest
  }
}

/** 复核不可变 candidate 身份并将其原样写为 Stable 的最终 pointer。 */
export async function finalizeStableCandidate(candidate, storage, options = {}) {
  if (candidate?.schema_version !== 1) throw new Error('unsupported candidate schema version')
  if (!/^[0-9a-f]{40}$/.test(candidate.candidate_commit ?? '')) throw new Error('candidate commit is invalid')
  if (!/^[0-9a-f]{64}$/.test(candidate.manifest_sha256 ?? '')) throw new Error('candidate manifest digest is invalid')
  const version = releaseVersion(candidate.candidate_tag)
  if (candidate.manifest?.version !== version) throw new Error('candidate tag and manifest version mismatch')
  if (JSON.stringify(Object.keys(candidate.manifest?.platforms ?? {})) !== JSON.stringify(TARGETS)) {
    throw new Error('candidate must contain exactly the four canonical targets')
  }
  const prefix = normalizePrefix(options.prefix ?? 'dsh-desktop')
  if (!/^[0-9a-f]{64}$/.test(candidate.previous_stable_manifest_sha256 ?? '')) {
    throw new Error('previous Stable manifest digest is invalid')
  }
  const stableKey = `${prefix}/channels/stable/latest.json`
  const stableUrl = new URL(candidate.previous_stable_url)
  if (stableUrl.protocol !== 'https:' || !stableUrl.pathname.endsWith(`/${stableKey}`)) {
    throw new Error('previous Stable URL does not match the authoritative pointer')
  }
  const currentStable = await storage.readObject(stableKey)
  if (createHash('sha256').update(currentStable).digest('hex') !== candidate.previous_stable_manifest_sha256) {
    throw new Error('previous Stable manifest changed after candidate preparation')
  }
  const manifestUrl = new URL(candidate.manifest_url)
  if (manifestUrl.protocol !== 'https:') throw new Error('candidate manifest URL must use HTTPS')
  const expectedSuffix = `/${prefix}/candidates/${version}/${candidate.candidate_commit}/${candidate.manifest_sha256}-latest.json`
  if (!manifestUrl.pathname.endsWith(expectedSuffix)) throw new Error('candidate manifest URL does not match its identity')
  const manifestKey = manifestUrl.pathname.slice(1)
  const remoteManifest = await storage.readObject(manifestKey)
  const remoteDigest = createHash('sha256').update(remoteManifest).digest('hex')
  if (remoteDigest !== candidate.manifest_sha256) throw new Error('candidate manifest digest mismatch')
  const expectedManifest = Buffer.from(`${JSON.stringify(candidate.manifest, null, 2)}\n`)
  if (!remoteManifest.equals(expectedManifest)) throw new Error('candidate manifest bytes do not match candidate metadata')
  await storage.replaceObject(
    stableKey,
    remoteManifest,
    { cacheControl: 'no-cache', contentType: 'application/json; charset=utf-8' }
  )
  return candidate.manifest
}

/** 从 production 环境创建限定应用前缀的短期 OSS storage。 */
function createProductionStorage(environment, dependencies, prefix) {
  const credentials = {
    accessKeyId: environment.ALIBABA_CLOUD_ACCESS_KEY_ID,
    accessKeySecret: environment.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    securityToken: environment.ALIBABA_CLOUD_SECURITY_TOKEN
  }
  if (!credentials.accessKeyId || !credentials.accessKeySecret || !credentials.securityToken) {
    throw new Error('short-lived Alibaba Cloud STS credentials are required')
  }
  if (!environment.OSS_BUCKET || !environment.OSS_REGION || !environment.UPDATE_BASE_URL) {
    throw new Error('OSS_BUCKET, OSS_REGION, and UPDATE_BASE_URL are required')
  }
  return (dependencies.createStorage ?? createOssutilStorage)({
    bucket: environment.OSS_BUCKET,
    region: environment.OSS_REGION,
    prefix,
    credentials
  })
}

/** 解析 candidate preparation CLI，并把不可变 candidate identity 写到指定文件。 */
export async function runCandidatePreparationCli(environment = process.env, dependencies = {}, args = process.argv.slice(2)) {
  const values = parseArguments(args)
  const prefix = values.prefix ?? 'dsh-desktop'
  if (!values.output) throw new Error('--output is required for candidate preparation')
  if (!environment.TAURI_SIGNING_PUBLIC_KEY) throw new Error('TAURI_SIGNING_PUBLIC_KEY is required')
  const storage = createProductionStorage(environment, dependencies, prefix)
  const prepare = dependencies.prepare ?? prepareStableCandidate
  const candidate = await prepare({
    tag: values.tag,
    releaseBody: values.notes,
    publishedAt: values['published-at'],
    candidateCommit: values['candidate-commit'],
    artifactsDirectory: values.assets ?? 'artifacts',
    downloadOrigin: environment.UPDATE_BASE_URL,
    prefix
  }, storage, {
    verifySignature: dependencies.verifySignature
      ?? ((artifactPath, signaturePath) => verifyTauriSignature(
        artifactPath,
        signaturePath,
        environment.TAURI_SIGNING_PUBLIC_KEY,
        dependencies.runMinisign
      ))
  })
  await writeFile(values.output, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 })
  return candidate
}

/** 解析 final promotion CLI，并只从已验证 candidate 写入 Stable pointer。 */
export async function runCandidateFinalizationCli(environment = process.env, dependencies = {}, args = process.argv.slice(2)) {
  const values = parseArguments(args)
  const prefix = values.prefix ?? 'dsh-desktop'
  if (!values.candidate) throw new Error('--candidate is required for final promotion')
  const candidate = JSON.parse(await readFile(values.candidate, 'utf8'))
  const storage = createProductionStorage(environment, dependencies, prefix)
  return (dependencies.finalize ?? finalizeStableCandidate)(candidate, storage, { prefix })
}

/** 提升一个完整的四目标更新发布，并返回写入 Stable channel 的 manifest。 */
export async function promoteStableRelease(options, storage, dependencies = {}) {
  const bundle = await buildReleaseBundle(options, dependencies)
  await publishImmutableObjects(bundle.objects, storage)
  await storage.replaceObject(
    `${bundle.prefix}/channels/stable/latest.json`,
    Buffer.from(`${JSON.stringify(bundle.manifest, null, 2)}\n`),
    { cacheControl: 'no-cache', contentType: 'application/json; charset=utf-8' }
  )
  return bundle.manifest
}

/** 运行发布器 CLI，日志仅包含公开版本信息。 */
async function main() {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === '--prepare-candidate') {
    const candidate = await runCandidatePreparationCli(process.env, {}, args)
    console.log(`Prepared Desktop ${candidate.candidate_tag} candidate`)
    return
  }
  if (mode === '--finalize-candidate') {
    const manifest = await runCandidateFinalizationCli(process.env, {}, args)
    console.log(`Promoted Desktop ${manifest.version} to Stable`)
    return
  }
  throw new Error('an explicit --prepare-candidate or --finalize-candidate mode is required')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
