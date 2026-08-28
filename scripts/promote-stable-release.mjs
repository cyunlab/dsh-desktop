import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TARGETS = Object.freeze([
  'windows-x86_64',
  'linux-x86_64',
  'darwin-aarch64',
  'darwin-x86_64'
])

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
  const updaterPackages = names.filter(name => name.startsWith(`dsh-desktop-${target}-updater.`) && !name.endsWith('.sig'))
  const packages = updaterPackages.length > 0
    ? updaterPackages
    : names.filter(name => !name.endsWith('.sig') && !name.toLowerCase().endsWith('.dmg'))
  if (packages.length !== 1) throw new Error(`expected exactly one updater package for ${target}`)
  const filename = packages[0]
  const signatureName = `${filename}.sig`
  if (!names.includes(signatureName)) throw new Error(`updater signature is missing for ${target}`)
  const [body, signatureBody] = await Promise.all([
    readFile(path.join(targetDirectory, filename)),
    readFile(path.join(targetDirectory, signatureName))
  ])
  const signature = signatureBody.toString('utf8')
  if (!signature) throw new Error(`updater signature is empty for ${target}`)
  return { filename, body, signature, signatureBody }
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
  const commandEnvironment = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    OSS_ACCESS_KEY_ID: credentials.accessKeyId,
    OSS_ACCESS_KEY_SECRET: credentials.accessKeySecret,
    OSS_SESSION_TOKEN: credentials.securityToken,
    OSS_REGION: options.region
  }
  /** 构造限定在已配置 bucket 内的 OSS URI。 */
  function objectUri(key) {
    if (key.startsWith('/') || key.split('/').some(segment => segment === '..')) throw new Error('unsafe OSS object key')
    if (!key.startsWith(`${prefix}/`)) throw new Error(`OSS object is outside the configured application prefix: ${key}`)
    return `oss://${options.bucket}/${key}`
  }
  return {
    /** 上传单个 immutable 对象或 Stable manifest。 */
    async putObject(key, body, metadata) {
      const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'dsh-oss-promotion-'))
      const source = path.join(temporaryDirectory, 'object')
      try {
        await writeFile(source, body, { mode: 0o600 })
        const objectMetadata = [`Cache-Control:${metadata.cacheControl}`]
        if (metadata.contentType) objectMetadata.push(`Content-Type:${metadata.contentType}`)
        const args = ['cp', source, objectUri(key), '--region', options.region, '--force', '--meta', objectMetadata.join('#')]
        await runOssutil(args, { env: commandEnvironment })
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true })
      }
    },
    /** 下载远端对象并进行逐字节校验。 */
    async verifyObject(key, body) {
      const result = await runOssutil(['cat', objectUri(key), '--region', options.region], { env: commandEnvironment })
      if (!Buffer.from(result.stdout).equals(body)) throw new Error(`remote OSS object differs from uploaded bytes: ${key}`)
    }
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
  const values = parseArguments(args)
  const prefix = values.prefix ?? 'dsh-desktop'
  const release = values.tag && values.notes && values['published-at']
    ? { tag_name: values.tag, body: values.notes, published_at: values['published-at'] }
    : await readPublishedRelease(environment.GITHUB_EVENT_PATH, environment.GITHUB_REPOSITORY)
  const createStorage = dependencies.createStorage ?? createOssutilStorage
  const promote = dependencies.promote ?? promoteStableRelease
  const storage = createStorage({ bucket: environment.OSS_BUCKET, region: environment.OSS_REGION, prefix, credentials })
  return promote({
    tag: release.tag_name,
    releaseBody: release.body,
    publishedAt: release.published_at,
    artifactsDirectory: values.assets ?? environment.PROMOTION_ARTIFACTS_DIR ?? 'artifacts',
    downloadOrigin: environment.UPDATE_BASE_URL,
    prefix
  }, storage)
}

/** 提升一个完整的四目标更新发布，并返回写入 Stable channel 的 manifest。 */
export async function promoteStableRelease(options, storage) {
  const version = releaseVersion(options.tag)
  const prefix = normalizePrefix(options.prefix)
  const origin = new URL(options.downloadOrigin)
  if (origin.protocol !== 'https:') throw new Error('update download origin must use HTTPS')
  if (!String(options.releaseBody ?? '').trim()) throw new Error('GitHub Release body is required')
  const publishedAt = new Date(options.publishedAt)
  if (!options.publishedAt || Number.isNaN(publishedAt.valueOf())) throw new Error('published release timestamp is required')
  const platforms = {}
  const objects = []
  for (const target of TARGETS) {
    const artifact = await readTargetArtifact(options.artifactsDirectory, target)
    const key = `${prefix}/releases/${version}/${target}/${artifact.filename}`
    objects.push(
      { key, body: artifact.body, contentType: 'application/octet-stream' },
      { key: `${key}.sig`, body: artifact.signatureBody, contentType: 'text/plain; charset=utf-8' }
    )
    platforms[target] = {
      url: new URL(key, `${origin.href.replace(/\/$/, '')}/`).href,
      signature: artifact.signature
    }
  }
  const manifest = {
    version,
    notes: options.releaseBody,
    pub_date: options.publishedAt,
    platforms
  }
  for (const object of objects) {
    await storage.putObject(object.key, object.body, {
      cacheControl: 'public, max-age=31536000, immutable',
      contentType: object.contentType
    })
  }
  for (const object of objects) await storage.verifyObject(object.key, object.body)
  await storage.putObject(
    `${prefix}/channels/stable/latest.json`,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    { cacheControl: 'no-cache', contentType: 'application/json; charset=utf-8' }
  )
  return manifest
}

/** 运行发布器 CLI，日志仅包含公开版本信息。 */
async function main() {
  const manifest = await runPromotionCli()
  console.log(`Promoted Desktop ${manifest.version} to Stable`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
