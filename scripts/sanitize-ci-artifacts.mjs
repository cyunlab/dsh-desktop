import { lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_CANDIDATES = Object.freeze([
  'artifacts/typecheck.log',
  'artifacts/unit.log',
  'artifacts/integration.log',
  'artifacts/e2e.log'
])
const DEFAULT_MAX_FILES = 8
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1024 * 1024
const TRUNCATED = '\n[artifact truncated at sanitizer byte limit]\n'

/** 清除 CI 文本中的凭据、用户内容和精确 URL 位置。 */
export function redactCiText(value) {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[private key redacted]')
    .replace(/\bhttps?:\/\/[^\s<>"')]+/gi, redactHttpUrl)
    .replace(/\b(?:Authorization|Proxy-Authorization)\s*:\s*[^\r\n]*/gi, 'Authorization: [redacted]')
    .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]*/gi, 'Cookie: [redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/(["']\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|cookie|session)\b["']\s*:\s*)(["'])(?:\\.|(?!\2)[\s\S])*?\2/gi, '$1[redacted]')
    .replace(/(["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|cookie|session)\b["']?\s*[:=]\s*)(["']?)[^\s,;}&\]"']+\2/gi, '$1[redacted]')
    .replace(/(--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|client[_-]?secret|password)(?:=|\s+))\S+/gi, '$1[redacted]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[credential redacted]')
    .replace(/\b(?:request|response)[_-]?body\b\s*[:=]?[^\r\n]*/gi, 'request-body=[redacted]')
    .replace(/\b(?:prompt|conversation|messages?|tool[_-]?(?:payload|input|output)|file[_-]?contents?)\b\s*[:=]?[^\r\n]*/gi, 'sensitive-content=[redacted]')
    .replace(/^\s*[A-Z][A-Z0-9_]{2,}\s*=.*$/gm, '[environment value redacted]')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*$/gi, '[private key redacted]')
}

/** 仅保留 HTTP URL 的公开 origin。 */
function redactHttpUrl(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    const hasLocation = url.pathname !== '/' || url.search || url.hash
    return hasLocation ? `${url.origin}/[location redacted]` : `${url.origin}/`
  } catch {
    return '[URL redacted]'
  }
}

/** 读取白名单诊断文件并输出受大小限制的脱敏副本。 */
export async function sanitizeArtifactDirectory(options = {}) {
  const workspace = path.resolve(options.workspace ?? '.')
  const canonicalWorkspace = await realpath(workspace)
  const outputDirectory = path.resolve(canonicalWorkspace, options.outputDirectory ?? 'sanitized-artifacts')
  if (!isInside(canonicalWorkspace, outputDirectory)) throw new Error('output directory must be inside the workspace')
  const candidates = options.candidates ?? DEFAULT_CANDIDATES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
  validateLimits(maxFiles, maxFileBytes, maxTotalBytes)

  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
  if (!isInside(canonicalWorkspace, await realpath(outputDirectory))) throw new Error('output directory escaped the workspace')
  const files = []
  const omitted = []
  let totalBytes = 0

  for (const candidate of candidates) {
    if (files.length >= maxFiles) { omitted.push(candidate); continue }
    const source = await safeCandidate(canonicalWorkspace, candidate).catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (!source) continue
    const available = maxTotalBytes - totalBytes
    if (available <= 0) { omitted.push(candidate); continue }
    const limit = Math.min(maxFileBytes, available)
    const raw = await readBounded(source.path, source.identity, limit).catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    if (!raw) continue
    const sanitized = redactCiText(raw.text) + (raw.truncated ? TRUNCATED : '')
    const bounded = Buffer.from(sanitized).subarray(0, limit).toString('utf8')
    const outputName = `${String(files.length + 1).padStart(2, '0')}-${path.basename(candidate)}`
    await writeFile(path.join(outputDirectory, outputName), bounded, { encoding: 'utf8', mode: 0o600 })
    const bytes = Buffer.byteLength(bounded)
    totalBytes += bytes
    files.push({ source: candidate, output: outputName, bytes, truncated: raw.truncated || bytes < Buffer.byteLength(sanitized) })
  }

  return { files, omitted, totalBytes }
}

/** 验证候选日志位于工作区且不是符号链接。 */
async function safeCandidate(workspace, candidate) {
  if (path.extname(candidate) !== '.log') throw new Error(`artifact is not allowlisted text: ${candidate}`)
  const resolved = path.resolve(workspace, candidate)
  if (!isInside(workspace, resolved)) throw new Error(`artifact escapes workspace: ${candidate}`)
  const identity = await lstat(resolved)
  if (identity.isSymbolicLink()) throw new Error(`artifact must not be a symbolic link: ${candidate}`)
  if (!identity.isFile()) throw new Error(`artifact must be a regular file: ${candidate}`)
  const canonical = await realpath(resolved)
  if (!isInside(workspace, canonical)) throw new Error(`artifact resolves outside workspace: ${candidate}`)
  return { path: resolved, identity }
}

/** 在文件身份不变的前提下读取有限字节。 */
async function readBounded(file, expected, limit) {
  const noFollow = process.platform !== 'win32' && typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const handle = await open(file, fsConstants.O_RDONLY | noFollow)
  try {
    const actual = await handle.stat()
    if (!actual.isFile()) throw new Error(`artifact changed to a non-regular file before read: ${file}`)
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error(`artifact changed before read: ${file}`)
    const buffer = Buffer.alloc(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return { text: buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8'), truncated: bytesRead > limit }
  } finally {
    await handle.close()
  }
}

/** 判断目标是否严格位于根目录内。 */
function isInside(root, target) {
  return target.startsWith(`${root}${path.sep}`)
}

/** 验证所有诊断产物限制均为正安全整数。 */
function validateLimits(maxFiles, maxFileBytes, maxTotalBytes) {
  for (const [name, value] of Object.entries({ maxFiles, maxFileBytes, maxTotalBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await sanitizeArtifactDirectory()
  process.stdout.write(`sanitized ${result.files.length} textual diagnostic files (${result.totalBytes} bytes)\n`)
}
