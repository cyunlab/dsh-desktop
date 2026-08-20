import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const scenario = process.env.DSH_TEST_SCENARIO ?? 'success'
const eventsFile = process.env.DSH_TEST_EVENTS
const stateFile = process.env.DSH_TEST_STATE_FILE
let server
let child
let stopping = false
let crashTimer
let listenerTimer

/** 将测试生命周期事件写入独立文件，供 WebDriver 测试确认进程回收和单实例行为。 */
async function record(event, details = {}) {
  if (!eventsFile) return
  await appendFile(eventsFile, `${JSON.stringify({ event, ...details })}\n`, 'utf8')
}

/** 向 Tauri Rust 父进程发送一条与生产 sidecar 相同形状的生命周期消息。 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
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

/** 创建确定性 Harness HTTP 处理器，所有业务流量仍走 loopback HTTP。 */
function createHttpServer() {
  return createServer((request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8')
    if (request.url === '/health') {
      response.statusCode = 200
      response.end('ok')
      return
    }
    response.statusCode = 200
    response.end(page())
  })
}

/** 监听指定的 loopback 端口，返回操作系统分配的端口号。 */
async function listenServer(port = 0) {
  if (server) return server.address().port
  server = createHttpServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test sidecar did not receive a TCP binding')
  return address.port
}

/** 启动 loopback HTTP 服务并发布 ready 生命周期消息。 */
async function startServer() {
  if (server) return
  const port = await listenServer()
  origin = `http://127.0.0.1:${port}/`
  await record('ready', { origin })
  send({ type: 'ready', origin })
}

/** 先报告合法 origin 再延迟开启 listener，用于稳定覆盖 prolonged-startup 状态。 */
async function announceBeforeListener() {
  const probe = createHttpServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('test sidecar did not receive a delayed TCP binding')
  const port = address.port
  await new Promise(resolve => probe.close(resolve))
  origin = `http://127.0.0.1:${port}/`
  await record('ready', { origin })
  send({ type: 'ready', origin })
  listenerTimer = setTimeout(() => {
    void listenServer(port).then(() => record('listener-started', { origin })).catch(async error => {
      await record('fixture-error', { message: String(error) })
    })
  }, 1_200)
}

/** 终止测试 sidecar 的 HTTP 服务和附属进程，并发送 stopped 消息。 */
async function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  if (crashTimer) clearTimeout(crashTimer)
  if (listenerTimer) clearTimeout(listenerTimer)
  if (child && child.exitCode === null) {
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
  }
  if (server) {
    await new Promise(resolve => server.close(resolve))
    await record('server-closed', { origin })
    server = undefined
  }
  await record('stopped', { origin })
  send({ type: 'stopped' })
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

/** 根据环境变量选择成功、失败、延迟、重试和崩溃测试场景。 */
async function runScenario() {
  const attempt = await nextAttempt()
  if (scenario === 'failure' || (scenario === 'retry' && attempt === 1)) {
    await record('startup-failed', { attempt })
    send({ type: 'startup-failed', error: { name: 'TestStartupError', message: `controlled failure (attempt ${attempt})` } })
    return
  }
  if (scenario === 'delayed-success') {
    setTimeout(() => { void startServer() }, 15_000)
    return
  }
  if (scenario === 'prolonged') {
    await announceBeforeListener()
    return
  }
  await startServer()
  if (scenario === 'crash-after-ready') {
    crashTimer = setTimeout(async () => {
      await record('crashed', { origin })
      if (server) {
        await new Promise(resolve => server.close(resolve))
        await record('server-closed', { origin })
        server = undefined
      }
      process.exit(17)
    }, 1_000)
  }
}

/** 监听 Rust 的优雅停止请求，并处理操作系统终止信号。 */
function installShutdownHandlers() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', line => {
    if (line.trim() === '{"type":"stop"}') void stop()
  })
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
}

installShutdownHandlers()
void runScenario().catch(async error => {
  await record('fixture-error', { message: String(error) })
  send({ type: 'startup-failed', error: { name: error?.name ?? 'Error', message: error?.message ?? String(error) } })
  process.exitCode = 1
})
