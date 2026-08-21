import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const scenario = process.env.DSH_TEST_SCENARIO ?? 'success'
const eventsFile = process.env.DSH_TEST_EVENTS
const stateFile = process.env.DSH_TEST_STATE_FILE
const crashTrigger = process.env.DSH_TEST_CRASH_TRIGGER
let server
let child
let stopping = false
let crashTimer
let listenerTimer
let ignoresStop = false
let hasStubbornDescendant = false
let attemptNumber = 0
const host = argumentValue('--host') ?? '127.0.0.1'
const hostPort = Number.parseInt(argumentValue('--port') ?? '3080', 10)

/** 读取 direct CLI fixture 收到的命令行参数。 */
function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** 将测试生命周期事件写入独立文件，供 WebDriver 测试确认进程回收和单实例行为。 */
async function record(event, details = {}) {
  if (!eventsFile) return
  await appendFile(eventsFile, `${JSON.stringify({ event, ...details })}\n`, 'utf8')
}

/** 返回一个仅绑定 127.0.0.1 的确定性测试 Harness 页面。 */
function page() {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>DeepSeek Harness Test Client</title></head>
  <body>
    <main>
      <h1 data-testid="harness-ready">DeepSeek Harness Test Client</h1>
      <p data-testid="loopback-origin">${origin ?? ''}</p>
      <button id="external" type="button">Open external link</button>
      <button id="custom" type="button">Open custom protocol</button>
    </main>
    <script>
      document.querySelector('#external').addEventListener('click', () => window.open('https://example.com/dsh-e2e', '_blank'))
      document.querySelector('#custom').addEventListener('click', () => window.open('file:///dsh-e2e-private', '_blank'))
    </script>
  </body>
</html>`
}

let origin

/** 创建确定性 Harness HTTP 处理器，可为 Retry 首轮保持占端口但拒绝 HTML readiness。 */
function createHttpServer(servesHtml = true) {
  return createServer((request, response) => {
    response.setHeader('content-type', servesHtml ? 'text/html; charset=utf-8' : 'application/json')
    if (request.url === '/health') {
      response.statusCode = 200
      response.end('ok')
      return
    }
    response.statusCode = 200
    response.end(servesHtml ? page() : '{}')
  })
}

/** 监听指定的 loopback 端口，返回操作系统分配的端口号。 */
async function listenServer(port = hostPort, servesHtml = true) {
  if (server) return server.address().port
  server = createHttpServer(servesHtml)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test CLI did not receive a TCP binding')
  return address.port
}

/** 占用固定端口但只返回 JSON，使首轮保持存活并进入 Prolonged。 */
async function startUnreadyServer() {
  const port = await listenServer(hostPort, false)
  origin = `http://${host}:${port}/`
  await record('listener-started', { origin, attempt: attemptNumber })
}

/** 启动 loopback HTTP 服务并发布 ready 生命周期消息。 */
async function startServer() {
  if (server) return
  const port = await listenServer()
  origin = `http://${host}:${port}/`
  await record('ready', { origin, attempt: attemptNumber })
}

/** 延迟开启固定 listener，用于稳定覆盖 prolonged-startup 状态。 */
async function announceBeforeListener() {
  origin = `http://${host}:${hostPort}/`
  listenerTimer = setTimeout(() => {
    void listenServer(hostPort).then(() => record('listener-started', { origin, attempt: attemptNumber })).catch(async error => {
      await record('fixture-error', { message: String(error) })
    })
  }, 120_000)
}

/** 终止测试 CLI 的 HTTP 服务和附属进程。 */
async function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  if (crashTimer) clearTimeout(crashTimer)
  if (listenerTimer) clearTimeout(listenerTimer)
  if (server) {
    await new Promise(resolve => server.close(resolve))
    await record('server-closed', { origin, attempt: attemptNumber })
    server = undefined
  }
  if (ignoresStop) { await record('stop-ignored', { pid: process.pid }); return }
  if (child && child.exitCode === null) {
    child.kill()
    if (hasStubbornDescendant) await record('cleanup-waiting-for-descendant', { pid: child.pid })
    await new Promise(resolve => child.once('exit', resolve))
  }
  await record('stopped', { origin })
  process.exit(exitCode)
}

/** 读取并递增 retry 场景的跨进程尝试次数。 */
async function nextAttempt() {
  if (!stateFile) return 1
  const previous = Number.parseInt(await readFile(stateFile, 'utf8').catch(() => '0'), 10)
  const attempt = Number.isFinite(previous) ? previous + 1 : 1
  await writeFile(stateFile, String(attempt), 'utf8')
  return attempt
}

/** 等待 WebDriver 确认 Ready 页面后，由测试显式触发运行期崩溃。 */
async function waitForCrashTrigger() {
  if (!crashTrigger) throw new Error('DSH_TEST_CRASH_TRIGGER is required')
  while (!stopping) {
    if (await readFile(crashTrigger, 'utf8').then(() => true).catch(() => false)) return
    await new Promise(resolve => { crashTimer = setTimeout(resolve, 100) })
  }
}

/** 根据环境变量选择成功、失败、延迟、重试和崩溃测试场景。 */
async function runScenario() {
  const attempt = await nextAttempt()
  attemptNumber = attempt
  await record('fixture-started', { pid: process.pid, attempt })
  if ((scenario === 'retry' && attempt === 1) || scenario === 'stubborn-cleanup') {
    child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore', windowsHide: true })
    hasStubbornDescendant = true
    ignoresStop = scenario === 'stubborn-cleanup'
    await record('descendant-spawned', { pid: child.pid, parentPid: process.pid, attempt })
  }
  if (scenario === 'failure') {
    await record('startup-failed', { attempt })
    process.exit(17)
    return
  }
  if (scenario === 'retry' && attempt === 1) {
    await startUnreadyServer()
    return
  }
  if (scenario === 'delayed-success') {
    setTimeout(() => { void startServer() }, 10_000)
    return
  }
  if (scenario === 'prolonged') {
    if (attempt === 1) await announceBeforeListener()
    else await startServer()
    return
  }
  await startServer()
  if (scenario === 'crash-after-ready') {
    void waitForCrashTrigger().then(async () => {
      await record('crashed', { origin })
      // 模拟真正的宿主崩溃：不能等待 WebView 的持久 HTTP 连接优雅关闭。
      process.exit(17)
    })
  }
}

/** 处理 Desktop 发送的操作系统终止信号。 */
function installShutdownHandlers() {
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
}

installShutdownHandlers()
void runScenario().catch(async error => {
  await record('fixture-error', { message: String(error) })
  process.exitCode = 1
})
