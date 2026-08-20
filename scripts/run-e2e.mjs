import { access, mkdtemp, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

const scenarios = ['delayed-success', 'retry', 'prolonged', 'crash-after-ready', 'success']

/** 运行一条同步命令并把完整输出交给当前行为测试日志。 */
function run(command, args, environment = process.env) {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
  const result = spawnSync(executable, args, { env: environment, stdio: 'inherit', shell: process.platform === 'win32' && executable.endsWith('.cmd') })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`)
}

/** 构建带 debug-only WDIO 插件和 frontend test seam 的 Tauri 可执行文件。 */
function prepareApplication() {
  run('pnpm', ['ensure:node-sidecar'])
  run('node', ['scripts/run-tauri.mjs', 'build', '--debug', '--no-bundle', '--features', 'wdio', '--config', 'src-tauri/tauri.e2e.conf.json'])
}

/** 读取 fixture 事件，忽略尚未写完整的 JSONL 行。 */
async function readEvents(file) {
  const contents = await readFile(file, 'utf8').catch(() => '')
  return contents.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

/** 等待 sidecar listener 关闭，确认 WDIO 结束会话后没有遗留本地服务。 */
async function waitForListenerShutdown(origin) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try { await fetch(origin) } catch { return }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`loopback listener remained available after WDIO shutdown: ${origin}`)
}

/** 为一个场景创建隔离路径，保证 Windows 路径空格和跨进程状态都被覆盖。 */
async function scenarioEnvironment(scenario) {
  const root = await mkdtemp(path.join(tmpdir(), 'DSH Tauri E2E With Spaces '))
  const events = path.join(root, 'events.jsonl')
  const state = path.join(root, 'scenario-state.txt')
  const fixture = path.resolve('tests', 'e2e', 'fixtures', 'test-sidecar.mjs')
  await access(fixture)
  return {
    ...process.env,
    DSH_NODE_PATH: process.execPath,
    DSH_TEST_SIDECAR: fixture,
    DSH_TEST_SCENARIO: scenario,
    DSH_TEST_EVENTS: events,
    DSH_TEST_STATE_FILE: state,
    ...(scenario === 'prolonged' ? { DSH_TEST_PROLONGED_STARTUP_MS: '500' } : {})
  }
}

/** 依次运行每个真实桌面场景，并在 runner 退出后验收 sidecar 回收。 */
async function main() {
  prepareApplication()
  for (const scenario of scenarios) {
    const environment = await scenarioEnvironment(scenario)
    run('pnpm', ['exec', 'wdio', 'run', 'wdio.conf.ts'], environment)
    const events = await readEvents(environment.DSH_TEST_EVENTS)
    const ready = events.find(event => event.event === 'ready')
    if (ready?.origin) await waitForListenerShutdown(ready.origin)
    if (!events.some(event => event.event === 'server-closed')) {
      throw new Error(`scenario ${scenario} did not record server-closed after the WDIO session`)
    }
  }
}

await main()
