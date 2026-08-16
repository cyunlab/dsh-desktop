import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflowPath = '.github/workflows/test.yml'

async function workflow(): Promise<string> {
  return readFile(workflowPath, 'utf8')
}

describe('manual Desktop behavior workflow', () => {
  it('pins every third-party action to a reviewed commit with an exact version comment', async () => {
    const contents = await workflow()
    const uses = [...contents.matchAll(/^\s*uses:\s+(\S+?@\S+)(?:\s+#\s+(\S+))?\s*$/gm)]
    expect(uses).toHaveLength(4)
    expect(uses.map(match => `${match[1]} # ${match[2]}`)).toEqual([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
      'pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1'
    ])
    for (const match of uses) {
      expect(match[1]).toMatch(/@[0-9a-f]{40}$/)
      expect(match[2]).toMatch(/^v\d+\.\d+\.\d+$/)
    }
    expect(contents).not.toMatch(/^\s*uses:\s+\S+@(?:v\d+|main|master)\s*$/m)
  })

  it('has workflow_dispatch as its only trigger', async () => {
    const contents = await workflow()
    const triggerBlock = contents.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1]
    expect(triggerBlock).toBe('  workflow_dispatch:\n')
    expect(contents).not.toMatch(/^\s+(?:push|pull_request):/m)
  })

  it('uses an exact toolchain, frozen install, cache, and read-only submodule guard', async () => {
    const contents = await workflow()
    expect(contents).toContain('submodules: recursive')
    expect(contents).toContain('persist-credentials: false')
    expect(contents).toContain('version: 11.7.0')
    expect(contents).toContain('node-version: 24')
    expect(contents).toContain('cache: pnpm')
    expect(contents).toContain('pnpm install --frozen-lockfile')
    expect(contents).toContain('git -C deepseek-harness status --porcelain')
    expect(contents).toContain('git diff --exit-code --submodule=short -- deepseek-harness')
  })

  it('runs every behavior layer in a non-fail-fast three-platform matrix', async () => {
    const contents = await workflow()
    expect(contents).toContain('fail-fast: false')
    expect(contents).toContain('os: ubuntu-24.04')
    expect(contents).toContain('os: macos-14')
    expect(contents).toContain('os: windows-2022')
    expect(contents).toContain('pnpm typecheck')
    expect(contents).toContain('pnpm test 2>&1')
    expect(contents).toContain('pnpm test:integration')
    expect(contents).toContain('pnpm test:e2e 2>&1')
    expect(contents).toContain('pnpm test:e2e:xvfb')
  })

  it('retains bounded diagnostics without building installer artifacts', async () => {
    const contents = await workflow()
    expect(contents).toMatch(/if: always\(\)\n        uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+/)
    expect(contents).toContain('node scripts/sanitize-ci-artifacts.mjs')
    expect(contents).toContain('path: sanitized-artifacts/')
    expect(contents).not.toMatch(/^\s+path: (?:artifacts|test-results)\//m)
    expect(contents).toContain('retention-days: 7')
    expect(contents).not.toMatch(/pnpm (?:package|build)|electron-builder/)
  })
})
