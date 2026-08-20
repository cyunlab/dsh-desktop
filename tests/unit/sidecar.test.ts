import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serializeError } from '../../src/sidecar/test-seams.js'
import { NODE_VERSION, ensureNodeSidecar, getNodeCacheRoot, getNodeTarget } from '../../scripts/ensure-node-sidecar.mjs'

describe('node sidecar seams', () => {
  it('serializes unknown errors safely', () => {
    expect(serializeError(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' })
    expect(serializeError('boom')).toEqual({ name: 'Error', message: 'boom' })
  })

  it('keeps one fixed Node 24 release and maps the four supported targets', () => {
    expect(NODE_VERSION).toBe('24.19.0')
    expect(getNodeTarget('win32', 'x64')).toMatchObject({ resourceName: 'windows-x86_64', relativeExecutable: 'node.exe' })
    expect(getNodeTarget('darwin', 'arm64')).toMatchObject({ resourceName: 'macos-aarch64', relativeExecutable: 'node' })
    expect(getNodeTarget('darwin', 'x64')).toMatchObject({ resourceName: 'macos-x86_64', relativeExecutable: 'node' })
    expect(getNodeTarget('linux', 'x64')).toMatchObject({ resourceName: 'linux-x86_64', relativeExecutable: 'node' })
    expect(() => getNodeTarget('linux', 'arm64')).toThrow('Unsupported Node sidecar target')
  })

  it('uses platform cache conventions and never lets DSH_NODE_PATH change the download cache', () => {
    expect(getNodeCacheRoot({ LOCALAPPDATA: 'C:/Local', DSH_NODE_PATH: 'C:/custom/node.exe' }, 'C:/Users/test', 'win32'))
      .toBe(path.join('C:/Local', 'dsh-desktop', 'node'))
    expect(getNodeCacheRoot({ XDG_CACHE_HOME: '/tmp/cache', DSH_NODE_PATH: '/custom/node' }, '/home/test', 'linux'))
      .toBe(path.join('/tmp/cache', 'dsh-desktop', 'node'))
  })

  it('does not redownload an existing resource and restores POSIX execute permission', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-node-existing-'))
    const executable = path.join(root, 'resources', 'node', 'linux-x86_64', 'node')
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(executable, 'existing')
    await ensureNodeSidecar({
      projectRoot: root,
      runtimePlatform: 'linux',
      runtimeArch: 'x64',
      fetchImpl: async () => { throw new Error('network should not be used') }
    })
    const information = await stat(executable)
    expect(information.isFile()).toBe(true)
    if (process.platform !== 'win32') expect(information.mode & 0o111).not.toBe(0)
  })
})
