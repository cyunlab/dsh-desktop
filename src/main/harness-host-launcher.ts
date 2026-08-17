import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { HostHandle, HostLauncher } from './host-launcher.js'
import type { DesktopPaths } from './paths.js'
import { waitForHttpReady, type ReadinessOptions } from './readiness.js'

// Desktop owns the profile identity; its contents remain the official Web composition.
const PROFILE_NAME = 'desktop'
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const
const ROOT_CONFIG = '# Desktop profile root; official bundle patches are applied in order.\n[]\n'

interface HarnessModules {
  boot: typeof import('@deepseek-ai/dsh-app-boot').boot
  composeEntries: typeof import('@deepseek-ai/dsh-app-boot').composeEntries
  healProfilesModuleFallback: typeof import('@deepseek-ai/dsh-app-boot').healProfilesModuleFallback
  initProfile: typeof import('@deepseek-ai/dsh-app-boot').initProfile
  loadLayeredEnv: typeof import('@deepseek-ai/dsh-app-boot').loadLayeredEnv
  loadProfile: typeof import('@deepseek-ai/dsh-app-boot').loadProfile
  provideCmdline: typeof import('@deepseek-ai/dsh-cmdline').provideCmdline
  launchEnvironmentKey: typeof import('@deepseek-ai/dsh-launch-environment').DSH_LAUNCH_ENVIRONMENT_KEY
}

export interface HarnessHostLauncherOptions {
  readonly readiness?: ReadinessOptions
  readonly loadHarness?: () => Promise<HarnessModules>
}

export class HarnessHostLauncher implements HostLauncher {
  readonly #readiness: ReadinessOptions
  readonly #loadHarness: () => Promise<HarnessModules>

  constructor(options: HarnessHostLauncherOptions = {}) {
    this.#readiness = options.readiness ?? {}
    this.#loadHarness = options.loadHarness ?? loadHarnessModules
  }

  async launch(paths: DesktopPaths): Promise<HostHandle> {
    const previousHome = process.env.DSH_HOME
    const previousCwd = process.cwd()
    let ctx: Context | undefined
    let restored = false
    const restoreProcess = (): void => {
      if (restored) return
      restored = true
      process.chdir(previousCwd)
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }

    try {
      // Harness path helpers may resolve values during module evaluation. These
      // process facts therefore must be established before the first import.
      process.env.DSH_HOME = paths.harnessHome
      process.chdir(paths.fallbackWorkspace)
      const harness = await this.#loadHarness()
      const installAnchor = resolvePublishedManifest('@deepseek-ai/dsh/package.json')
      const profileDir = path.join(paths.harnessHome, 'profiles', PROFILE_NAME)
      harness.initProfile(profileDir, BUNDLES)
      harness.healProfilesModuleFallback(installAnchor, paths.harnessHome)
      const profile = harness.loadProfile('deepseek-harness-desktop', PROFILE_NAME, installAnchor, paths.harnessHome)
      const rootConfig = path.join(profile.dir, 'cordis.yml')
      await writeFile(rootConfig, ROOT_CONFIG, 'utf8')
      const patches: PatchOptions[] = profile.layers.flatMap(layer => layer.patches).concat(profile.patches)
      const agentPresets = harness.composeEntries([patches]).find(entry => entry.id === 'agent-presets')
      if (agentPresets !== undefined) {
        patches.push({
          id: 'agent-presets',
          config: {
            ...agentPresets.config as Record<string, unknown>,
            roots: [{ path: path.join(path.dirname(installAnchor), 'config', 'agent-presets'), trust: 'system' }]
          }
        })
      }
      const environment = harness.loadLayeredEnv('deepseek-harness-desktop', paths.fallbackWorkspace)
      ctx = await harness.boot(
        'deepseek-harness-desktop',
        rootConfig,
        structuredClone(patches),
        hostCtx => {
          // The launch-environment service is consumed by the official base
          // composition, while web flags are supplied through its public
          // command-line provider.
          hostCtx.provide(harness.launchEnvironmentKey, environment)
          harness.provideCmdline(hostCtx, { args: ['--host', '127.0.0.1', '--port', '0'], exit: () => {} })
        },
        pathToFileURL(installAnchor).href
      )
      const port = ctx.webServer.port
      const host = ctx.webServer.host
      if (!Number.isInteger(port) || port <= 0) throw new Error('Harness Web server did not expose an assigned port')
      if (host !== '127.0.0.1') throw new Error(`Harness Web server bound an unexpected host: ${host}`)
      const origin = `http://127.0.0.1:${port}`
      await waitForHttpReady(origin, this.#readiness)

      let disposed = false
      return {
        origin,
        binding: Object.freeze({ host, port }),
        async dispose() {
          if (disposed) return
          disposed = true
          try { await ctx?.fiber.dispose() } finally { restoreProcess() }
        }
      }
    } catch (error) {
      try { await ctx?.fiber.dispose() } finally { restoreProcess() }
      throw error
    }
  }
}

async function loadHarnessModules(): Promise<HarnessModules> {
  const [boot, cmdline, launchEnvironment] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import('@deepseek-ai/dsh-cmdline'),
    import('@deepseek-ai/dsh-launch-environment')
  ])
  return {
    ...boot,
    provideCmdline: cmdline.provideCmdline,
    launchEnvironmentKey: launchEnvironment.DSH_LAUNCH_ENVIRONMENT_KEY
  }
}

function resolvePublishedManifest(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier))
}
