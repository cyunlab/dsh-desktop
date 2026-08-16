import { readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('production main bundle', () => {
  it('statically excludes every environment-controlled E2E capability', async () => {
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    const artifacts = await readdir('dist/main', { recursive: true })
    expect(artifacts).toEqual(['index.js'])
    for (const artifact of artifacts) {
      const contents = await readFile(`dist/main/${artifact}`, 'utf8')
      expect(contents).not.toMatch(/DSH_DESKTOP_TEST_(?:HOST|FAILURES|USER_DATA|EVENTS)/)
      expect(contents).not.toContain('Synthetic Host startup failure')
      expect(contents).not.toContain('shouldSuppressExternalOpen')
    }
  }, 15_000)
})
