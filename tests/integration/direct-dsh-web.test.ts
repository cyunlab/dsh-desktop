import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareRuntimeClosure, runtimeTarget } from '../../scripts/runtime-closure.mjs'
import { DIRECT_DSH_WEB_ARGS, probeDirectDshWeb } from '../../scripts/smoke-dsh-cli.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const target = runtimeTarget()
const nodeExecutable = path.join(root, 'resources', 'node', target.resourceName, process.platform === 'win32' ? 'node.exe' : 'node')

describe.skipIf(!existsSync(nodeExecutable)).sequential('published dsh web composition', () => {
  /** 用物化闭包启动真实 published CLI，验证固定参数、HTML 与回收。 */
  it('serves the fixed Web root and disposes through the official CLI signal path', async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), 'dsh-direct-web-integration-'))
    try {
      const nodeModulesRoot = await prepareRuntimeClosure({ projectRoot: root, outputRoot, target })
      const result = await probeDirectDshWeb({ nodeExecutable, nodeModulesRoot, timeoutMilliseconds: 60_000 })
      expect(result.command.args.slice(1)).toEqual(DIRECT_DSH_WEB_ARGS)
      expect(result.command.executable).toBe(nodeExecutable)
      expect(result.html.trim()).not.toBe('')
    } finally {
      await rm(outputRoot, { recursive: true, force: true })
    }
  }, 120_000)
})
