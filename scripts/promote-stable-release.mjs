import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
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

/** 校验 Stable manifest 中每个平台的人工安装地址仍位于同一 OSS 发布边界。 */
function assertInstallerUrls(manifest, prefix, stableUrl) {
  for (const target of TARGETS) {
    const entry = manifest.platforms[target]
    let updaterUrl
    let installerUrl
    try {
      updaterUrl = new URL(entry?.url)
      installerUrl = new URL(entry?.installer_url)
    } catch {
      throw new Error(`candidate installer URL is invalid for ${target}`)
    }
    const expectedPrefix = `/${prefix}/releases/${manifest.version}/${target}/`
    if (
      updaterUrl.protocol !== 'https:' || installerUrl.protocol !== 'https:' ||
      updaterUrl.origin !== stableUrl.origin || installerUrl.origin !== stableUrl.origin ||
      !updaterUrl.pathname.startsWith(expectedPrefix) || !installerUrl.pathname.startsWith(expectedPrefix)
    ) throw new Error(`candidate installer URL leaves the trusted release prefix for ${target}`)
    if (target.startsWith('darwin-')) {
      if (!installerUrl.pathname.endsWith('.dmg')) throw new Error(`candidate macOS installer must be a DMG for ${target}`)
    } else if (installerUrl.href !== updaterUrl.href) {
      throw new Error(`candidate installer must reuse the updater package for ${target}`)
    }
  }
}

/** 定位某个目标唯一的更新包、字面签名以及 macOS 安装镜像。 */
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
  let installer
  if (target.startsWith('darwin-')) {
    const installerName = `dsh-desktop-${target}-installer.dmg`
    const installers = names.filter(name => name === installerName)
    if (installers.length !== 1) throw new Error(`expected exactly one installer package for ${target}`)
    const installerBody = await readFile(path.join(targetDirectory, installerName))
    if (installerBody.length < 512 || installerBody.subarray(-512, -508).toString('ascii') !== 'koly') {
      throw new Error(`invalid macOS installer image for ${target}`)
    }
    installer = { filename: installerName, body: installerBody }
  }
  return {
    filename,
    artifactPath: path.join(targetDirectory, filename),
    signaturePath: path.join(targetDirectory, signatureName),
    body,
    signature,
    signatureBody,
    installer
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

/** 从 Tauri 外层 base64 配置中提取 minisign `-P` 接受的公钥 packet。 */
function minisignPublicKeyPacket(value) {
  const encoded = String(value ?? '').trim()
  let decoded = ''
  try { decoded = Buffer.from(encoded, 'base64').toString('utf8').replaceAll('\r\n', '\n').trim() } catch {}
  const match = /^untrusted comment: minisign public key: [0-9A-F]+\n(RW[A-Za-z0-9+/=]+)$/.exec(decoded)
  const packet = match ? Buffer.from(match[1], 'base64') : Buffer.alloc(0)
  const canonical = encoded.replace(/=+$/, '')
  const roundTrip = decoded ? Buffer.from(decoded).toString('base64').replace(/=+$/, '') : ''
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || roundTrip !== canonical
    || packet.length !== 42
    || !['Ed', 'ED'].includes(packet.subarray(0, 2).toString('ascii'))) {
    throw new Error('TAURI_SIGNING_PUBLIC_KEY must contain the base64-encoded two-line minisign public key file')
  }
  return match[1]
}

/** 解码并校验 Tauri 外层 base64 包装的四行 minisign 签名文件。 */
async function decodedMinisignSignature(signaturePath) {
  const encoded = (await readFile(signaturePath, 'utf8')).trim()
  const body = Buffer.from(encoded, 'base64')
  const roundTrip = body.toString('base64').replace(/=+$/, '')
  const normalized = body.toString('utf8').replaceAll('\r\n', '\n').trim()
  const lines = normalized.split('\n')
  const signaturePacket = Buffer.from(lines[1] ?? '', 'base64')
  const globalSignature = Buffer.from(lines[3] ?? '', 'base64')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || roundTrip !== encoded.replace(/=+$/, '')
    || lines.length !== 4
    || !lines[0].startsWith('untrusted comment: ')
    || !lines[2].startsWith('trusted comment: ')
    || signaturePacket.length !== 74
    || globalSignature.length !== 64
    || !['Ed', 'ED'].includes(signaturePacket.subarray(0, 2).toString('ascii'))) {
    throw new Error('Tauri updater signature must contain the base64-encoded four-line minisign signature file')
  }
  return `${normalized}\n`
}

/** 使用嵌入发布环境的公钥验证单个 Tauri updater 签名。 */
export async function verifyTauriSignature(artifactPath, signaturePath, publicKey, runMinisign = runMinisignCommand) {
  const publicKeyPacket = minisignPublicKeyPacket(publicKey)
  const signature = await decodedMinisignSignature(signaturePath)
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-minisign-'))
  const decodedSignaturePath = path.join(temporaryDirectory, 'signature.minisig')
  try {
    await chmod(temporaryDirectory, 0o700)
    await writeFile(decodedSignaturePath, signature, { mode: 0o600 })
    await chmod(decodedSignaturePath, 0o600)
    await runMinisign(
      ['-Vm', artifactPath, '-x', decodedSignaturePath, '-P', publicKeyPacket],
      { shell: false, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }
    )
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

const OSSUTIL_OUTPUT_BOUND = 128 * 1024

/** 以无 shell子进程运行 ossutil，并有界保留 stdout/stderr 的真实失败诊断。 */
export function runOssutilCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable ?? 'ossutil', args, {
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let outputExceeded = false
    /** 累计单个输出块，并在合计超过证据上限时终止子进程。 */
    function capture(target, chunk) {
      outputBytes += chunk.length
      if (outputBytes > OSSUTIL_OUTPUT_BOUND) {
        outputExceeded = true
        child.kill()
      } else {
        target.push(chunk)
      }
    }
    child.stdout.on('data', chunk => capture(stdout, chunk))
    child.stderr.on('data', chunk => capture(stderr, chunk))
    child.once('error', reject)
    child.once('exit', code => {
      const stdoutBody = Buffer.concat(stdout)
      const stderrBody = Buffer.concat(stderr).toString('utf8')
      if (outputExceeded) reject(new Error('ossutil output exceeded the diagnostic bound'))
      else if (code !== 0) {
        const diagnostic = [stderrBody.trim(), stdoutBody.toString('utf8').trim()].filter(Boolean).join('\n').slice(0, 4096)
        reject(new Error(`ossutil exited ${code}: ${diagnostic}`))
      } else resolve({ stdout: stdoutBody, stderr: stderrBody })
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
  /** 下载 OSS 对象到隔离临时文件，避免 ossutil 的 stdout 计时文本污染对象字节。 */
  async function readObject(key) {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-oss-read-'))
    const destination = path.join(temporaryDirectory, 'object')
    try {
      await chmod(temporaryDirectory, 0o700)
      await withOssutilConfig(configFile => runOssutil(
        ['cp', objectUri(key), destination, '--force', '--config-file', configFile],
        { env: commandEnvironment }
      ))
      await chmod(destination, 0o600)
      return await readFile(destination)
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
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
    let installerUrl = new URL(key, `${origin.href.replace(/\/$/, '')}/`).href
    if (artifact.installer) {
      const installerKey = `${releasePrefix}/${contentAddressedName(artifact.installer.filename, artifact.installer.body)}`
      objects.push({ key: installerKey, body: artifact.installer.body, contentType: 'application/x-apple-diskimage' })
      installerUrl = new URL(installerKey, `${origin.href.replace(/\/$/, '')}/`).href
    }
    platforms[target] = {
      url: new URL(key, `${origin.href.replace(/\/$/, '')}/`).href,
      installer_url: installerUrl,
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
    throw new Error('previous Stable manifest is required')
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
  assertInstallerUrls(candidate.manifest, prefix, stableUrl)
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
  throw new Error("an explicit candidate preparation or finalization mode is required")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
