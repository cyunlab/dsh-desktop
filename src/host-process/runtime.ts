import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
/** sidecar 对外只暴露 loopback 绑定；协议类型由 Rust/sidecar 边界各自实现。 */
interface HostProcessBinding {
  readonly host: '127.0.0.1'
  readonly port: number
}

// Desktop owns the profile identity; its contents remain the official Web composition.
const PROFILE_NAME = 'desktop'
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const
const ROOT_CONFIG = '# Desktop profile root; official bundle patches are applied in order.\n[]\n'

/** 动态加载 Harness 公开模块的最小运行时形状。 */
interface HarnessModules {
  readonly boot: typeof import('@deepseek-ai/dsh-app-boot').boot
  readonly composeEntries: typeof import('@deepseek-ai/dsh-app-boot').composeEntries
  readonly healProfilesModuleFallback: typeof import('@deepseek-ai/dsh-app-boot').healProfilesModuleFallback
  readonly initProfile: typeof import('@deepseek-ai/dsh-app-boot').initProfile
  readonly loadLayeredEnv: typeof import('@deepseek-ai/dsh-app-boot').loadLayeredEnv
  readonly loadProfile: typeof import('@deepseek-ai/dsh-app-boot').loadProfile
  readonly provideCmdline: typeof import('@deepseek-ai/dsh-cmdline').provideCmdline
  readonly launchEnvironmentKey: typeof import('@deepseek-ai/dsh-launch-environment').DSH_LAUNCH_ENVIRONMENT_KEY
}

/** Host 运行时对 IPC adapter 暴露的最小生命周期句柄。 */
export interface HostRuntimeHandle {
  readonly origin: string
  readonly binding: HostProcessBinding
  dispose(): Promise<void>
}

/** 在已经准备好 cwd 与 DSH_HOME 的 Host 子进程内启动真实 Harness。 */
export async function bootHarnessHost(paths: {
  readonly harnessHome: string
  readonly defaultWorkingDirectory: string
}): Promise<HostRuntimeHandle> {
  const harness = await loadHarnessModules()
  const installAnchor = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))
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
  const environment = harness.loadLayeredEnv('deepseek-harness-desktop', paths.defaultWorkingDirectory)
  const ctx = await harness.boot(
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
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    await disposeContext(ctx)
    throw new Error('Harness Web server did not expose an assigned port')
  }
  if (host !== '127.0.0.1') {
    await disposeContext(ctx)
    throw new Error(`Harness Web server bound an unexpected host: ${host}`)
  }
  let disposed = false
  return {
    origin: `http://127.0.0.1:${port}`,
    binding: Object.freeze({ host: '127.0.0.1', port }),
    async dispose() {
      if (disposed) return
      disposed = true
      await disposeContext(ctx)
    }
  }
}

/** 动态导入会读取路径配置的 Harness 模块，确保其发生在 sidecar 初始化之后。 */
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

/** 释放已经启动的 Cordis Context，并将异常交给调用方。 */
async function disposeContext(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
}

