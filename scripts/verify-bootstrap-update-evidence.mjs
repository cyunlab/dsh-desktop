import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_BOOTSTRAP_TARGETS = Object.freeze([
  'windows-x86_64',
  'linux-x86_64',
  'darwin-aarch64',
  'darwin-x86_64'
])

const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const MAX_EVIDENCE_BYTES = 128 * 1024
const MAX_RUN_MILLISECONDS = 4 * 60 * 60 * 1000
const CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1000
const OBSERVATIONS = Object.freeze([
  'updater_endpoint_enabled',
  'updater_public_key_enabled',
  'updater_signature_verified',
  'immutable_object_identity_verified',
  'official_node',
  'cli_runtime_closure',
  'desktop_capabilities_package',
  'desktop_update_client_package',
  'composition_patch'
])
const OBSERVATION_SOURCES = Object.freeze({
  configuration_identity: 'runtime-jsonl', signature_identity: 'node-ed25519-minisign', package_identity: 'immutable-manifest-sha256',
  installation_identity: 'native-platform', host_readiness: 'fixed-origin-http', runtime_closure: 'installed-filesystem'
})
const TARGET_CONTRACTS = Object.freeze({
  'windows-x86_64': Object.freeze({
    runner: Object.freeze({ os: 'windows', arch: 'x86_64' }),
    platform: Object.freeze({ package_kind: 'nsis-exe', install_scope: 'current-user', authenticode: 'not-required', code_signing: 'not-applicable', notarization: 'not-applicable', install_registry_root: 'HKCU', install_location_class: 'user-profile', msi_present: false })
  }),
  'linux-x86_64': Object.freeze({
    runner: Object.freeze({ os: 'linux', arch: 'x86_64' }),
    platform: Object.freeze({ package_kind: 'appimage', install_scope: 'user', authenticode: 'not-applicable', code_signing: 'not-applicable', notarization: 'not-applicable', replacement_eligible: true, executable_bit: true })
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

/** 要求值为普通 JSON 对象。 */
function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

/** 要求值为有界单行字符串。 */
function requireBoundedString(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a bounded single-line string`)
  }
  return value
}

/** 拒绝 diagnostics 中的密钥、认证参数和用户目录。 */
function requireSafeText(value, label, maximum = 4096) {
  requireBoundedString(value, label, maximum)
  if (/-----BEGIN|(?:token|secret|password|authorization)[=:]|(?:\/Users\/|\/home\/[^/]+\/|[A-Z]:\\Users\\)|[?&](?:token|signature|key)=/i.test(value)) {
    throw new Error(`${label} contains prohibited secret or user-path material`)
  }
}

/** 校验平台或 runner 固定字段。 */
function requireContract(actual, expected, label) {
  requireObject(actual, label)
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`${label} mismatch for ${key}`)
  }
}

/** 校验无凭据、无 query 的不可变 OSS 更新对象 URL。 */
function requireImmutablePackageUrl(value, version, target, packageSha256) {
  let url
  try { url = new URL(value) } catch { throw new Error('candidate package_url must be an HTTPS URL') }
  const prefix = `/dsh-desktop/releases/${version}/${target}/`
  if (url.protocol !== 'https:' || url.hostname !== 'updates.cyunlab.com' || url.username || url.password || url.search || url.hash || !url.pathname.startsWith(prefix)) {
    throw new Error('candidate package_url must identify an immutable updates.cyunlab.com release object')
  }
  if (!path.posix.basename(url.pathname).startsWith(packageSha256.slice(0, 12))) throw new Error('candidate package_url digest prefix does not match package_sha256')
}

/** 校验 GitHub published Release 的确定来源 URL。 */
function requirePublishedReleaseUrl(value, tag) {
  let url
  try { url = new URL(value) } catch { throw new Error('candidate release_url must be the tagged GitHub Release URL') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname !== `/cyunlab/dsh-desktop/releases/tag/${tag}` || url.search || url.hash) {
    throw new Error('candidate release_url must be the tagged GitHub Release URL')
  }
}

/** 校验候选 manifest 是绑定 version、commit 和 digest 的 OSS immutable object。 */
function requireImmutableManifestUrl(value, candidate) {
  let url
  try { url = new URL(value) } catch { throw new Error('candidate manifest_url must be an HTTPS URL') }
  const expectedPath = `/dsh-desktop/candidates/${candidate.version}/${candidate.commit}/${candidate.manifest_sha256}-latest.json`
  if (url.protocol !== 'https:' || url.hostname !== 'updates.cyunlab.com' || url.username || url.password || url.search || url.hash || url.pathname !== expectedPath) {
    throw new Error('candidate manifest_url must identify the approved immutable OSS candidate')
  }
}

/** 校验一份单目标 bootstrap fresh-install evidence。 */
function verifyDocument(document, expectations) {
  requireObject(document, 'bootstrap evidence')
  if (document.schema_version !== 1) throw new Error('unsupported bootstrap evidence schema_version')
  if (!['bootstrap-fresh-install', 'bootstrap-local-fixture'].includes(document.evidence_kind)) throw new Error('invalid bootstrap evidence_kind')
  if (expectations.requireRealBootstrap && document.evidence_kind !== 'bootstrap-fresh-install') throw new Error('real bootstrap fresh-install evidence is required')
  if (document.claims_previous_stable_upgrade !== false) throw new Error('bootstrap evidence must not claim a previous-Stable upgrade')
  const target = requireBoundedString(document.target, 'target', 64)
  const contract = TARGET_CONTRACTS[target]
  if (!contract) throw new Error(`unsupported bootstrap evidence target: ${target}`)
  requireContract(document.runner, contract.runner, 'runner contract')
  requireContract(document.platform, contract.platform, 'platform contract')
  if (target.startsWith('darwin-')) {
    if (typeof document.platform.signing_credentials_configured !== 'boolean') throw new Error('macOS signing credential observation is required')
    const expected = document.platform.signing_credentials_configured ? 'verified' : 'not-configured'
    if (document.platform.code_signing !== expected || document.platform.notarization !== expected) throw new Error('platform contract mismatch for macOS signing/notarization')
  }

  const candidate = requireObject(document.candidate, 'candidate')
  for (const field of ['tag', 'version', 'commit', 'manifest_sha256']) {
    if (candidate[field] !== expectations[field]) throw new Error(`candidate ${field.replace('_sha256', '')} does not match`)
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.version) || candidate.tag.replace(/^v/, '') !== candidate.version) {
    throw new Error('candidate tag and version must identify one stable semantic version')
  }
  if (!COMMIT.test(candidate.commit)) throw new Error('candidate commit must be a 40-character lowercase Git commit')
  for (const field of ['manifest_sha256', 'package_sha256', 'signature_sha256']) {
    if (!SHA256.test(candidate[field])) throw new Error(`candidate ${field} must be lowercase SHA-256`)
  }
  const expectedProvenance = document.evidence_kind === 'bootstrap-fresh-install' ? 'published-release' : 'local-fixture'
  if (candidate.provenance !== expectedProvenance) throw new Error('bootstrap evidence provenance does not match evidence_kind')
  requirePublishedReleaseUrl(candidate.release_url, candidate.tag)
  requireImmutableManifestUrl(candidate.manifest_url, candidate)
  requireImmutablePackageUrl(candidate.package_url, candidate.version, target, candidate.package_sha256)

  const installation = requireObject(document.installation, 'installation')
  if (installation.mode !== 'fresh-install' || installation.launched !== true) throw new Error('bootstrap requires a successful fresh install and launch')
  if (installation.installed_version !== candidate.version) throw new Error('installed version does not match candidate')

  const startedAt = new Date(document.started_at)
  const completedAt = new Date(document.completed_at)
  const now = expectations.now instanceof Date ? expectations.now : new Date()
  if (Number.isNaN(startedAt.valueOf()) || Number.isNaN(completedAt.valueOf())) throw new Error('bootstrap evidence timestamps must be RFC 3339 values')
  if (completedAt < startedAt || completedAt.valueOf() - startedAt.valueOf() > MAX_RUN_MILLISECONDS) throw new Error('bootstrap evidence duration exceeds the allowed native run window')
  if (completedAt.valueOf() > now.valueOf() + CLOCK_SKEW_MILLISECONDS) throw new Error('bootstrap evidence completed in the future')
  if (now.valueOf() - completedAt.valueOf() > expectations.maxAgeHours * 60 * 60 * 1000) throw new Error('bootstrap evidence is stale')

  const observations = requireObject(document.observations, 'observations')
  for (const observation of OBSERVATIONS) {
    if (observations[observation] !== true) throw new Error(`required bootstrap observation did not pass: ${observation}`)
  }
  requireContract(document.observation_sources, OBSERVATION_SOURCES, 'observation_sources')
  if (document.diagnostics !== undefined) requireSafeText(document.diagnostics, 'bootstrap diagnostics')
  return target
}

/** 验证一份 bootstrap evidence，供 producer 落盘前复用。 */
export function verifyBootstrapUpdateEvidenceDocument(document, expectations) {
  if (!expectations || !Number.isFinite(expectations.maxAgeHours) || expectations.maxAgeHours <= 0) throw new Error('a positive maxAgeHours is required')
  return verifyDocument(document, expectations)
}

/** 验证严格且唯一的四目标 bootstrap evidence 集。 */
export function verifyBootstrapUpdateEvidenceSet(documents, expectations) {
  if (!Array.isArray(documents)) throw new Error('bootstrap evidence set must be an array')
  if (!expectations || !Number.isFinite(expectations.maxAgeHours) || expectations.maxAgeHours <= 0) throw new Error('a positive maxAgeHours is required')
  const targets = documents.map(document => verifyDocument(document, expectations))
  if (new Set(targets).size !== targets.length) throw new Error('duplicate bootstrap evidence target')
  if (targets.length !== REQUIRED_BOOTSTRAP_TARGETS.length || REQUIRED_BOOTSTRAP_TARGETS.some(target => !targets.includes(target))) {
    throw new Error('bootstrap evidence targets do not exactly match the required four-target contract')
  }
  const manifestUrls = documents.map(document => document.candidate.manifest_url)
  if (new Set(manifestUrls).size !== 1) throw new Error('bootstrap evidence does not share one immutable candidate manifest URL')
  return Object.freeze({
    schemaVersion: 1,
    targets: REQUIRED_BOOTSTRAP_TARGETS,
    candidate: Object.freeze({ tag: expectations.tag, version: expectations.version, commit: expectations.commit, manifest_sha256: expectations.manifest_sha256 })
  })
}

/** 验证 evidence 目录的严格文件名、大小和逐字节 checksum。 */
export async function verifyBootstrapUpdateEvidenceDirectory(directory, expectations) {
  const entries = await readdir(directory, { withFileTypes: true })
  const expectedNames = REQUIRED_BOOTSTRAP_TARGETS.flatMap(target => [`${target}.json`, `${target}.json.sha256`]).sort()
  const names = entries.map(entry => entry.name).sort()
  if (entries.some(entry => !entry.isFile()) || JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error('bootstrap evidence directory contains missing or unexpected entries')
  const documents = []
  for (const target of REQUIRED_BOOTSTRAP_TARGETS) {
    const evidencePath = path.join(directory, `${target}.json`)
    const fileStat = await stat(evidencePath)
    if (fileStat.size <= 0 || fileStat.size > MAX_EVIDENCE_BYTES) throw new Error('bootstrap evidence file exceeds the allowed bound')
    const [body, checksum] = await Promise.all([readFile(evidencePath), readFile(`${evidencePath}.sha256`, 'utf8')])
    const expectedChecksum = `${createHash('sha256').update(body).digest('hex')}  ${target}.json\n`
    if (checksum !== expectedChecksum) throw new Error(`bootstrap evidence checksum mismatch for ${target}`)
    try { documents.push(JSON.parse(body.toString('utf8'))) } catch { throw new Error(`bootstrap evidence is not valid JSON for ${target}`) }
  }
  return verifyBootstrapUpdateEvidenceSet(documents, expectations)
}

/** 解析严格的 CLI 参数对及 boolean flag。 */
function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    if (name === '--require-real-bootstrap') values.requireRealBootstrap = true
    else {
      const value = args[++index]
      if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid bootstrap evidence argument: ${name ?? ''}`)
      values[name.slice(2)] = value
    }
  }
  return values
}

/** 校验 CLI 参数并验证 bootstrap evidence artifact 目录。 */
export async function runBootstrapUpdateEvidenceCli(args = process.argv.slice(2), now = new Date()) {
  const values = parseArguments(args)
  for (const name of ['evidence', 'candidate-tag', 'candidate-commit', 'manifest-sha256', 'max-age-hours']) {
    if (!values[name]) throw new Error(`--${name} is required`)
  }
  const tagMatch = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(values['candidate-tag'])
  if (!tagMatch) throw new Error('--candidate-tag must be a stable semantic version tag')
  const version = values['candidate-tag'].replace(/^v/, '')
  return verifyBootstrapUpdateEvidenceDirectory(values.evidence, {
    tag: values['candidate-tag'], version, commit: values['candidate-commit'], manifest_sha256: values['manifest-sha256'],
    maxAgeHours: Number(values['max-age-hours']), requireRealBootstrap: values.requireRealBootstrap === true, now
  })
}

/** 执行 verifier CLI，只输出候选摘要。 */
async function main() {
  const result = await runBootstrapUpdateEvidenceCli()
  console.log(`Verified bootstrap update evidence v${result.schemaVersion} for ${result.candidate.tag} (${result.targets.length} native targets)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
