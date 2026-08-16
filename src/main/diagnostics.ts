import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { LifecycleSnapshot } from '../shared/startup-contract.js'

export const DEFAULT_LOG_FILE_COUNT = 5
export const DEFAULT_LOG_FILE_BYTES = 5 * 1024 * 1024

export interface DiagnosticContext {
  readonly appVersion: string
  readonly electronVersion: string
  readonly nodeVersion: string
  readonly platform: NodeJS.Platform
  readonly arch: string
}

export interface DiagnosticsSink {
  lifecycle(snapshot: LifecycleSnapshot): void
  assignedPort(port: number): void
  navigationRejected(target: string, decision: string): void
  failure(area: string, error: unknown): void
  actionFailure(action: string, error: unknown): void
}

export class NullDiagnostics implements DiagnosticsSink {
  lifecycle(): void {}
  assignedPort(): void {}
  navigationRejected(): void {}
  failure(): void {}
  actionFailure(): void {}
}

interface RollingDiagnosticsOptions {
  readonly maxFiles?: number
  readonly maxBytes?: number
  readonly now?: () => Date
}

/** A small allowlist logger: callers cannot submit request bodies or arbitrary objects. */
export class RollingDiagnostics implements DiagnosticsSink {
  readonly filePath: string
  readonly #maxFiles: number
  readonly #maxBytes: number
  readonly #now: () => Date
  #startedAt = Date.now()
  #queue: Promise<void> = Promise.resolve()

  constructor(logDirectory: string, context: DiagnosticContext, options: RollingDiagnosticsOptions = {}) {
    this.filePath = path.join(logDirectory, 'desktop.log')
    this.#maxFiles = options.maxFiles ?? DEFAULT_LOG_FILE_COUNT
    this.#maxBytes = options.maxBytes ?? DEFAULT_LOG_FILE_BYTES
    this.#now = options.now ?? (() => new Date())
    this.#write('application', {
      appVersion: context.appVersion,
      electronVersion: context.electronVersion,
      nodeVersion: context.nodeVersion,
      platform: context.platform,
      arch: context.arch
    })
  }

  lifecycle(snapshot: LifecycleSnapshot): void {
    const elapsedMs = Math.max(0, Date.now() - this.#startedAt)
    if (snapshot.state === 'retrying') this.#startedAt = Date.now()
    this.#write('lifecycle', { state: snapshot.state, elapsedMs })
  }
  assignedPort(port: number): void { this.#write('host-listener', { host: '127.0.0.1', port }) }
  navigationRejected(target: string, decision: string): void {
    this.#write('navigation-rejected', { decision, target: redactUrl(target) })
  }
  failure(area: string, error: unknown): void {
    this.#write('failure', { area: safeLabel(area), stack: redactException(error) })
  }
  actionFailure(action: string, error: unknown): void {
    this.#write('action-failure', { action: safeLabel(action), stack: redactException(error) })
  }
  async flush(): Promise<void> { await this.#queue }

  #write(event: string, details: Record<string, string | number>): void {
    const entry = `${JSON.stringify({ time: this.#now().toISOString(), event, ...details })}\n`
    this.#queue = this.#queue.then(() => appendRotating(this.filePath, entry, this.#maxFiles, this.#maxBytes)).catch(() => undefined)
  }
}

export function buildRedactedDiagnosticSummary(snapshot: LifecycleSnapshot, context: DiagnosticContext): string {
  const summaries: Record<LifecycleSnapshot['state'], string> = {
    idle: 'Waiting to start.',
    preparing: 'Preparing application data.',
    booting: 'Starting the local Host.',
    probing: 'Checking the local Web Client.',
    ready: 'The Web Client is ready.',
    failed: 'Startup failed. Retry or share the log files for help.',
    retrying: 'Cleaning up before a fresh startup attempt.',
    stopping: 'Stopping the local Host.',
    stopped: 'The local Host is stopped.'
  }
  return [
    'DeepSeek Harness Desktop diagnostics',
    `App: ${safeVersion(context.appVersion)}`,
    `Electron: ${safeVersion(context.electronVersion)}`,
    `Node: ${safeVersion(context.nodeVersion)}`,
    `Platform: ${safeLabel(context.platform)} ${safeLabel(context.arch)}`,
    `State: ${snapshot.state}`,
    `Summary: ${summaries[snapshot.state]}`
  ].join('\n').slice(0, 1_024)
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, match => redactUrl(match))
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/["']?\b(api[_-]?key|token|secret|password|authorization|cookie)\b["']?\s*[:=]\s*["']?([^\s,;}"']+)/gi, '$1=[redacted]')
    .replace(/([?&](?:key|token|secret|password|code)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/\b(prompt|conversation|messages?|tool[_-]?(?:payload|input|output)|request[_-]?body|file[_-]?contents?)\b\s*[:=]\s*[^\n]*/gi, '$1=[redacted]')
    .replace(/^\s*(?:[A-Z][A-Z0-9_]{2,})\s*=.*$/gm, '[environment value redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[private key redacted]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[credential redacted]')
    .slice(0, 8_192)
}

function redactException(error: unknown): string {
  if (!(error instanceof Error)) return '[non-error failure redacted]'
  const frames = (error.stack ?? '').split('\n').slice(1).filter(line => /^\s*at\s/.test(line))
  return redactDiagnosticText([`${safeLabel(error.name)}: [message redacted]`, ...frames].join('\n'))
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin
    return `${parsed.protocol}[location redacted]`
  } catch { return '[invalid URL redacted]' }
}

function safeLabel(value: string): string { return /^[\w .:/-]{1,80}$/.test(value) ? value : '[redacted]' }
function safeVersion(value: string): string { return /^[0-9A-Za-z.+-]{1,40}$/.test(value) ? value : '[redacted]' }

async function appendRotating(filePath: string, entry: string, maxFiles: number, maxBytes: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const bytes = Buffer.byteLength(entry)
  const currentBytes = await stat(filePath).then(value => value.size, () => 0)
  if (currentBytes > 0 && currentBytes + bytes > maxBytes) await rotate(filePath, maxFiles)
  const handle = await open(filePath, 'a', 0o600)
  try { await handle.writeFile(entry, 'utf8') } finally { await handle.close() }
}

async function rotate(filePath: string, maxFiles: number): Promise<void> {
  if (maxFiles <= 1) { await unlink(filePath).catch(() => undefined); return }
  await unlink(`${filePath}.${maxFiles - 1}`).catch(() => undefined)
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    await rename(`${filePath}.${index}`, `${filePath}.${index + 1}`).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
  await rename(filePath, `${filePath}.1`).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}
