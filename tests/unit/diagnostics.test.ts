import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRedactedDiagnosticSummary, redactDiagnosticText, RollingDiagnostics, type DiagnosticContext } from '../../src/main/diagnostics.js'

const context: DiagnosticContext = {
  appVersion: '0.1.0', electronVersion: '43.4.0', nodeVersion: '24.1.0', platform: 'linux', arch: 'x64'
}

describe('desktop diagnostics', () => {
  it('records version, platform, lifecycle timing, and assigned loopback port facts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dsh diagnostic facts '))
    const logger = new RollingDiagnostics(directory, context)
    logger.lifecycle({ state: 'booting', message: 'must not be persisted' })
    logger.assignedPort(43210)
    await logger.flush()
    const contents = await readFile(path.join(directory, 'desktop.log'), 'utf8')
    expect(contents).toContain('"appVersion":"0.1.0"')
    expect(contents).toContain('"platform":"linux"')
    expect(contents).toMatch(/"state":"booting","elapsedMs":\d+/)
    expect(contents).toContain('"host":"127.0.0.1","port":43210')
    expect(contents).not.toContain('must not be persisted')
  })

  it('redacts secrets, URL queries, environment values, and content-like payloads', () => {
    const redacted = redactDiagnosticText([
      'GET https://example.test/path?token=top-secret&x=1',
      'Authorization: Bearer credential-value',
      'api_key=hidden-value password: hunter2',
      'OPENAI_API_KEY=environment-secret',
      'prompt: private conversation text',
      'request_body={"secret":"payload"}',
      'https://user:password@example.test/private?code=oauth-secret',
      'secret_json={"token":"json-secret"}'
    ].join('\n'))
    expect(redacted).not.toMatch(/top-secret|credential-value|hidden-value|hunter2|environment-secret|private conversation|"payload"|oauth-secret|json-secret|user:password/)
    expect(redacted).toContain('https://example.test')
    expect(redacted).not.toContain('/path')
    expect(redacted).not.toContain('?')
  })

  it('copies only a bounded allowlisted summary, never snapshot message or origin', () => {
    const summary = buildRedactedDiagnosticSummary(Object.freeze({
      state: 'failed',
      message: 'Authorization: Bearer arbitrary-exception-secret',
      origin: 'http://127.0.0.1:1234/?token=secret'
    }), context)
    expect(summary).toContain('State: failed')
    expect(summary).toContain('Startup failed.')
    expect(summary).not.toMatch(/token|secret|Bearer|127\.0\.0\.1/)
    expect(summary.length).toBeLessThanOrEqual(1_024)
  })

  it('writes allowlisted context and keeps at most five bounded rolling files', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dsh diagnostic logs '))
    const logger = new RollingDiagnostics(directory, context, { maxFiles: 5, maxBytes: 300 })
    for (let index = 0; index < 30; index += 1) {
      logger.navigationRejected(`https://example.test/path?token=secret-${index}`, 'external')
    }
    logger.failure('host-startup', new Error('Authorization: Bearer private-token\nprompt: private words'))
    await logger.flush()

    const files = (await readdir(directory)).filter(file => file.startsWith('desktop.log'))
    expect(files.length).toBeLessThanOrEqual(5)
    const contents = (await Promise.all(files.map(file => readFile(path.join(directory, file), 'utf8')))).join('\n')
    expect(contents).toMatch(/navigation-rejected|host-startup/)
    expect(contents).not.toMatch(/secret-\d|private-token|private words/)
    for (const file of files) expect((await stat(path.join(directory, file))).size).toBeLessThanOrEqual(500)
  })
})
