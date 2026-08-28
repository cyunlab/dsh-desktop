import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_SMOKE_TARGETS = Object.freeze([
  'windows-x86_64',
  'linux-x86_64',
  'darwin-aarch64',
  'darwin-x86_64'
])

export const REQUIRED_SMOKE_CHECKPOINTS = Object.freeze([
  'update.available',
  'update.downloaded',
  'update.staged',
  'ui.user_opened',
  'install.restart_requested',
  'host.cleanup_confirmed_restart',
  'install.restart_completed',
  'app.relaunched',
  'app.updated_origin_ready',
  'install.normal_close_requested',
  'host.cleanup_confirmed_normal_close',
  'install.normal_close_completed',
  'app.normal_close_no_relaunch',
  'negative.bad_signature_blocked',
  'negative.missing_signature_blocked',
  'negative.missing_target_blocked',
  'negative.unreachable_object_blocked',
  'negative.tampered_staged_package_blocked',
  'negative.failed_host_cleanup_blocked',
  'setting.manual_check',
  'setting.background_download_off',
  'artifact.updater_signature_verified'
])

const OBSERVATIONS = Object.freeze([
  'official_node',
  'cli_runtime_closure',
  'desktop_capabilities_package',
  'desktop_update_client_package',
  'composition_patch',
  'trusted_updater_configuration'
])
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const MAX_EVIDENCE_BYTES = 128 * 1024
const MAX_RUN_MILLISECONDS = 4 * 60 * 60 * 1000
const CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1000

const TARGET_CONTRACTS = Object.freeze({
  'windows-x86_64': Object.freeze({
    runner: Object.freeze({ os: 'windows', arch: 'x86_64' }),
    platform: Object.freeze({ package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required', code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU', install_location_class: 'user-profile', msi_present: false })
  }),
  'linux-x86_64': Object.freeze({
    runner: Object.freeze({ os: 'linux', arch: 'x86_64' }),
    platform: Object.freeze({ package_kind: 'appimage', install_scope: 'user', authenticode: 'not-applicable', code_signing: 'not-applicable', notarization: 'not-applicable', replacement_path_same: true, executable_bit: true, digest_changed: true })
  }),
  'darwin-aarch64': Object.freeze({
    runner: Object.freeze({ os: 'macos', arch: 'aarch64' }),
    platform: Object.freeze({ package_kind: 'app-tar-gz', install_scope: 'user', authenticode: 'not-applicable' })
  }),
  'darwin-x86_64': Object.freeze({
    runner: Object.freeze({ os: 'macos', arch: 'x86_64' }),
    platform: Object.freeze({ package_kind: 'app-tar-gz', install_scope: 'user', authenticode: 'not-applicable' })
  })
})

/** 解析证据使用的严格三段语义版本，返回可比较整数。 */
function semanticVersion(value, label) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value ?? '')
  if (!match) throw new Error(`${label} must be a stable semantic version`)
  return match.slice(1).map(Number)
}

/** 判断候选三段语义版本是否严格高于 baseline。 */
function isNewer(candidate, baseline) {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== baseline[index]) return candidate[index] > baseline[index]
  }
  return false
}

/** 要求值为普通 JSON 对象。 */
function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

/** 要求值为非空、有界且不包含换行的字符串。 */
function requireBoundedString(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a bounded single-line string`)
  }
  return value
}

/** 拒绝可能含密钥、认证参数或用户目录的文本证据。 */
function requireSafeText(value, label, maximum = 512) {
  requireBoundedString(value, label, maximum)
  if (/-----BEGIN|(?:token|secret|password|authorization)[=:]|(?:\/Users\/|\/home\/[^/]+\/|[A-Z]:\\Users\\)|[?&](?:token|signature|key)=/i.test(value)) {
    throw new Error(`${label} contains prohibited secret or user-path material`)
  }
}

/** 验证固定对象字段逐项等于平台合约。 */
function requireContract(actual, expected, label) {
  requireObject(actual, label)
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`${label} mismatch for ${key}`)
  }
}

/** 校验一份 evidence 的 candidate、baseline、时间、平台和 checkpoint。 */
function verifyDocument(document, expectations) {
  requireObject(document, 'evidence')
  if (document.schema_version !== 1) throw new Error('unsupported evidence schema_version')
  if (!['real-native', 'local-fixture', 'source-rebuild'].includes(document.evidence_kind)) throw new Error('invalid evidence_kind')
  if (expectations.requireRealNative && document.evidence_kind !== 'real-native') throw new Error('real-native evidence is required')
  const target = requireBoundedString(document.target, 'target', 64)
  const contract = TARGET_CONTRACTS[target]
  if (!contract) throw new Error(`unsupported evidence target: ${target}`)
  requireContract(document.runner, contract.runner, 'runner contract')
  requireContract(document.platform, contract.platform, 'platform contract')
  if (target.startsWith('darwin-')) {
    const configured = document.platform.signing_credentials_configured
    if (typeof configured !== 'boolean') throw new Error('macOS signing credential observation is required')
    const expected = configured ? 'verified' : 'not-configured'
    if (document.platform.code_signing !== expected || document.platform.notarization !== expected) {
      throw new Error('platform contract mismatch for macOS signing/notarization')
    }
  }

  const candidate = requireObject(document.candidate, 'candidate')
  for (const field of ['tag', 'version', 'commit', 'manifest_sha256']) {
    if (candidate[field] !== expectations[field]) throw new Error(`candidate ${field.replace('_sha256', '')} does not match`)
  }
  if (!COMMIT.test(candidate.commit)) throw new Error('candidate commit must be a 40-character lowercase Git commit')
  if (!SHA256.test(candidate.manifest_sha256)) throw new Error('candidate manifest_sha256 must be lowercase SHA-256')
  if (!SHA256.test(candidate.package_sha256)) throw new Error('candidate package_sha256 must be lowercase SHA-256')
  if (!SHA256.test(candidate.signature_sha256)) throw new Error('candidate signature_sha256 must be lowercase SHA-256')

  const baseline = requireObject(document.baseline, 'baseline')
  requireBoundedString(baseline.tag, 'baseline tag', 128)
  requireBoundedString(baseline.version, 'baseline version', 128)
  if (!COMMIT.test(baseline.commit)) throw new Error('baseline commit must be a 40-character lowercase Git commit')
  if (!['published-release', 'source-rebuild', 'local-fixture'].includes(baseline.provenance)) throw new Error('invalid baseline provenance')
  if (expectations.requireRealNative && baseline.provenance !== 'published-release') throw new Error('published-release baseline is required')
  if (!SHA256.test(baseline.artifact_sha256)) throw new Error('baseline artifact_sha256 must be lowercase SHA-256')
  if (!SHA256.test(baseline.signature_sha256)) throw new Error('baseline signature_sha256 must be lowercase SHA-256')
  if (!SHA256.test(baseline.stable_manifest_sha256)) throw new Error('baseline stable_manifest_sha256 must be lowercase SHA-256')
  let baselineUrl
  try { baselineUrl = new URL(baseline.artifact_url) } catch { throw new Error('baseline artifact_url must be an HTTPS URL') }
  if (baselineUrl.protocol !== 'https:' || baselineUrl.hostname !== 'updates.cyunlab.com' || baselineUrl.username || baselineUrl.password || baselineUrl.search || baselineUrl.hash) {
    throw new Error('baseline artifact_url must be an uncredentialed immutable updates.cyunlab.com HTTPS URL')
  }
  if (document.previous_version !== baseline.version) throw new Error('previous_version must match the baseline version')
  if (baseline.tag.replace(/^v/, '') !== baseline.version) throw new Error('baseline tag must match the baseline version')
  const candidateSemver = semanticVersion(candidate.version, 'candidate version')
  const baselineSemver = semanticVersion(baseline.version, 'baseline version')
  if (!isNewer(candidateSemver, baselineSemver)) throw new Error('candidate version must be newer than the baseline version')

  const startedAt = new Date(document.started_at)
  const completedAt = new Date(document.completed_at)
  const now = expectations.now instanceof Date ? expectations.now : new Date()
  if (Number.isNaN(startedAt.valueOf()) || Number.isNaN(completedAt.valueOf())) throw new Error('evidence timestamps must be RFC 3339 values')
  if (completedAt < startedAt || completedAt.valueOf() - startedAt.valueOf() > MAX_RUN_MILLISECONDS) throw new Error('evidence duration exceeds the allowed native run window')
  if (completedAt.valueOf() > now.valueOf() + CLOCK_SKEW_MILLISECONDS) throw new Error('evidence completed in the future')
  if (now.valueOf() - completedAt.valueOf() > expectations.maxAgeHours * 60 * 60 * 1000) throw new Error('evidence is stale')

  const observations = requireObject(document.observations, 'observations')
  for (const observation of OBSERVATIONS) {
    if (observations[observation] !== true) throw new Error(`required observation did not pass: ${observation}`)
  }
  if (!Array.isArray(document.checkpoints)) throw new Error('checkpoints must be an array')
  const identifiers = document.checkpoints.map(checkpoint => requireBoundedString(requireObject(checkpoint, 'checkpoint').id, 'checkpoint id', 128))
  if (new Set(identifiers).size !== identifiers.length) throw new Error('duplicate checkpoint id')
  if (identifiers.length !== REQUIRED_SMOKE_CHECKPOINTS.length || REQUIRED_SMOKE_CHECKPOINTS.some(id => !identifiers.includes(id))) {
    throw new Error('checkpoint set does not exactly match the required contract')
  }
  for (const checkpoint of document.checkpoints) {
    if (checkpoint.status !== 'passed') throw new Error(`checkpoint did not pass: ${checkpoint.id}`)
    if (checkpoint.details !== undefined) requireSafeText(checkpoint.details, 'checkpoint details')
  }
  if (document.diagnostics !== undefined) {
    requireSafeText(document.diagnostics, 'diagnostics', 4096)
  }
  return target
}

/** 验证一份单目标 evidence；供原生 harness 在落盘前复用同一 fail-closed 合约。 */
export function verifyUpdateSmokeEvidenceDocument(document, expectations) {
  return verifyDocument(document, expectations)
}

/** 验证四目标证据集严格绑定同一候选并返回可供发布器消费的摘要。 */
export function verifyUpdateSmokeEvidenceSet(documents, expectations) {
  if (!Array.isArray(documents)) throw new Error('evidence set must be an array')
  if (!expectations || !Number.isFinite(expectations.maxAgeHours) || expectations.maxAgeHours <= 0) throw new Error('a positive maxAgeHours is required')
  const targets = documents.map(document => verifyDocument(document, expectations))
  if (new Set(targets).size !== targets.length) throw new Error('duplicate evidence target')
  if (targets.length !== REQUIRED_SMOKE_TARGETS.length || REQUIRED_SMOKE_TARGETS.some(target => !targets.includes(target))) {
    throw new Error('evidence targets do not exactly match the required four-target set')
  }
  const baseline = documents[0].baseline
  for (const document of documents.slice(1)) {
    for (const field of ['tag', 'version', 'commit', 'stable_manifest_sha256']) {
      if (document.baseline[field] !== baseline[field]) throw new Error(`baseline ${field} does not match across targets`)
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    targets: REQUIRED_SMOKE_TARGETS,
    candidate: Object.freeze({
      tag: expectations.tag,
      version: expectations.version,
      commit: expectations.commit,
      manifest_sha256: expectations.manifest_sha256
    })
  })
}

/** 读取严格命名且带 SHA-256 companion 的 evidence 目录。 */
export async function verifyUpdateSmokeEvidenceDirectory(directory, expectations) {
  const entries = await readdir(directory, { withFileTypes: true })
  const expectedNames = REQUIRED_SMOKE_TARGETS.flatMap(target => [`${target}.json`, `${target}.json.sha256`]).sort()
  const actualNames = entries.map(entry => entry.name).sort()
  if (entries.some(entry => !entry.isFile()) || actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error('evidence directory must contain only the exact target JSON and checksum files')
  }
  const documents = []
  for (const target of REQUIRED_SMOKE_TARGETS) {
    const filename = `${target}.json`
    const evidencePath = path.join(directory, filename)
    const information = await stat(evidencePath)
    if (information.size <= 0 || information.size > MAX_EVIDENCE_BYTES) throw new Error(`evidence file size is out of bounds: ${filename}`)
    const [body, checksumText] = await Promise.all([readFile(evidencePath), readFile(`${evidencePath}.sha256`, 'utf8')])
    const expectedChecksum = `${createHash('sha256').update(body).digest('hex')}  ${filename}\n`
    if (checksumText !== expectedChecksum) throw new Error(`checksum mismatch for ${filename}`)
    try {
      documents.push(JSON.parse(body.toString('utf8')))
    } catch {
      throw new Error(`evidence is not valid JSON: ${filename}`)
    }
  }
  return verifyUpdateSmokeEvidenceSet(documents, expectations)
}

/** 解析公开 verifier CLI 的成对参数。 */
function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--require-real-native') {
      values.requireRealNative = true
      continue
    }
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid evidence verifier argument: ${name ?? ''}`)
    values[name.slice(2)] = value
    index += 1
  }
  return values
}

/** 校验 CLI 参数并验证一个 evidence artifact 目录。 */
export async function runUpdateSmokeEvidenceCli(args = process.argv.slice(2), now = new Date()) {
  const values = parseArguments(args)
  for (const name of ['evidence', 'candidate-tag', 'candidate-commit', 'manifest-sha256', 'max-age-hours']) {
    if (!values[name]) throw new Error(`--${name} is required`)
  }
  const tagMatch = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(values['candidate-tag'])
  if (!tagMatch) throw new Error('--candidate-tag must be a semantic version tag')
  const version = values['candidate-tag'].startsWith('v') ? values['candidate-tag'].slice(1) : values['candidate-tag']
  return verifyUpdateSmokeEvidenceDirectory(values.evidence, {
    tag: values['candidate-tag'],
    version,
    commit: values['candidate-commit'],
    manifest_sha256: values['manifest-sha256'],
    maxAgeHours: Number(values['max-age-hours']),
    requireRealNative: values.requireRealNative === true,
    now
  })
}

/** 执行 verifier CLI，只输出不含路径或密钥的候选摘要。 */
async function main() {
  const result = await runUpdateSmokeEvidenceCli()
  console.log(`Verified update smoke evidence v${result.schemaVersion} for ${result.candidate.tag} (${result.targets.length} native targets)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
