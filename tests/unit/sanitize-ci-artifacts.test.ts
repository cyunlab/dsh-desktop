import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { redactCiText, sanitizeArtifactDirectory } from '../../scripts/sanitize-ci-artifacts.mjs'

describe('CI artifact sanitizer', () => {
  it('redacts credentials, headers, cookies, URL secrets, environment values, JWTs, and private keys', () => {
    const secrets = [
      'Authorization: Bearer bearer-secret-value',
      'Cookie: session=browser-secret; theme=dark',
      'https://alice:password@example.test/private?token=query-secret&safe=no#fragment-secret',
      'api_key=json-secret',
      '"client_secret":"quoted secret with spaces and punctuation!"',
      '--access-token cli-secret',
      'PASSWORD=environment-secret',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature-secret',
      '-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----'
    ].join('\n')
    const result = redactCiText(secrets)
    for (const secret of ['bearer-secret', 'browser-secret', 'password@', 'query-secret', 'fragment-secret', 'json-secret', 'quoted secret', 'cli-secret', 'environment-secret', 'signature-secret', 'private-key-material']) {
      expect(result).not.toContain(secret)
    }
    expect(result).toContain('https://example.test/[location redacted]')
    expect(result).toContain('[credential redacted]')
  })

  it('copies only allowlisted text into a separate bounded directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ci-artifact-sanitizer-'))
    await mkdir(path.join(root, 'artifacts'))
    await mkdir(path.join(root, 'test-results'))
    await writeFile(path.join(root, 'artifacts', 'unit.log'), `useful failure\ntoken=${'s'.repeat(80)}\n${'x'.repeat(500)}`)
    await writeFile(path.join(root, 'test-results', 'trace.zip'), Buffer.from([0, 1, 2, 3]))

    const result = await sanitizeArtifactDirectory({
      workspace: root,
      candidates: ['artifacts/unit.log'],
      maxFiles: 1,
      maxFileBytes: 128,
      maxTotalBytes: 128
    })
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.truncated).toBe(true)
    expect(result.totalBytes).toBeLessThanOrEqual(128)
    const output = await readFile(path.join(root, 'sanitized-artifacts', result.files[0]!.output), 'utf8')
    expect(output).toContain('useful failure')
    expect(output).not.toContain('s'.repeat(20))
    await expect(readFile(path.join(root, 'sanitized-artifacts', 'trace.zip'))).rejects.toThrow()
  })

  it('rejects non-text and path-traversal candidates', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ci-artifact-sanitizer-'))
    await expect(sanitizeArtifactDirectory({ workspace: root, candidates: ['test-results/trace.zip'] }))
      .rejects.toThrow('not allowlisted text')
    await expect(sanitizeArtifactDirectory({ workspace: root, candidates: ['../outside.log'] }))
      .rejects.toThrow('escapes workspace')
    await expect(sanitizeArtifactDirectory({ workspace: root, outputDirectory: '..' }))
      .rejects.toThrow('inside the workspace')
  })

  it('caps the number and total size of emitted files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ci-artifact-sanitizer-'))
    await mkdir(path.join(root, 'artifacts'))
    await Promise.all(['unit.log', 'integration.log', 'e2e.log'].map(name => writeFile(path.join(root, 'artifacts', name), 'diagnostic\n'.repeat(20))))
    const result = await sanitizeArtifactDirectory({
      workspace: root,
      candidates: ['artifacts/unit.log', 'artifacts/integration.log', 'artifacts/e2e.log'],
      maxFiles: 2,
      maxFileBytes: 100,
      maxTotalBytes: 150
    })
    expect(result.files).toHaveLength(2)
    expect(result.omitted).toEqual(['artifacts/e2e.log'])
    expect(result.totalBytes).toBeLessThanOrEqual(150)
  })
})
