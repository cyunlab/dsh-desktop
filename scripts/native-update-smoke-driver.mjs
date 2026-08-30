import { arch, platform } from 'node:process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createNativeUpdatePlatformAdapter } from './native-update-platform-adapter.mjs'
import { REQUIRED_SMOKE_CHECKPOINTS } from './verify-update-smoke-evidence.mjs'

const TARGET_RUNTIME = Object.freeze({
  'windows-x86_64': Object.freeze({ platform: 'win32', arch: 'x64' }),
  'linux-x86_64': Object.freeze({ platform: 'linux', arch: 'x64' }),
  'darwin-aarch64': Object.freeze({ platform: 'darwin', arch: 'arm64' }),
  'darwin-x86_64': Object.freeze({ platform: 'darwin', arch: 'x64' })
})

/** 在接触安装包前确认真实 runner 与目标完全一致。 */
export function assertNativeRunner(target) {
  const expected = TARGET_RUNTIME[target]
  if (!expected) throw new Error(`unsupported native update smoke target: ${target ?? ''}`)
  if (platform !== expected.platform || arch !== expected.arch) {
    throw new Error(`native runner mismatch for ${target}: observed ${platform}/${arch}`)
  }
}

/** 校验 native driver 只接受严格升级与固定 production Stable endpoint。 */
function validateOptions(options) {
  if (!TARGET_RUNTIME[options.target]) throw new Error(`unsupported native update smoke target: ${options.target ?? ''}`)
  for (const name of ['baselineArtifact', 'baselineSignature', 'baselineVersion', 'candidatePackage', 'candidateSignature', 'candidateVersion', 'candidateManifest', 'candidatePackageSha256', 'updaterEndpoint', 'updaterPublicKey', 'updaterPublicKeySha256', 'signingConfigured']) {
    if (!options[name]) throw new Error(`native update driver option is required: ${name}`)
  }
  const endpoint = new URL(options.updaterEndpoint)
  if (endpoint.href !== 'https://updates.cyunlab.com/dsh-desktop/channels/stable/latest.json') throw new Error('native update driver requires the fixed production Stable endpoint')
  if (!Buffer.isBuffer(options.candidateManifest) || options.candidateManifest.length <= 0 || options.candidateManifest.length > 128 * 1024) throw new Error('candidate manifest is outside the native driver byte bound')
  if (!/^[0-9a-f]{64}$/.test(options.candidatePackageSha256)) throw new Error('candidate package digest must be lowercase SHA-256')
  if (!/^[0-9a-f]{64}$/.test(options.updaterPublicKeySha256)) throw new Error('updater public key digest must be lowercase SHA-256')
  if (!['true', 'false'].includes(options.signingConfigured)) throw new Error('native update signing policy must be true or false')
  /** 解析只允许正式三段式版本的候选输入。 */
  function parseVersion(value) {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
    if (!match) throw new Error('native update versions must be stable semantic versions')
    return match.slice(1).map(Number)
  }
  const baseline = parseVersion(options.baselineVersion)
  const candidate = parseVersion(options.candidateVersion)
  if (!candidate.some((part, index) => part !== baseline[index] && part > baseline[index] && candidate.slice(0, index).every((prefix, prefixIndex) => prefix === baseline[prefixIndex]))) throw new Error('candidate version must be newer than baseline')
}

/** 合并主流程与清理失败，避免 finally 覆盖真正的 update 根因。 */
function combineDriverErrors(primaryError, cleanupError) {
  if (!primaryError) return cleanupError
  if (!cleanupError) return primaryError
  return new AggregateError([primaryError, cleanupError], primaryError.message)
}

/** 执行 previous-Stable 正常退出安装，并证明同一安装位置的新版本重新达到 Host Ready。 */
export async function runNativeUpdateSmokeDriver(options, platformAdapter) {
  validateOptions(options)
  for (const method of ['assertRunner', 'installBaseline', 'inspectInstalledRuntime', 'withTlsGate', 'launch', 'waitForReady', 'waitForStaged', 'requestNormalClose', 'waitForNormalClose', 'inspectUpdatedInstallation', 'assertNotRelaunched', 'cleanup']) {
    if (typeof platformAdapter?.[method] !== 'function') throw new Error(`native update platform adapter is missing ${method}`)
  }
  const startedAt = new Date().toISOString()
  let primaryError
  let result
  try {
    platformAdapter.assertRunner(options.target)
    const baseline = await platformAdapter.installBaseline(options)
    const baselineObservations = await platformAdapter.inspectInstalledRuntime(baseline, options)
    await platformAdapter.withTlsGate({ endpoint: options.updaterEndpoint, manifest: options.candidateManifest }, async gate => {
      const baselineLaunch = await platformAdapter.launch(baseline, options)
      await platformAdapter.waitForReady(baselineLaunch, options.baselineVersion, options)
      await gate.waitForRequest()
      await gate.restoreRouting()
      await gate.releaseManifest()
      await platformAdapter.waitForStaged(baseline, options)
      await platformAdapter.requestNormalClose(baselineLaunch, baseline, options)
      await platformAdapter.waitForNormalClose(baselineLaunch, baseline, options)
      const updated = await platformAdapter.inspectUpdatedInstallation(baseline, options)
      await platformAdapter.assertNotRelaunched(baselineLaunch, baseline, options)
      const updatedLaunch = await platformAdapter.launch(updated, options)
      await platformAdapter.waitForReady(updatedLaunch, options.candidateVersion, options)
      const updatedObservations = await platformAdapter.inspectInstalledRuntime(updated, options)
      const observations = Object.fromEntries(Object.keys(baselineObservations).map(key => [key, baselineObservations[key] === true && updatedObservations[key] === true]))
      result = {
        runner: platformAdapter.runner,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        platform: platformAdapter.platform,
        observations,
        checkpoints: REQUIRED_SMOKE_CHECKPOINTS.map(id => ({ id, status: 'passed' }))
      }
    })
  } catch (error) {
    primaryError = error
  }
  let cleanupError
  try { await platformAdapter.cleanup() } catch (error) { cleanupError = error }
  const failure = combineDriverErrors(primaryError, cleanupError)
  if (failure) throw failure
  if (!result) throw new Error('native update driver completed without an observation')
  return result
}

/** 读取 driver CLI 的固定成对参数。 */
function parseArguments(args) {
  const allowed = new Set(['target', 'baselineArtifact', 'baselineSignature', 'baselineVersion', 'candidatePackage', 'candidateSignature', 'candidateManifest', 'candidateVersion', 'candidatePackageSha256', 'updaterEndpoint', 'updaterPublicKey', 'updaterPublicKeySha256', 'signingConfigured'])
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid native update driver argument: ${name ?? ''}`)
    const key = name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
    if (!allowed.has(key) || Object.hasOwn(values, key)) throw new Error(`unknown or duplicate native update driver argument: ${name}`)
    values[key] = value
  }
  return values
}

/** 执行 production CLI，并只向 stdout 写一个有界 JSON observation。 */
async function main() {
  const options = parseArguments(process.argv.slice(2))
  assertNativeRunner(options.target)
  options.candidateManifest = await readFile(options.candidateManifest)
  const observation = await runNativeUpdateSmokeDriver(options, createNativeUpdatePlatformAdapter(options.target))
  const body = Buffer.from(JSON.stringify(observation))
  if (body.length > 128 * 1024) throw new Error('native update driver observation exceeds byte bound')
  process.stdout.write(body)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
