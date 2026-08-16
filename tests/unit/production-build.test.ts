import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('production main bundle', () => {
  it('statically excludes every environment-controlled E2E capability', async () => {
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    const main = await readFile('dist/main/index.js', 'utf8')
    expect(main).not.toMatch(/DSH_DESKTOP_TEST_(?:HOST|FAILURES|USER_DATA|EVENTS)/)
    expect(main).not.toContain('Synthetic Host startup failure')
    expect(main).not.toContain('shouldSuppressExternalOpen')
  }, 15_000)
})
