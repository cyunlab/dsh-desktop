import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { expectedNativeShutdownDisconnect, shouldUseCliFixture } from '../../scripts/run-e2e.mjs'

/** 创建 generation-bound shutdown 证明文件与 WDIO deleteSession 结果。 */
async function shutdownProofFixture(): Promise<{
  root: string
  environment: NodeJS.ProcessEnv & { DSH_TEST_COMPLETION_FILE: string; DSH_TEST_RECORD_FILE: string }
  result: { status: number; error?: Error; stdout: string; stderr: string }
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-e2e-shutdown-proof-'))
  const completion = path.join(root, 'complete.json')
  const records = path.join(root, 'records.jsonl')
  await writeFile(completion, JSON.stringify({ status: 'passed', generation: 7 }))
  await writeFile(records, [
    { event: 'backend-started', pid: 2_147_483_647 },
    { event: 'cli-spawned', generation: 7, pid: 2_147_483_646 },
    { event: 'native-shutdown-requested', generation: 7, source: 'close-requested' },
    { event: 'cli-cleaned', generation: 7 },
    { event: 'native-shutdown-completed', generation: 7, cleanupSucceeded: true }
  ].map(value => JSON.stringify(value)).join('\n'))
  return {
    root,
    environment: { ...process.env, DSH_TEST_COMPLETION_FILE: completion, DSH_TEST_RECORD_FILE: records },
    result: {
      status: 1,
      stdout: [
        'ERROR diagnostics: Tauri Driver: tauri-driver not found. Install it with: cargo install tauri-driver',
        '[0-0] ERROR webdriver: WebDriverError: Request failed with error code ECONNREFUSED when running "execute/sync" with method "POST"',
        '[0-0] ERROR webdriver: WebDriverError: Request failed with error code ECONNREFUSED when running "http://127.0.0.1:4445/session/example" with method "DELETE"',
        '[0-0] ERROR @wdio/local-runner: Failed launching test session: Error: WebDriverError: Request failed with error code ECONNREFUSED when running "http://127.0.0.1:4445/session/example" with method "DELETE"'
      ].join('\n'),
      stderr: ''
    }
  }
}

describe('E2E shutdown disconnect proof', () => {
  it('accepts only the generation-bound deleteSession backend disconnect', async () => {
    const fixture = await shutdownProofFixture()
    try {
      await expect(expectedNativeShutdownDisconnect(fixture.environment, fixture.result as never)).resolves.toBe(true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an arbitrary WDIO error even when cleanup evidence exists', async () => {
    const fixture = await shutdownProofFixture()
    try {
      fixture.result.stdout += '\n[0-0] ERROR webdriver: AssertionError: expected false to be true'
      await expect(expectedNativeShutdownDisconnect(fixture.environment, fixture.result as never)).resolves.toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('E2E CLI selection', () => {
  it('uses the deterministic fixture for real-harness behavior on Windows', () => {
    expect(shouldUseCliFixture('real-harness', 'win32')).toBe(true)
  })

  it('keeps the official CLI real-harness coverage on Linux and macOS', () => {
    expect(shouldUseCliFixture('real-harness', 'linux')).toBe(false)
    expect(shouldUseCliFixture('real-harness', 'darwin')).toBe(false)
  })

  it('uses the fixture for synthetic lifecycle scenarios on every platform', () => {
    expect(shouldUseCliFixture('retry', 'win32')).toBe(true)
    expect(shouldUseCliFixture('retry', 'linux')).toBe(true)
  })
})
