import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareDesktopPaths, selectDesktopPaths } from '../../src/main/paths.js'
import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'

describe('desktop paths', () => {
  it('selects isolated deterministic directories and preserves spaces', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'Desktop User With Spaces '))
    const logs = path.join(root, 'Platform Logs')
    const selected = selectDesktopPaths({ getPath: name => name === 'userData' ? root : logs })
    expect(selected).toEqual({
      harnessHome: path.join(root, 'deepseek-harness-desktop', 'harness-home'),
      defaultWorkingDirectory: path.join(root, 'deepseek-harness-desktop', 'default-working-directory'),
      logs
    })
    await prepareDesktopPaths(selected)
    await expect(Promise.all(Object.values(selected).map(value => stat(value)))).resolves.toHaveLength(3)
  })
})
