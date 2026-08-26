import type { ChildProcess } from 'node:child_process'
import type { PackagedDshCliCommand } from './runtime-closure.mjs'

export const FIXED_HOST_ORIGIN: 'http://127.0.0.1:3080/'
export const DIRECT_DSH_WEB_ARGS: readonly ['web', '--host', '127.0.0.1', '--port', '3080']

/** 从环境变量读取正整数毫秒值。 */
export function readPositiveMilliseconds(value: string | undefined, fallback: number, variableName: string): number

export interface ProcessTreeOwnership {
  readonly rootPid?: number
  readonly platformName: NodeJS.Platform
  readonly windowsController?: { request(command: 'STATUS' | 'STOP' | 'FORCE' | 'EXIT', timeoutMilliseconds: number): Promise<number> }
  readonly controllerProcess?: ChildProcess
}

/** 串行执行固定端口探测。 */
export function withFixedPortProbeLock<T>(action: () => Promise<T>, options?: { readonly lockPath?: string; readonly timeoutMilliseconds?: number }): Promise<T>

/** 等待子进程确认退出。 */
export function waitForChildExit(child: ChildProcess, timeoutMilliseconds?: number): Promise<void>

/** 建立 POSIX PGID 或 Windows Job controller ownership。 */
export function ownProcessTree(child: ChildProcess, options?: { readonly rootPid?: number; readonly platformName?: NodeJS.Platform; readonly windowsController?: ProcessTreeOwnership['windowsController']; readonly controllerProcess?: ChildProcess }): ProcessTreeOwnership

/** 构造保真传递 packaged executable、argv 与 cwd 的 Windows controller 参数。 */
export function windowsJobControllerArguments(command: PackagedDshCliCommand, workDirectory: string): readonly string[]

/** 查询 owned process tree 是否完全消失。 */
export function processTreeHasExited(ownership: ProcessTreeOwnership, timeoutMilliseconds?: number): Promise<boolean>

/** 等待 owned process tree 完全消失。 */
export function waitForProcessTreeExit(ownership: ProcessTreeOwnership, timeoutMilliseconds?: number): Promise<void>

/** 强制终止子进程树并等待完整 ownership 消失。 */
export function terminateProcessTree(child: ChildProcess, timeoutMilliseconds?: number, ownership?: ProcessTreeOwnership): Promise<void>

/** 等待 Harness listener 停止接受连接。 */
export function waitForListenerClosed(origin?: string, timeoutMilliseconds?: number): Promise<void>

/** 等待 direct CLI 返回有效 HTML。 */
export function waitForHtmlReadiness(child: ChildProcess, options?: { readonly origin?: string; readonly timeoutMilliseconds?: number; readonly ownership?: ProcessTreeOwnership }): Promise<string>

/** 请求 CLI 关闭，并在正常请求失败时强制回收 owned tree。 */
export function stopCliProcess(child: ChildProcess, ownership: ProcessTreeOwnership, timeoutMilliseconds?: number): Promise<void>

/** 启动固定 direct CLI、验证 HTML 并确认进程树回收。 */
export function probeDirectDshWeb(options: {
  readonly nodeExecutable: string
  readonly nodeModulesRoot: string
  readonly workDirectory?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly timeoutMilliseconds?: number
}): Promise<{ readonly command: PackagedDshCliCommand; readonly html: string }>
