import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HarnessHostLauncher } from '../../src/main/harness-host-launcher.js'

describe('Harness Host launcher', () => {
  it('sets process paths before loading Harness, composes official bundles, and restores on dispose', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'DSH Desktop Launcher '))
    const paths = {
      harnessHome: path.join(root, 'Harness Home'),
      fallbackWorkspace: path.join(root, 'Fallback Workspace'),
      logs: path.join(root, 'Logs')
    }
    await Promise.all(Object.values(paths).map(directory => mkdir(directory, { recursive: true })))
    const originalHome = process.env.DSH_HOME
    const originalCwd = process.cwd()
    const dispose = vi.fn(async () => undefined)
    const profileDir = path.join(paths.harnessHome, 'profiles', 'desktop')
    const initProfile = vi.fn(() => mkdirSync(profileDir, { recursive: true }))
    const provideCmdline = vi.fn()
    const boot = vi.fn(async (_name, _config, _patches, prepare) => {
      const hostCtx = { provide: vi.fn() }
      await prepare?.(hostCtx as never)
      return { webServer: { host: '127.0.0.1', port: 43210 }, fiber: { dispose } } as never
    })
    const launchEnvironment = Object.freeze({ get: vi.fn(), getFrom: vi.fn() })
    const loadProfile = vi.fn(() => ({
      name: 'desktop',
      dir: profileDir,
      patchPath: path.join(profileDir, 'cordis.patch.yml'),
      layers: [
        { packageName: '@deepseek-ai/dsh-base', packageDir: '/base', patchPath: '/base/cordis.patch.yml', patches: [{ insert: [] }] },
        { packageName: '@deepseek-ai/dsh-web-app', packageDir: '/web', patchPath: '/web/cordis.patch.yml', patches: [{ id: 'web' }] }
      ],
      patches: []
    }))
    const loadHarness = vi.fn(async () => {
      expect(process.env.DSH_HOME).toBe(paths.harnessHome)
      expect(await realpath(process.cwd())).toBe(await realpath(paths.fallbackWorkspace))
      return {
        initProfile,
        composeEntries: vi.fn(() => [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'standard' } }]),
        healProfilesModuleFallback: vi.fn(),
        loadProfile,
        loadLayeredEnv: vi.fn(() => launchEnvironment),
        provideCmdline,
        launchEnvironmentKey: 'launchEnvironment' as const,
        boot
      }
    })
    const launcher = new HarnessHostLauncher({
      loadHarness,
      readiness: { fetch: vi.fn(async () => new Response('ok')) }
    })

    const handle = await launcher.launch(paths)
    expect(handle.origin).toBe('http://127.0.0.1:43210')
    expect(initProfile).toHaveBeenCalledWith(
      path.join(paths.harnessHome, 'profiles', 'desktop'),
      ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    )
    expect(loadProfile).toHaveBeenCalledWith(
      'deepseek-harness-desktop',
      'desktop',
      expect.any(String),
      paths.harnessHome
    )
    expect(provideCmdline).toHaveBeenCalledWith(expect.anything(), {
      args: ['--host', '127.0.0.1', '--port', '0'],
      exit: expect.any(Function)
    })
    expect(boot.mock.calls[0]?.[2]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'agent-presets',
        config: expect.objectContaining({
          default: 'standard',
          roots: [expect.objectContaining({ trust: 'system' })]
        })
      })
    ]))
    await Promise.all([handle.dispose(), handle.dispose()])
    expect(dispose).toHaveBeenCalledOnce()
    expect(process.cwd()).toBe(originalCwd)
    expect(process.env.DSH_HOME).toBe(originalHome)
  })
})
