import type { Options } from '@wdio/types'
import { applicationPath, officialNodePath } from './tests/e2e/support/paths.mjs'
import { waitForPackagedStartupPage } from './tests/e2e/support/startup-page.mjs'

const scenario = process.env.DSH_TEST_SCENARIO ?? 'success'
const application = applicationPath()
const startupPageScenarios = new Set(['delayed-success', 'retry', 'prolonged'])

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
      // Windows provider 会校验 WebView2 匹配的驱动，由服务自动下载并缓存。
      autoDownloadEdgeDriver: true,
      env: {
        DSH_NODE_PATH: process.env.DSH_NODE_PATH ?? officialNodePath(),
        ...(process.env.DSH_TEST_SIDECAR ? { DSH_TEST_SIDECAR: process.env.DSH_TEST_SIDECAR } : {}),
        DSH_TEST_SCENARIO: scenario,
        ...(process.env.DSH_TEST_EVENTS ? { DSH_TEST_EVENTS: process.env.DSH_TEST_EVENTS } : {}),
        ...(process.env.DSH_TEST_STATE_FILE ? { DSH_TEST_STATE_FILE: process.env.DSH_TEST_STATE_FILE } : {}),
        ...(process.env.DSH_TEST_RECORD_FILE ? { DSH_TEST_RECORD_FILE: process.env.DSH_TEST_RECORD_FILE } : {}),
        ...(process.env.DSH_TEST_RECORDS ? { DSH_TEST_RECORDS: process.env.DSH_TEST_RECORDS } : {})
      }
    }
  ]],
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': { application }
  }],
  framework: 'mocha',
  reporters: ['spec'],
  /** 在启动页敏感场景开始测试前，等待并验证 packaged 页面已完成提交。 */
  before: async (_capabilities, _specs, browser) => {
    if (startupPageScenarios.has(scenario)) await waitForPackagedStartupPage(browser)
  },
  logLevel: process.env.CI ? 'warn' : 'info',
  waitforTimeout: 15_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 2,
  mochaOpts: {
    ui: 'bdd',
    timeout: 180_000
  }
}
