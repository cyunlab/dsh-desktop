import { createRequire } from 'node:module'

/** Windows Job Object extended-limit information class。 */
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

/** 让 Job Object 的最后一个句柄关闭时终止其中全部进程。 */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000

/** AssignProcessToJobObject 所需的最小进程权限。 */
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const JOB_OBJECT_INFORMATION_SIZE = 144
const LIMIT_FLAGS_OFFSET = 16

/** 注入 fake 或 Koffi Win32 seam 所接受的不透明原生句柄。 */
export type WindowsNativeHandle = bigint | number

/** 归属 child 进程树所需的最小 Win32 接口。 */
export interface WindowsJobBindings {
  createJobObjectW(attributes: null, name: null): WindowsNativeHandle | null | undefined
  setInformationJobObject(job: WindowsNativeHandle, informationClass: number, information: Buffer, length: number): number | boolean
  openProcess(access: number, inheritHandle: number, processId: number): WindowsNativeHandle | null | undefined
  assignProcessToJobObject(job: WindowsNativeHandle, process: WindowsNativeHandle): number | boolean
  closeHandle(handle: WindowsNativeHandle): number | boolean
  getLastError?(): number
}

/** 可幂等关闭的 owner；关闭 Job Object 即释放其进程树。 */
export interface WindowsJobOwner {
  close(): void
}

/** 用于确定性 Job Object 测试的依赖注入 seam。 */
export interface WindowsJobOptions {
  readonly bindings?: WindowsJobBindings
}

/** 创建 kill-on-close Job Object，并把已经 spawn 的 leader assign 到其中。 */
export function createWindowsJobForProcess(pid: number, options: WindowsJobOptions = {}): WindowsJobOwner {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Cannot create Windows Job Object for invalid pid ${pid}`)
  const bindings = options.bindings ?? loadWindowsJobBindings()
  let job: WindowsNativeHandle | undefined
  let processHandle: WindowsNativeHandle | undefined
  try {
    job = requireHandle(bindings.createJobObjectW(null, null), 'CreateJobObjectW', bindings)
    const information = createKillOnCloseInformation()
    if (!isSuccess(bindings.setInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, information, information.length))) {
      throw win32Failure('SetInformationJobObject', bindings)
    }
    processHandle = requireHandle(
      bindings.openProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid),
      'OpenProcess',
      bindings
    )
    if (!isSuccess(bindings.assignProcessToJobObject(job, processHandle))) {
      throw win32Failure('AssignProcessToJobObject', bindings)
    }
    closeRequiredHandle(processHandle, 'CloseHandle(process)', bindings)
    processHandle = undefined
    const ownedJob = job
    job = undefined
    return createIdempotentOwner(ownedJob, bindings)
  } catch (error) {
    if (processHandle !== undefined) closeBestEffort(processHandle, bindings)
    if (job !== undefined) closeBestEffort(job, bindings)
    throw error
  }
}

/** 构造 x64/arm64 共用的 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 数据。 */
function createKillOnCloseInformation(): Buffer {
  const information = Buffer.alloc(JOB_OBJECT_INFORMATION_SIZE)
  information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET)
  return information
}

/** 创建最多释放一次原生句柄的幂等 owner。 */
function createIdempotentOwner(job: WindowsNativeHandle, bindings: WindowsJobBindings): WindowsJobOwner {
  let closed = false
  return {
    close(): void {
      if (closed) return
      closeRequiredHandle(job, 'CloseHandle(job)', bindings)
      closed = true
    }
  }
}

/** Loads Koffi only when the Windows launcher actually needs the Job Object. */
function loadWindowsJobBindings(): WindowsJobBindings {
  if (process.platform !== 'win32') throw new Error('Windows Job Objects are unavailable on this platform')
  const packageName = `@koromix/koffi-win32-${process.arch}`
  let koffi: KoffiModule
  try {
    koffi = createRequire(import.meta.url)(packageName) as KoffiModule
  } catch (error) {
    throw new Error(`Windows Job Object Koffi carrier is unavailable (${packageName})`, { cause: error })
  }
  const kernel32 = koffi.load('kernel32.dll')
  return {
    createJobObjectW: kernel32.func('void *CreateJobObjectW(void *attributes, void *name)') as WindowsJobBindings['createJobObjectW'],
    setInformationJobObject: kernel32.func('int32_t SetInformationJobObject(void *job, int32_t informationClass, void *information, uint32_t length)') as WindowsJobBindings['setInformationJobObject'],
    openProcess: kernel32.func('void *OpenProcess(uint32_t access, int32_t inheritHandle, uint32_t processId)') as WindowsJobBindings['openProcess'],
    assignProcessToJobObject: kernel32.func('int32_t AssignProcessToJobObject(void *job, void *process)') as WindowsJobBindings['assignProcessToJobObject'],
    closeHandle: kernel32.func('int32_t CloseHandle(void *handle)') as WindowsJobBindings['closeHandle'],
    getLastError: kernel32.func('uint32_t GetLastError()') as WindowsJobBindings['getLastError']
  }
}

/** 遇到空 Win32 句柄时使用紧接着读取的 GetLastError 报错。 */
function requireHandle(value: WindowsNativeHandle | null | undefined, operation: string, bindings: WindowsJobBindings): WindowsNativeHandle {
  if (value === null || value === undefined || value === 0 || value === 0n) throw win32Failure(operation, bindings)
  return value
}

/** 把 Win32 BOOL 风格返回值转换为统一的成功判断。 */
function isSuccess(value: number | boolean): boolean {
  return value === true || value === 1
}

/** 关闭必需句柄；失败时报告原生错误而不是静默泄漏。 */
function closeRequiredHandle(handle: WindowsNativeHandle, operation: string, bindings: WindowsJobBindings): void {
  if (!isSuccess(bindings.closeHandle(handle))) throw win32Failure(operation, bindings)
}

/** 尽力清理句柄，但不覆盖原始 setup 失败。 */
function closeBestEffort(handle: WindowsNativeHandle, bindings: WindowsJobBindings): void {
  try { bindings.closeHandle(handle) } catch { /* preserve the original setup failure */ }
}

/** 格式化受控 Win32 错误，不保留原生对象或任意 cause 图。 */
function win32Failure(operation: string, bindings: WindowsJobBindings): Error {
  const code = bindings.getLastError?.() ?? 0
  const error = new Error(`${operation} failed (${code})`)
  error.name = 'WindowsJobObjectError'
  return error
}

/** Koffi 动态载入结果所需的最小结构类型。 */
interface KoffiModule {
  load(library: string): { func(prototype: string): (...args: unknown[]) => unknown }
}
