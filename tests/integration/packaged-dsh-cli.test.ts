import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareRuntimeClosure, probePackagedDshCli, resolveDshCliEntry, runtimeTarget } from '../../scripts/runtime-closure.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const target = runtimeTarget()
const nodeExecutable = path.join(
  root,
  'resources',
  'node',
  target.resourceName,
  process.platform === 'win32' ? 'node.exe' : 'node'
)
const runtimeAvailable = existsSync(nodeExecutable)
const desktopManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const pinnedDshVersion = desktopManifest.dependencies['@deepseek-ai/dsh'] as string

describe.skipIf(!runtimeAvailable)('packaged dsh CLI runtime', () => {
  /** 使用真实物化闭包和官方 Node 验证发布 manifest 入口，不允许仓库 NODE_PATH 补全依赖。 */
  it('executes the pinned CLI entry with the packaged official Node', async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), 'dsh-packaged-cli-integration-'))
    try {
      const nodeModulesRoot = await prepareRuntimeClosure({ projectRoot: root, outputRoot, target })
      const expectedEntry = await resolveDshCliEntry(nodeModulesRoot)
      const result = await probePackagedDshCli({
        nodeExecutable,
        nodeModulesRoot,
        args: ['--version'],
        cwd: outputRoot,
        environment: {
          PATH: process.env.PATH,
          NODE_PATH: path.join(root, 'node_modules'),
          Node_Path: path.join(root, 'repository-only-node-modules')
        }
      })

      expect(result.stdout.trim()).toBe(pinnedDshVersion)
      expect(result.command.executable).toBe(nodeExecutable)
      expect(result.command.args).toEqual([expectedEntry, '--version'])
      expect(result.command.environment.PATH?.split(path.delimiter)[0]).toBe(path.dirname(nodeExecutable))
      expect(Object.keys(result.command.environment).some(name => name.toLowerCase() === 'node_path')).toBe(false)
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
