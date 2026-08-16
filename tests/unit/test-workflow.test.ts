import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const workflowPath = '.github/workflows/test.yml'

async function workflow(): Promise<string> {
  return readFile(workflowPath, 'utf8')
}

describe('manual Desktop behavior workflow', () => {
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
    expect(contents).toContain('if: always()\n        uses: actions/upload-artifact@v6')
    expect(contents).toContain('artifacts/')
    expect(contents).toContain('test-results/')
    expect(contents).toContain('retention-days: 7')
    expect(contents).not.toMatch(/pnpm (?:package|build)|electron-builder/)
  })
})
