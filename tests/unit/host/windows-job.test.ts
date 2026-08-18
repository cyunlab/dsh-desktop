import { describe, expect, it, vi } from 'vitest'
import {
  createWindowsJobForProcess,
  JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  type WindowsJobBindings
} from '../../../src/main/host/windows-job.js'

/** 创建可观察的 Windows Job Object API fake。 */
function createFakeBindings(): WindowsJobBindings & {
  readonly calls: string[]
  readonly info?: Buffer
} {
  const calls: string[] = []
  let info: Buffer | undefined
  return {
    calls,
    get info() { return info },
    createJobObjectW: vi.fn(() => { calls.push('create'); return 11n }),
    setInformationJobObject: vi.fn((_job, infoClass, value, length) => {
      calls.push(`set:${infoClass}:${length}`)
      info = value as Buffer
      return 1
    }),
    openProcess: vi.fn(() => { calls.push('open'); return 22n }),
    assignProcessToJobObject: vi.fn(() => { calls.push('assign'); return 1 }),
    closeHandle: vi.fn(handle => { calls.push(`close:${String(handle)}`); return 1 }),
    getLastError: vi.fn(() => 5)
  }
}

describe('Windows Job Object process ownership', () => {
  it('sets kill-on-close, assigns the leader, and closes the job exactly once', () => {
    const bindings = createFakeBindings()
    const owner = createWindowsJobForProcess(4321, { bindings })

    expect(bindings.calls).toEqual(['create', `set:${JOB_OBJECT_EXTENDED_LIMIT_INFORMATION}:144`, 'open', 'assign', 'close:22'])
    expect(bindings.info?.readUInt32LE(16)).toBe(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)

    owner.close()
    owner.close()
    expect(bindings.closeHandle).toHaveBeenCalledTimes(2)
    expect(bindings.closeHandle).toHaveBeenLastCalledWith(11n)
  })

  it('closes every acquired handle and reports the Win32 error when assignment fails', () => {
    const bindings = createFakeBindings()
    bindings.assignProcessToJobObject = vi.fn(() => 0)
    bindings.getLastError = vi.fn(() => 87)

    expect(() => createWindowsJobForProcess(4321, { bindings })).toThrow(/AssignProcessToJobObject failed \(87\)/)
    expect(bindings.closeHandle).toHaveBeenNthCalledWith(1, 22n)
    expect(bindings.closeHandle).toHaveBeenNthCalledWith(2, 11n)
  })
})
