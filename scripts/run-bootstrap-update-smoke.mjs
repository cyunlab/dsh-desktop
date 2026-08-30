import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { verifyBootstrapUpdateEvidenceDocument } from './verify-bootstrap-update-evidence.mjs'

const MAX_DRIVER_OUTPUT_BYTES = 128 * 1024
const TRUSTED_BOOTSTRAP_DRIVER = path.resolve(import.meta.dirname, 'bootstrap-update-smoke-driver.mjs')

/** 读取文件并计算完整字节的 lowercase SHA-256。 */
async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** 无 shell 执行 repo-owned bootstrap driver，并限制输出大小。 */
function runDriverCommand(executable, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: environment, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const stdout = []
    let stdoutBytes = 0
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_DRIVER_OUTPUT_BYTES) child.kill()
      else stdout.push(chunk)
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < MAX_DRIVER_OUTPUT_BYTES) stderr += chunk.toString('utf8', 0, MAX_DRIVER_OUTPUT_BYTES - stderr.length)
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (stdoutBytes > MAX_DRIVER_OUTPUT_BYTES) reject(new Error('bootstrap update smoke driver output exceeded the evidence bound'))
      else if (code !== 0) reject(new Error(`bootstrap update smoke driver failed (${code}): ${stderr.trim().slice(0, 2048)}`))
      else resolve({ stdout: Buffer.concat(stdout), stderr })
    })
  })
}

/** 调用真实 fresh-install 原生入口并生成独立 bootstrap evidence。 */
export async function runBootstrapUpdateSmoke(options, environment = process.env, dependencies = {}) {
  const driver = environment.DSH_BOOTSTRAP_UPDATE_SMOKE_DRIVER
  if (!driver) throw new Error('DSH_BOOTSTRAP_UPDATE_SMOKE_DRIVER is required; bootstrap evidence cannot be synthesized')
  if (!dependencies.runDriver && path.resolve(driver) !== TRUSTED_BOOTSTRAP_DRIVER) throw new Error('bootstrap evidence requires the fixed repository-owned native driver')
  const required = ['target', 'candidateTag', 'candidateCommit', 'candidateManifest', 'candidateManifestUrl', 'candidatePackage', 'candidateSignature', 'candidatePackageUrl', 'candidateReleaseUrl', 'expectedUpdaterEndpoint', 'expectedUpdaterPublicKey', 'signingConfigured', 'outputDirectory']
  for (const name of required) if (!options[name]) throw new Error(`bootstrap update smoke option is required: ${name}`)
  if (!['true', 'false'].includes(options.signingConfigured)) throw new Error('bootstrap signingConfigured must be explicitly true or false')
  const [manifestSha256, packageSha256, signatureSha256] = await Promise.all([
    sha256File(options.candidateManifest), sha256File(options.candidatePackage), sha256File(options.candidateSignature)
  ])
  const usingTestAdapter = Boolean(dependencies.runDriver)
  const runDriver = dependencies.runDriver ?? runDriverCommand
  const resolvedDriver = usingTestAdapter ? driver : TRUSTED_BOOTSTRAP_DRIVER
  const executable = resolvedDriver.endsWith('.mjs') ? process.execPath : resolvedDriver
  const driverArguments = [
    '--target', options.target,
    '--candidate-package', options.candidatePackage,
    '--candidate-signature', options.candidateSignature,
    '--candidate-manifest', options.candidateManifest,
    '--candidate-manifest-url', options.candidateManifestUrl,
    '--candidate-package-url', options.candidatePackageUrl,
    '--expected-candidate-version', options.candidateTag.replace(/^v/, ''),
    '--expected-manifest-sha256', manifestSha256,
    '--expected-package-sha256', packageSha256,
    '--expected-signature-sha256', signatureSha256,
    '--expected-updater-endpoint', options.expectedUpdaterEndpoint,
    '--expected-updater-public-key', options.expectedUpdaterPublicKey,
    '--expected-updater-public-key-sha256', createHash('sha256').update(options.expectedUpdaterPublicKey).digest('hex'),
    '--signing-configured', options.signingConfigured,
    '--fresh-install-only', 'true'
  ]
  const driverEnvironment = { DSH_BOOTSTRAP_UPDATE_SMOKE_OUTPUT: 'json' }
  for (const name of ['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR', 'DISPLAY', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR']) {
    if (environment[name] !== undefined) driverEnvironment[name] = environment[name]
  }
  const result = await runDriver(executable, resolvedDriver.endsWith('.mjs') ? [resolvedDriver, ...driverArguments] : driverArguments, driverEnvironment)
  let observation
  try { observation = JSON.parse(result.stdout.toString('utf8')) } catch { throw new Error('bootstrap update smoke driver did not return one valid JSON observation') }
  const version = options.candidateTag.replace(/^v/, '')
  const evidence = {
    schema_version: 1,
    evidence_kind: usingTestAdapter ? 'bootstrap-local-fixture' : 'bootstrap-fresh-install',
    claims_previous_stable_upgrade: false,
    target: options.target,
    runner: observation.runner,
    candidate: {
      tag: options.candidateTag,
      version,
      commit: options.candidateCommit,
      provenance: usingTestAdapter ? 'local-fixture' : 'published-release',
      release_url: options.candidateReleaseUrl,
      manifest_url: options.candidateManifestUrl,
      manifest_sha256: manifestSha256,
      package_url: options.candidatePackageUrl,
      package_sha256: packageSha256,
      signature_sha256: signatureSha256
    },
    installation: observation.installation,
    started_at: observation.started_at,
    completed_at: observation.completed_at,
    platform: observation.platform,
    observations: observation.observations,
    observation_sources: observation.observation_sources,
    ...(observation.diagnostics ? { diagnostics: observation.diagnostics } : {})
  }
  verifyBootstrapUpdateEvidenceDocument(evidence, {
    tag: options.candidateTag, version, commit: options.candidateCommit, manifest_sha256: manifestSha256,
    maxAgeHours: 24, requireRealBootstrap: !usingTestAdapter
  })
  await mkdir(options.outputDirectory, { recursive: true })
  const body = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)
  if (body.length > MAX_DRIVER_OUTPUT_BYTES) throw new Error('bootstrap update smoke evidence exceeded the file bound')
  const evidencePath = path.join(options.outputDirectory, `${options.target}.json`)
  const checksumPath = `${evidencePath}.sha256`
  await writeFile(evidencePath, body, { flag: 'wx' })
  await writeFile(checksumPath, `${createHash('sha256').update(body).digest('hex')}  ${path.basename(evidencePath)}\n`, { flag: 'wx' })
  return Object.freeze({ evidence, evidencePath, checksumPath })
}

/** 将 CLI 参数对转换为 camelCase producer 选项。 */
function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid bootstrap smoke argument: ${name ?? ''}`)
    values[name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value
  }
  return values
}

/** 执行 bootstrap producer CLI。 */
async function main() {
  const result = await runBootstrapUpdateSmoke(parseArguments(process.argv.slice(2)))
  console.log(`Recorded bootstrap update smoke evidence for ${result.evidence.target}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
