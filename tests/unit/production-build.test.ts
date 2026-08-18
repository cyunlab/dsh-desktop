import { access, readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const desktopLogoFileName = 'dsh-desktop-logo.svg'

describe('production main bundle', () => {
  it('keeps one source logo and emits the runtime PNG from it', async () => {
    const sourceAssets = await readdir('assets', { recursive: true })
    expect(sourceAssets).toContain(desktopLogoFileName)
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { build: { icon: string } }
    expect(packageJson.build.icon).toBe(`assets/${desktopLogoFileName}`)

    const result = spawnSync(process.execPath, ['scripts/build.mjs'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    await expect(access(`dist/assets/${desktopLogoFileName}`)).resolves.toBeUndefined()
    await expect(access(`dist/assets/${desktopLogoFileName.replace('.svg', '.png')}`)).resolves.toBeUndefined()
    expect(await readFile('dist/startup/index.html', 'utf8')).toContain(`../assets/${desktopLogoFileName}`)
  }, 15_000)

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
