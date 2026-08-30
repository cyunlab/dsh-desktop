import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  const request = options.fetch ?? globalThis.fetch
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
  /** 使用 OSS Signature V1 和现有 STS 凭据执行不经 shell 的对象请求。 */
  async function signedObjectRequest(method, key, body = Buffer.alloc(0), query = '') {
    objectUri(key)
    const date = (options.now?.() ?? new Date()).toUTCString()
    const contentType = body.length > 0 ? 'application/json; charset=utf-8' : ''
    const canonicalQuery = query ? `?${query}` : ''
    const canonicalResource = `/${options.bucket}/${key}${canonicalQuery}`
    const canonicalHeaders = `x-oss-security-token:${credentials.securityToken}\n`
    const stringToSign = `${method}\n\n${contentType}\n${date}\n${canonicalHeaders}${canonicalResource}`
    const signature = createHmac('sha1', credentials.accessKeySecret).update(stringToSign).digest('base64')
    const encodedKey = key.split('/').map(encodeURIComponent).join('/')
    return request(`https://${options.bucket}.oss-${options.region}.aliyuncs.com/${encodedKey}${canonicalQuery}`, {
      method,
      body: body.length > 0 ? body : undefined,
      headers: {
        ...(contentType ? { 'Content-Type': contentType } : {}),
        Date: date,
        'x-oss-security-token': credentials.securityToken,
        Authorization: `OSS ${credentials.accessKeyId}:${signature}`
      }
    })
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
    /** 列出应用前缀下的对象键，用于检测一次性 bootstrap 的任何部分记录。 */
    async listObjects(keyPrefix) {
      const result = await withOssutilConfig(configFile => runOssutil(
        ['ls', objectUri(keyPrefix), '--config-file', configFile],
        { env: commandEnvironment }
      ))
      const bucketPrefix = `oss://${options.bucket}/`
      return result.stdout.toString('utf8').split(/\r?\n/)
        .flatMap(line => line.split(/\s+/))
        .filter(value => value.startsWith(bucketPrefix))
        .map(value => value.slice(bucketPrefix.length))
        .filter(key => key.startsWith(keyPrefix))
        .sort()
    },
    /** 以 AppendObject position=0 原子获取全局 promotion lock；竞争者由 OSS 拒绝。 */
    async acquirePromotionLock(key, ownerBody) {
      const response = await signedObjectRequest('POST', key, ownerBody, 'append&position=0')
      if (response.status === 409 || response.status === 412) throw new Error('promotion lock acquisition conflict')
      if (!response.ok) throw new Error(`promotion lock acquisition failed with OSS status ${response.status}`)
      const remote = await readObject(key)
      if (!remote.equals(ownerBody)) throw new Error('promotion lock owner bytes differ after acquisition')
    },
    /** 仅在远端 owner bytes 仍匹配时释放 promotion lock；异常路径不调用。 */
    async releasePromotionLock(key, ownerBody) {
      const remote = await readObject(key)
      if (!remote.equals(ownerBody)) throw new Error('promotion lock ownership changed')
      const response = await signedObjectRequest('DELETE', key)
      if (!response.ok) throw new Error(`promotion lock release failed with OSS status ${response.status}`)
    },
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

/** 构造绑定 run、candidate 与最终观测 Stable identity 的全局 promotion lock。 */
function createPromotionLock(prefix, mode, candidate, stableDigest, lockOwner) {
  if (!String(lockOwner ?? '').trim()) throw new Error('a unique promotion lock owner is required')
  const key = `${prefix}/channels/stable/promotion.lock`
  const body = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    owner: lockOwner,
    mode,
    candidate_tag: candidate.candidate_tag,
    candidate_commit: candidate.candidate_commit,
    candidate_manifest_sha256: candidate.manifest_sha256,
    observed_stable_manifest_sha256: stableDigest
  }, null, 2)}\n`)
  return { key, body }
}

/** 要求 storage 提供 OSS 服务端原子锁，而不允许退回 read-then-write。 */
function requirePromotionLockStorage(storage) {
  if (typeof storage.acquirePromotionLock !== 'function' || typeof storage.releasePromotionLock !== 'function') {
    throw new Error('OSS atomic promotion lock support is required')
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
  requirePromotionLockStorage(storage)
  const promotionLock = createPromotionLock(
    prefix,
    'normal-stable-promotion',
    candidate,
    candidate.previous_stable_manifest_sha256,
    options.lockOwner
  )
  await storage.acquirePromotionLock(promotionLock.key, promotionLock.body)
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
  const promotedStable = await storage.readObject(stableKey)
  if (!promotedStable.equals(remoteManifest)) throw new Error('Stable manifest differs after promotion write')
  await storage.releasePromotionLock(promotionLock.key, promotionLock.body)
  return candidate.manifest
}

/** 要求一次性 bootstrap 的审批身份完整、规范且互相一致。 */
function validateBootstrapApproval(options) {
  const version = releaseVersion(options.approvedTag)
  if (version !== options.approvedVersion) throw new Error('approved tag and version must identify the same semantic version')
  const legacyVersion = releaseVersion(options.approvedLegacyVersion)
  if (legacyVersion === version) throw new Error('approved legacy Stable must differ from the candidate version')
  if (!/^[0-9a-f]{40}$/.test(options.approvedCommit ?? '')) {
    throw new Error('approved commit must be a full lowercase Git commit SHA')
  }
  if (!/^[0-9a-f]{64}$/.test(options.approvedLegacyManifestSha256 ?? '')) {
    throw new Error('approved legacy Stable manifest digest must be a lowercase SHA-256')
  }
  return version
}

/** 要求持久化 candidate 与 protected bootstrap approval 逐字一致。 */
function requireBootstrapCandidateApproval(candidate, options) {
  const version = validateBootstrapApproval(options)
  if (
    candidate?.candidate_tag !== options.approvedTag ||
    candidate?.candidate_version !== version ||
    candidate?.candidate_commit !== options.approvedCommit ||
    candidate?.legacy_stable_version !== options.approvedLegacyVersion ||
    candidate?.legacy_stable_manifest_sha256 !== options.approvedLegacyManifestSha256
  ) throw new Error('bootstrap candidate does not match the approved identity')
}

/** 读取并验证 bootstrap 显式审批的 legacy Stable pointer。 */
async function readLegacyStable(storage, prefix, approvedLegacyVersion) {
  const stableKey = `${prefix}/channels/stable/latest.json`
  let body
  let manifest
  try {
    body = await storage.readObject(stableKey)
    manifest = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('approved legacy Stable manifest is required')
  }
  const version = releaseVersion(manifest?.version)
  if (version !== approvedLegacyVersion) throw new Error('legacy Stable version does not match the approved version')
  return { stableKey, body, version, digest: createHash('sha256').update(body).digest('hex') }
}

/** 拒绝 receipt 前缀下的任何完整或部分 bootstrap 审计记录。 */
async function requireBootstrapReceiptAbsent(storage, prefix) {
  if (typeof storage.listObjects !== 'function') throw new Error('bootstrap promotion requires receipt-prefix listing support')
  const receiptPrefix = `${prefix}/bootstrap/receipts/`
  const receipts = await storage.listObjects(receiptPrefix)
  if (receipts.length !== 0) throw new Error(`bootstrap receipt already exists: ${receipts[0]}`)
  return receiptPrefix
}

/** receipt 写入后要求前缀内恰好只有预期的完整不可变记录。 */
async function requireExactBootstrapReceipt(storage, prefix, receiptKey) {
  if (typeof storage.listObjects !== 'function') throw new Error('bootstrap promotion requires receipt-prefix listing support')
  const receipts = await storage.listObjects(`${prefix}/bootstrap/receipts/`)
  if (receipts.length !== 1 || receipts[0] !== receiptKey) throw new Error('bootstrap receipt set changed after receipt write')
}

/** 计算 evidence 目录所有文件名与原始字节的确定性集合摘要。 */
async function digestEvidenceDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.some(entry => !entry.isFile())) throw new Error('bootstrap evidence directory may contain files only')
  const hash = createHash('sha256')
  for (const name of entries.map(entry => entry.name).sort()) {
    const file = path.join(directory, name)
    const information = await stat(file)
    if (information.size <= 0 || information.size > 128 * 1024) throw new Error(`bootstrap evidence file size is out of bounds: ${name}`)
    const body = await readFile(file)
    hash.update(Buffer.from(`${name}\0${body.length}\0`))
    hash.update(body)
  }
  return hash.digest('hex')
}

/** 验证远端 bootstrap candidate 与审批身份，并返回逐字节 manifest。 */
async function readBootstrapCandidateManifest(candidate, storage, prefix) {
  if (candidate?.schema_version !== 1 || candidate.bootstrap_kind !== 'first-updater-stable') {
    throw new Error('unsupported bootstrap candidate')
  }
  const version = releaseVersion(candidate.candidate_tag)
  if (candidate.candidate_version !== version || candidate.manifest?.version !== version) {
    throw new Error('bootstrap candidate tag, version, and manifest mismatch')
  }
  if (!/^[0-9a-f]{40}$/.test(candidate.candidate_commit ?? '')) throw new Error('bootstrap candidate commit is invalid')
  if (!/^[0-9a-f]{64}$/.test(candidate.manifest_sha256 ?? '')) throw new Error('bootstrap candidate manifest digest is invalid')
  if (JSON.stringify(Object.keys(candidate.manifest?.platforms ?? {})) !== JSON.stringify(TARGETS)) {
    throw new Error('bootstrap candidate must contain exactly the four canonical targets')
  }
  const manifestUrl = new URL(candidate.manifest_url)
  if (manifestUrl.protocol !== 'https:' || manifestUrl.username || manifestUrl.password || manifestUrl.search || manifestUrl.hash) {
    throw new Error('bootstrap candidate manifest URL must be an uncredentialed HTTPS URL')
  }
  const suffix = `/${prefix}/candidates/${version}/${candidate.candidate_commit}/${candidate.manifest_sha256}-latest.json`
  if (!manifestUrl.pathname.endsWith(suffix)) throw new Error('bootstrap candidate manifest URL does not match its identity')
  const manifestKey = manifestUrl.pathname.slice(1)
  const remote = await storage.readObject(manifestKey)
  if (createHash('sha256').update(remote).digest('hex') !== candidate.manifest_sha256) {
    throw new Error('bootstrap candidate manifest digest mismatch')
  }
  const expected = Buffer.from(`${JSON.stringify(candidate.manifest, null, 2)}\n`)
  if (!remote.equals(expected)) throw new Error('bootstrap candidate manifest bytes do not match candidate metadata')
  return { manifestKey, body: remote }
}

/** 准备一次性首个 updater Stable candidate，且不修改 Stable 或创建 receipt。 */
export async function prepareBootstrapStableCandidate(options, storage, dependencies = {}) {
  const version = validateBootstrapApproval(options)
  const prefix = normalizePrefix(options.prefix ?? 'dsh-desktop')
  const legacy = await readLegacyStable(storage, prefix, options.approvedLegacyVersion)
  if (legacy.digest !== options.approvedLegacyManifestSha256) {
    throw new Error('approved legacy Stable manifest digest does not match authoritative OSS Stable')
  }
  await requireBootstrapReceiptAbsent(storage, prefix)
  const prepareCandidate = dependencies.prepareCandidate ?? prepareStableCandidate
  const prepared = await prepareCandidate({
    tag: options.approvedTag,
    releaseBody: options.releaseBody,
    publishedAt: options.publishedAt,
    candidateCommit: options.approvedCommit,
    artifactsDirectory: options.artifactsDirectory,
    downloadOrigin: options.downloadOrigin,
    prefix
  }, storage, { verifySignature: dependencies.verifySignature })
  if (prepared.candidate_tag !== options.approvedTag || prepared.candidate_commit !== options.approvedCommit || prepared.manifest?.version !== version) {
    throw new Error('prepared candidate does not match the explicitly approved identity')
  }
  if (prepared.previous_stable_version !== undefined && prepared.previous_stable_version !== legacy.version) {
    throw new Error('prepared candidate predecessor does not match the approved legacy Stable')
  }
  if (prepared.previous_stable_manifest_sha256 !== undefined && prepared.previous_stable_manifest_sha256 !== legacy.digest) {
    throw new Error('legacy Stable changed during bootstrap candidate preparation')
  }
  const currentLegacy = await readLegacyStable(storage, prefix, legacy.version)
  if (!currentLegacy.body.equals(legacy.body)) throw new Error('legacy Stable changed during bootstrap candidate preparation')
  await requireBootstrapReceiptAbsent(storage, prefix)
  return {
    schema_version: 1,
    bootstrap_kind: 'first-updater-stable',
    candidate_tag: options.approvedTag,
    candidate_version: version,
    candidate_commit: options.approvedCommit,
    legacy_stable_version: legacy.version,
    legacy_stable_manifest_sha256: legacy.digest,
    manifest_url: prepared.manifest_url,
    manifest_sha256: prepared.manifest_sha256,
    manifest: prepared.manifest
  }
}

/** 复核一次性 evidence 并以 receipt-first、Stable-last 顺序完成 bootstrap。 */
export async function finalizeBootstrapStableCandidate(candidate, storage, options, dependencies = {}) {
  const prefix = normalizePrefix(options?.prefix ?? 'dsh-desktop')
  if (options.approvedTag !== undefined) requireBootstrapCandidateApproval(candidate, options)
  if (!options?.evidenceDirectory) throw new Error('bootstrap evidence directory is required')
  if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours <= 0) throw new Error('a positive bootstrap evidence max age is required')
  const legacy = await readLegacyStable(storage, prefix, candidate.legacy_stable_version)
  if (candidate.legacy_stable_manifest_sha256 !== legacy.digest) {
    throw new Error('legacy Stable changed after bootstrap candidate preparation')
  }
  await requireBootstrapReceiptAbsent(storage, prefix)
  const remoteCandidate = await readBootstrapCandidateManifest(candidate, storage, prefix)
  const verifyEvidence = dependencies.verifyEvidence ?? (await import('./verify-bootstrap-update-evidence.mjs')).verifyBootstrapUpdateEvidenceDirectory
  const evidenceDigestBefore = await digestEvidenceDirectory(options.evidenceDirectory)
  await verifyEvidence(options.evidenceDirectory, {
    tag: candidate.candidate_tag,
    version: candidate.candidate_version,
    commit: candidate.candidate_commit,
    manifest_sha256: candidate.manifest_sha256,
    maxAgeHours: options.maxAgeHours,
    now: options.now,
    requireRealBootstrap: true
  })
  const evidenceDigest = await digestEvidenceDirectory(options.evidenceDirectory)
  if (evidenceDigest !== evidenceDigestBefore) throw new Error('bootstrap evidence changed during verification')

  const receipt = {
    schema_version: 1,
    kind: 'first-updater-stable-bootstrap',
    candidate_tag: candidate.candidate_tag,
    candidate_version: candidate.candidate_version,
    candidate_commit: candidate.candidate_commit,
    candidate_manifest_url: candidate.manifest_url,
    candidate_manifest_sha256: candidate.manifest_sha256,
    legacy_stable_version: legacy.version,
    legacy_stable_manifest_sha256: legacy.digest,
    bootstrap_evidence_sha256: evidenceDigest,
    evidence_kind: 'bootstrap-fresh-install',
    claims_previous_stable_upgrade: false
  }
  const receiptBody = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)
  const receiptSha256 = createHash('sha256').update(receiptBody).digest('hex')
  const receiptKey = `${prefix}/bootstrap/receipts/${receiptSha256}-first-updater-stable.json`

  // lock 后 receipt 是第一次 release-content mutation；此前再次读取全部 admission 状态并拒绝漂移。
  requirePromotionLockStorage(storage)
  const promotionLock = createPromotionLock(
    prefix,
    'first-updater-bootstrap',
    candidate,
    legacy.digest,
    options.lockOwner
  )
  await storage.acquirePromotionLock(promotionLock.key, promotionLock.body)
  const finalLegacy = await readLegacyStable(storage, prefix, legacy.version)
  if (!finalLegacy.body.equals(legacy.body)) throw new Error('legacy Stable changed before bootstrap receipt write')
  await requireBootstrapReceiptAbsent(storage, prefix)
  const finalCandidate = await readBootstrapCandidateManifest(candidate, storage, prefix)
  if (!finalCandidate.body.equals(remoteCandidate.body)) throw new Error('bootstrap candidate changed before receipt write')
  if (await digestEvidenceDirectory(options.evidenceDirectory) !== evidenceDigest) throw new Error('bootstrap evidence changed before receipt write')
  await storage.ensureObject(receiptKey, receiptBody, {
    cacheControl: 'public, max-age=31536000, immutable',
    contentType: 'application/json; charset=utf-8'
  })
  const remoteReceipt = await storage.readObject(receiptKey)
  if (!remoteReceipt.equals(receiptBody)) throw new Error('remote bootstrap receipt differs from expected bytes')
  await requireExactBootstrapReceipt(storage, prefix, receiptKey)

  // Stable 是最后一次 OSS mutation；receipt 后若发生漂移则保留部分记录并禁止重试。
  const stableBeforeWrite = await readLegacyStable(storage, prefix, legacy.version)
  if (!stableBeforeWrite.body.equals(legacy.body)) throw new Error('legacy Stable changed after bootstrap receipt write')
  const candidateBeforeWrite = await readBootstrapCandidateManifest(candidate, storage, prefix)
  if (!candidateBeforeWrite.body.equals(remoteCandidate.body)) throw new Error('bootstrap candidate changed after receipt write')
  if (await digestEvidenceDirectory(options.evidenceDirectory) !== evidenceDigest) throw new Error('bootstrap evidence changed after receipt write')
  if (!(await storage.readObject(receiptKey)).equals(receiptBody)) throw new Error('bootstrap receipt changed before Stable write')
  await requireExactBootstrapReceipt(storage, prefix, receiptKey)
  await storage.replaceObject(legacy.stableKey, remoteCandidate.body, {
    cacheControl: 'no-cache',
    contentType: 'application/json; charset=utf-8'
  })
  const promotedStable = await storage.readObject(legacy.stableKey)
  if (!promotedStable.equals(remoteCandidate.body)) throw new Error('Stable manifest differs after bootstrap write')
  await storage.releasePromotionLock(promotionLock.key, promotionLock.body)
  return { manifest: candidate.manifest, receipt_key: receiptKey, receipt_sha256: receiptSha256 }
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
  return (dependencies.finalize ?? finalizeStableCandidate)(candidate, storage, {
    prefix,
    lockOwner: `${environment.GITHUB_RUN_ID ?? 'local'}:${environment.GITHUB_RUN_ATTEMPT ?? '0'}:${candidate.candidate_commit}`
  })
}

/** 解析一次性 bootstrap preparation CLI 并持久化不可变 candidate identity。 */
export async function runBootstrapPreparationCli(environment = process.env, dependencies = {}, args = process.argv.slice(2)) {
  const values = parseArguments(args)
  const prefix = values.prefix ?? 'dsh-desktop'
  if (!values.output) throw new Error('--output is required for bootstrap preparation')
  if (!environment.TAURI_SIGNING_PUBLIC_KEY) throw new Error('TAURI_SIGNING_PUBLIC_KEY is required')
  const storage = createProductionStorage(environment, dependencies, prefix)
  const candidate = await (dependencies.prepareBootstrap ?? prepareBootstrapStableCandidate)({
    approvedTag: values['approved-tag'],
    approvedVersion: values['approved-version'],
    approvedCommit: values['approved-commit'],
    approvedLegacyVersion: values['approved-legacy-version'],
    approvedLegacyManifestSha256: values['approved-legacy-manifest-sha256'],
    releaseBody: values.notes,
    publishedAt: values['published-at'],
    artifactsDirectory: values.assets ?? 'artifacts',
    downloadOrigin: environment.UPDATE_BASE_URL,
    prefix
  }, storage, {
    prepareCandidate: dependencies.prepareCandidate,
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

/** 解析一次性 bootstrap finalization CLI 并从真实四目标 evidence 完成 receipt-first promotion。 */
export async function runBootstrapFinalizationCli(environment = process.env, dependencies = {}, args = process.argv.slice(2)) {
  const values = parseArguments(args)
  const prefix = values.prefix ?? 'dsh-desktop'
  if (!values.candidate) throw new Error('--candidate is required for bootstrap finalization')
  if (!values.evidence) throw new Error('--evidence is required for bootstrap finalization')
  if (!values['max-age-hours']) throw new Error('--max-age-hours is required for bootstrap finalization')
  const candidate = JSON.parse(await readFile(values.candidate, 'utf8'))
  const approval = {
    approvedTag: values['approved-tag'],
    approvedVersion: values['approved-version'],
    approvedCommit: values['approved-commit'],
    approvedLegacyVersion: values['approved-legacy-version'],
    approvedLegacyManifestSha256: values['approved-legacy-manifest-sha256']
  }
  requireBootstrapCandidateApproval(candidate, approval)
  const storage = createProductionStorage(environment, dependencies, prefix)
  return (dependencies.finalizeBootstrap ?? finalizeBootstrapStableCandidate)(candidate, storage, {
    prefix,
    evidenceDirectory: values.evidence,
    maxAgeHours: Number(values['max-age-hours']),
    lockOwner: `${environment.GITHUB_RUN_ID ?? 'local'}:${environment.GITHUB_RUN_ATTEMPT ?? '0'}:${candidate.candidate_commit}`,
    ...approval
  }, { verifyEvidence: dependencies.verifyEvidence })
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
  if (mode === '--prepare-bootstrap') {
    const candidate = await runBootstrapPreparationCli(process.env, {}, args)
    console.log(`Prepared one-time Desktop ${candidate.candidate_tag} bootstrap candidate`)
    return
  }
  if (mode === '--finalize-bootstrap') {
    const result = await runBootstrapFinalizationCli(process.env, {}, args)
    console.log(`Bootstrapped Desktop ${result.manifest.version} to Stable with receipt ${result.receipt_sha256}`)
    return
  }
  throw new Error('an explicit candidate or bootstrap preparation/finalization mode is required')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
