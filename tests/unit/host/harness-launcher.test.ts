import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveRuntimeManifestPath } from '../../../src/main/host/harness-launcher.js'
import { resolveHostEntry } from '../../../src/main/host/process-launcher.js'

describe('packaged Host process paths', () => {
  it('maps an ASAR manifest URL to the unpacked runtime tree', () => {
    const root = path.parse(process.cwd()).root
    const archiveManifest = path.join(
      root, 'Applications', 'deepseek-harness-desktop.app', 'Contents', 'Resources',
      'app.asar', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'
    )
    const unpackedManifest = path.join(
      root, 'Applications', 'deepseek-harness-desktop.app', 'Contents', 'Resources',
      'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'
    )

    expect(resolveRuntimeManifestPath(pathToFileURL(archiveManifest).href)).toBe(unpackedManifest)
  })

  it('resolves a child entry outside the main bundle directory', () => {
    expect(resolveHostEntry()).toMatch(/[\\/]host-process[\\/]index\.js$/)
  })
})
