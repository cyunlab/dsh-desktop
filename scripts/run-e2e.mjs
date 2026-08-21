import { access, mkdtemp, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { officialNodePath } from '../tests/e2e/support/paths.mjs'

const defaultScenarios = ['real-harness', 'delayed-success', 'retry', 'prolonged', 'crash-after-ready', 'stubborn-cleanup']

/** 返回本次要运行的场景；默认执行完整门禁，本地诊断时可显式缩小范围。 */
function selectedScenarios() {
  const requested = process.env.DSH_E2E_SCENARIOS?.split(',').map(value => value.trim()).filter(Boolean)
  if (!requested?.length) return defaultScenarios
  const unknown = requested.filter(value => !defaultScenarios.includes(value))
  if (unknown.length) throw new Error(`Unknown E2E scenarios: ${unknown.join(', ')}`)
  return requested
}

/** 运行一条同步命令并把完整输出交给当前行为测试日志。 */
function run(command, args, environment = process.env) {
  const pnpmEntry = environment.npm_execpath
  if (command === 'pnpm' && !pnpmEntry) throw new Error('E2E runner must be run from a pnpm script')
  const executable = command === 'pnpm' ? process.execPath : command
  const commandArgs = command === 'pnpm'
    ? [pnpmEntry, ...args]
    : args
  const result = spawnSync(executable, commandArgs, { env: environment, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`)
}

/** 捕获 WDIO 输出，供 runner 精确识别仅发生在 deleteSession 的 backend 断连。 */
function runWdio(environment) {
  const pnpmEntry = environment.npm_execpath
  if (!pnpmEntry) throw new Error('E2E runner must be run from a pnpm script')
  const result = spawnSync(process.execPath, [pnpmEntry, 'exec', 'wdio', 'run', 'wdio.conf.ts'], {
    env: environment,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5 * 60_000,
    windowsHide: true
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result
}

/** 构建带 debug-only WDIO 插件和 frontend test seam 的 Tauri 可执行文件。 */
function prepareApplication() {
  run('pnpm', ['ensure:official-node'])
  run('node', ['scripts/run-tauri.mjs', 'build', '--debug', '--no-bundle', '--features', 'wdio', '--config', 'src-tauri/tauri.e2e.conf.json'])
}

/** 读取 fixture 事件，忽略尚未写完整的 JSONL 行。 */
async function readEvents(file) {
  const contents = await readFile(file, 'utf8').catch(() => '')
  return contents.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

/** 等待 CLI listener 关闭，确认 WDIO 结束会话后没有遗留本地服务。 */
async function waitForListenerShutdown(origin) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try { await fetch(origin) } catch { return }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`loopback listener remained available after WDIO shutdown: ${origin}`)
}

/** 使用平台进程接口判断 PID 是否仍存活。 */
function processExists(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 2_000, killSignal: 'SIGKILL' })
    return result.status === 0 && result.stdout.includes(`"${pid}"`)
  }
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 等待所有被记录的 CLI 与顽固 descendant 真正退出。 */
async function waitForProcessesExit(pids) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (pids.every(pid => !processExists(pid))) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`desktop left processes running: ${pids.filter(processExists).join(', ')}`)
}

/** 为一个场景创建隔离路径，保证 Windows 路径空格和跨进程状态都被覆盖。 */
async function scenarioEnvironment(scenario) {
  const root = await mkdtemp(path.join(tmpdir(), 'DSH Tauri E2E With Spaces '))
  const events = path.join(root, 'events.jsonl')
  const records = path.join(root, 'desktop-records.jsonl')
  const state = path.join(root, 'scenario-state.txt')
  const crashTrigger = path.join(root, 'crash-trigger')
  const completion = path.join(root, 'wdio-tests-complete')
  const fixture = path.resolve('tests', 'e2e', 'fixtures', 'test-cli.mjs')
  await access(fixture)
  return {
    ...process.env,
    DSH_NODE_PATH: officialNodePath(),
    ...(scenario === 'real-harness' ? {} : { DSH_TEST_CLI_ENTRY: fixture }),
    DSH_TEST_SCENARIO: scenario,
    DSH_TEST_EVENTS: events,
    DSH_TEST_RECORD_FILE: records,
    DSH_TEST_STATE_FILE: state,
    DSH_TEST_CRASH_TRIGGER: crashTrigger,
    DSH_TEST_COMPLETION_FILE: completion,
    DSH_TEST_RECORDS: records,
    ...(scenario === 'retry' || scenario === 'prolonged' ? { DSH_TEST_PROLONGED_AFTER_MS: '500' } : {})
  }
}

/** 仅在测试体已通过且 native shutdown 完整落盘时识别预期的 WDIO backend 断连。 */
export async function expectedNativeShutdownDisconnect(environment, result) {
  const marker = JSON.parse(await readFile(environment.DSH_TEST_COMPLETION_FILE, 'utf8').catch(() => 'null'))
  if (marker?.status !== 'passed' || !Number.isInteger(marker.generation)) return false
  const records = await readEvents(environment.DSH_TEST_RECORD_FILE)
  const backendPid = records.find(event => event.event === 'backend-started')?.pid
  const lastSpawn = records.filter(event => event.event === 'cli-spawned').at(-1)
  const generation = lastSpawn?.generation
  const requestIndex = records.findIndex(event => event.event === 'native-shutdown-requested'
    && event.source === 'close-requested' && event.generation === generation)
  const completionIndex = records.findIndex(event => event.event === 'native-shutdown-completed'
    && event.generation === generation && event.cleanupSucceeded === true)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const deleteSessionIndex = output.indexOf('COMMAND deleteSession()')
  const errorLines = output.split('\n').filter(line => /\sERROR\s/.test(line))
  const onlyDeleteSessionDisconnect = result.status !== 0
    && !result.error
    && deleteSessionIndex >= 0
    && output.slice(deleteSessionIndex).includes('ECONNREFUSED')
    && errorLines.length > 0
    && errorLines.every(line => /webdriver: WebDriverError:.*ECONNREFUSED|@wdio\/local-runner: Failed launching test session: Error: WebDriverError:.*ECONNREFUSED/.test(line))
  return marker.generation === generation
    && requestIndex >= 0
    && completionIndex > requestIndex
    && records.some(event => event.event === 'cli-cleaned' && event.generation === generation)
    && Number.isInteger(backendPid)
    && !processExists(backendPid)
    && onlyDeleteSessionDisconnect
}

/** 验收一个场景退出后的进程树与 loopback listener，失败场景也必须执行。 */
async function verifyScenarioCleanup(environment) {
  const events = await readEvents(environment.DSH_TEST_EVENTS)
  const records = await readEvents(environment.DSH_TEST_RECORD_FILE)
  const pids = [...new Set([
    ...events.filter(event => event.event === 'descendant-spawned').map(event => event.pid),
    ...records.filter(event => event.event === 'cli-spawned' || event.event === 'backend-started').map(event => event.pid)
  ].filter(Number.isInteger))]
  const origins = [...new Set(records.filter(event => event.event === 'client-page-served').map(event => event.origin).filter(origin => typeof origin === 'string'))]
  if (!pids.length) throw new Error('desktop cleanup verifier did not observe any CLI PID')
  if (!origins.length) throw new Error('desktop cleanup verifier did not observe any served client origin')
  await waitForProcessesExit(pids)
  for (const origin of origins) await waitForListenerShutdown(origin)
}

/** 依次运行每个真实桌面场景，并在 runner 退出后验收 CLI 回收。 */
async function main() {
  prepareApplication()
  for (const scenario of selectedScenarios()) {
    const environment = await scenarioEnvironment(scenario)
    let scenarioError
    let cleanupSucceeded = false
    let wdioResult
    try {
      wdioResult = runWdio(environment)
      if (wdioResult.error) throw wdioResult.error
      if (wdioResult.status !== 0) throw new Error(`wdio exited with status ${wdioResult.status}`)
    } catch (error) {
      scenarioError = error
    } finally {
      try {
        await verifyScenarioCleanup(environment)
        cleanupSucceeded = true
      } catch (cleanupError) {
        scenarioError = scenarioError
          ? new AggregateError([scenarioError, cleanupError], `${scenario} failed and left desktop resources behind`)
          : cleanupError
      }
    }
    if (scenarioError && cleanupSucceeded && wdioResult && await expectedNativeShutdownDisconnect(environment, wdioResult)) scenarioError = undefined
    if (scenarioError) throw scenarioError
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main()
