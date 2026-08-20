import path from 'node:path'
import type { Options } from '@wdio/types'

const scenario = process.env.DSH_TEST_SCENARIO ?? 'success'
const application = process.platform === 'win32'
  ? path.resolve('src-tauri', 'target', 'debug', 'deepseek-harness-desktop.exe')
  : path.resolve('src-tauri', 'target', 'debug', 'deepseek-harness-desktop')
const fixture = path.resolve('tests', 'e2e', 'fixtures', 'test-sidecar.mjs')

/** WebdriverIO Tauri 配置；embedded provider 在三种桌面平台使用同一套真实窗口驱动。 */
export const config: Options.Testrunner = {
  runner: 'local',
  specs: ['./tests/e2e/desktop.spec.ts'],
  maxInstances: 1,
  services: [[
    '@wdio/tauri-service',
    {
      appBinaryPath: application,
      driverProvider: 'embedded',
      embeddedPort: 4445,
      statusPollTimeout: 15_000,
      // 调试构建捕获 Rust stderr，便于诊断窗口导航和 sidecar 生命周期。
      captureBackendLogs: true,
      // 服务在 Windows 上即使使用内置 provider 仍会执行兼容性探测，保持自动下载可以让 CI 无需手工安装驱动。
      autoDownloadEdgeDriver: true,
      env: {
        DSH_NODE_PATH: process.env.DSH_NODE_PATH ?? process.execPath,
        DSH_TEST_SIDECAR: process.env.DSH_TEST_SIDECAR ?? fixture,
        DSH_TEST_SCENARIO: scenario,
        ...(process.env.DSH_TEST_EVENTS ? { DSH_TEST_EVENTS: process.env.DSH_TEST_EVENTS } : {}),
        ...(process.env.DSH_TEST_STATE_FILE ? { DSH_TEST_STATE_FILE: process.env.DSH_TEST_STATE_FILE } : {}),
        ...(process.env.DSH_TEST_PROLONGED_STARTUP_MS ? { DSH_TEST_PROLONGED_STARTUP_MS: process.env.DSH_TEST_PROLONGED_STARTUP_MS } : {})
      }
    }
  ]],
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': { application }
  }],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: process.env.CI ? 'warn' : 'info',
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 2,
  mochaOpts: {
    ui: 'bdd',
    timeout: 90_000
  }
}
