import type { ChildProcess } from 'node:child_process'
import type { PackagedDshCliCommand } from './runtime-closure.mjs'

export const FIXED_HOST_ORIGIN: 'http://127.0.0.1:3080/'
export const DIRECT_DSH_WEB_ARGS: readonly ['web', '--host', '127.0.0.1', '--port', '3080']

export interface ProcessTreeOwnership {
  readonly rootPid?: number
  readonly platformName: NodeJS.Platform
  readonly queryWindowsProcesses: (timeoutMilliseconds?: number) => Promise<readonly { readonly pid: number; readonly parentPid: number; readonly creationDate: string }[]>
  readonly knownProcessIdentities: Map<number, string>
}

/** 串行执行固定端口探测。 */
export function withFixedPortProbeLock<T>(action: () => Promise<T>, options?: { readonly lockPath?: string; readonly timeoutMilliseconds?: number }): Promise<T>

/** 等待子进程确认退出。 */
export function waitForChildExit(child: ChildProcess, timeoutMilliseconds?: number): Promise<void>

/** 从 Windows 进程表解析由稳定 root PID 拥有的仍存活进程。 */
export function windowsOwnedProcessIds(rootPid: number, rootCreationDate: string, rows: readonly { readonly pid: number; readonly parentPid: number; readonly creationDate: string }[]): number[]

/** 建立不依赖 leader 持续存活的进程树 ownership。 */
export function ownProcessTree(child: ChildProcess, options?: { readonly platformName?: NodeJS.Platform; readonly queryWindowsProcesses?: ProcessTreeOwnership['queryWindowsProcesses']; readonly captureTimeoutMilliseconds?: number }): Promise<ProcessTreeOwnership>

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

/** 启动固定 direct CLI、验证 HTML 并确认进程树回收。 */
export function probeDirectDshWeb(options: {
  readonly nodeExecutable: string
  readonly nodeModulesRoot: string
  readonly workDirectory?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly timeoutMilliseconds?: number
}): Promise<{ readonly command: PackagedDshCliCommand; readonly html: string }>
