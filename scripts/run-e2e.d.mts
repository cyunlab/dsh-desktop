import type { SpawnSyncReturns } from 'node:child_process'

/** 判断目标平台和场景是否应使用确定性 CLI fixture。 */
export function shouldUseCliFixture(scenario: string, runtimePlatform?: NodeJS.Platform): boolean

/** 精确识别仅由最终窗口关闭导致的 WDIO deleteSession backend 断连。 */
export function expectedNativeShutdownDisconnect(
  environment: NodeJS.ProcessEnv & { readonly DSH_TEST_COMPLETION_FILE: string; readonly DSH_TEST_RECORD_FILE: string },
  result: SpawnSyncReturns<string>
): Promise<boolean>
