import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { verifyUpdateSmokeEvidenceDocument } from './verify-update-smoke-evidence.mjs'

const MAX_DRIVER_OUTPUT_BYTES = 128 * 1024
const TRUSTED_NATIVE_DRIVER = path.resolve(import.meta.dirname, 'native-update-smoke-driver.mjs')

/** 读取文件并计算完整字节的 lowercase SHA-256。 */
async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

/** 无 shell 执行 repo-owned native driver，并限制其 stdout/stderr 大小。 */
function runDriverCommand(executable, args, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
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
      if (stdoutBytes > MAX_DRIVER_OUTPUT_BYTES) reject(new Error('native update smoke driver output exceeded the evidence bound'))
      else if (code !== 0) reject(new Error(`native update smoke driver failed (${code}): ${stderr.trim().slice(0, 2048)}`))
      else resolve({ stdout: Buffer.concat(stdout), stderr })
    })
  })
}

/** 调用真实原生自动化入口并生成绑定候选与 previous Stable 的 checksummed evidence。 */
export async function runNativeUpdateSmoke(options, environment = process.env, dependencies = {}) {
  const driver = environment.DSH_UPDATE_SMOKE_DRIVER
  if (!driver) throw new Error('DSH_UPDATE_SMOKE_DRIVER is required; native evidence cannot be synthesized')
  if (!dependencies.runDriver && path.resolve(driver) !== TRUSTED_NATIVE_DRIVER) {
    throw new Error('promotion-eligible evidence requires the fixed repository-owned native driver')
  }
  const required = ['target', 'candidateTag', 'candidateCommit', 'candidateManifest', 'candidatePackage', 'candidateSignature', 'baselineTag', 'baselineVersion', 'baselineCommit', 'baselineArtifact', 'baselineSignature', 'baselineStableManifest', 'baselineArtifactUrl', 'baselineProvenance', 'outputDirectory']
  for (const name of required) if (!options[name]) throw new Error(`native update smoke option is required: ${name}`)
  const [manifestSha256, packageSha256, candidateSignatureSha256, baselineArtifactSha256, baselineSignatureSha256, baselineManifestSha256] = await Promise.all([
    sha256File(options.candidateManifest),
    sha256File(options.candidatePackage),
    sha256File(options.candidateSignature),
    sha256File(options.baselineArtifact),
    sha256File(options.baselineSignature),
    sha256File(options.baselineStableManifest)
  ])
  const usingTestAdapter = Boolean(dependencies.runDriver)
  const runDriver = dependencies.runDriver ?? runDriverCommand
  const driverArguments = [
    '--target', options.target,
    '--baseline-artifact', options.baselineArtifact,
    '--candidate-package', options.candidatePackage,
    '--candidate-signature', options.candidateSignature,
    '--candidate-manifest', options.candidateManifest,
    '--expected-candidate-version', options.candidateTag.replace(/^v/, ''),
    '--fixed-host-origin', 'http://127.0.0.1:3080/'
  ]
  const resolvedDriver = dependencies.runDriver ? driver : TRUSTED_NATIVE_DRIVER
  const executable = resolvedDriver.endsWith('.mjs') ? process.execPath : resolvedDriver
  const result = await runDriver(executable, resolvedDriver.endsWith('.mjs') ? [resolvedDriver, ...driverArguments] : driverArguments, {
    PATH: environment.PATH,
    SystemRoot: environment.SystemRoot,
    DSH_UPDATE_SMOKE_OUTPUT: 'json'
  })
  let observation
  try {
    observation = JSON.parse(result.stdout.toString('utf8'))
  } catch {
    throw new Error('native update smoke driver did not return one valid JSON observation')
  }
  const effectiveBaselineProvenance = usingTestAdapter ? 'local-fixture' : options.baselineProvenance
  const evidenceKind = usingTestAdapter ? 'local-fixture' : options.baselineProvenance === 'published-release' ? 'real-native' : options.baselineProvenance
  const version = options.candidateTag.replace(/^v/, '')
  const evidence = {
    schema_version: 1,
    evidence_kind: evidenceKind,
    target: options.target,
    runner: observation.runner,
    candidate: {
      tag: options.candidateTag,
      version,
      commit: options.candidateCommit,
      manifest_sha256: manifestSha256,
      package_sha256: packageSha256,
      signature_sha256: candidateSignatureSha256
    },
    baseline: {
      tag: options.baselineTag,
      version: options.baselineVersion,
      commit: options.baselineCommit,
      provenance: effectiveBaselineProvenance,
      artifact_sha256: baselineArtifactSha256,
      signature_sha256: baselineSignatureSha256,
      stable_manifest_sha256: baselineManifestSha256,
      artifact_url: options.baselineArtifactUrl
    },
    previous_version: options.baselineVersion,
    started_at: observation.started_at,
    completed_at: observation.completed_at,
    platform: observation.platform,
    observations: observation.observations,
    checkpoints: observation.checkpoints,
    ...(observation.diagnostics ? { diagnostics: observation.diagnostics } : {})
  }
  verifyUpdateSmokeEvidenceDocument(evidence, {
    tag: options.candidateTag,
    version,
    commit: options.candidateCommit,
    manifest_sha256: manifestSha256,
    maxAgeHours: 24,
    requireRealNative: !usingTestAdapter && options.baselineProvenance === 'published-release'
  })
  await mkdir(options.outputDirectory, { recursive: true })
  const body = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`)
  if (body.length > MAX_DRIVER_OUTPUT_BYTES) throw new Error('native update smoke evidence exceeded the file bound')
  const evidencePath = path.join(options.outputDirectory, `${options.target}.json`)
  const checksumPath = `${evidencePath}.sha256`
  await writeFile(evidencePath, body, { flag: 'wx' })
  await writeFile(checksumPath, `${createHash('sha256').update(body).digest('hex')}  ${path.basename(evidencePath)}\n`, { flag: 'wx' })
  return Object.freeze({ evidence, evidencePath, checksumPath })
}

/** 将 CLI 的成对参数转换为 camelCase harness 选项。 */
function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid native smoke argument: ${name ?? ''}`)
    const key = name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
    values[key] = value
  }
  return values
}

/** 执行原生 harness CLI；成功日志不暴露本机路径。 */
async function main() {
  const result = await runNativeUpdateSmoke(parseArguments(process.argv.slice(2)))
  console.log(`Recorded native update smoke evidence for ${result.evidence.target}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
