import { createServer } from 'node:http'

const scenario = process.env.DSH_HOST_SCENARIO ?? 'ready'
let server
let stopped = false

// 向测试父进程发送场景消息。
function send(message) {
  process.send?.(message)
}

// 在启动/崩溃场景中延迟退出以制造竞态窗口。
function exitSoon(code = 1, delayMs = 20) {
  setTimeout(() => process.exit(code), delayMs)
}

if (scenario === 'startup-failed') {
  send({ type: 'startup-failed', error: { name: 'StartupError', message: 'fixture startup failure', code: 'E_FIXTURE' } })
  exitSoon(1)
} else if (scenario === 'invalid-message') {
  send({ type: 'ready', origin: 'http://localhost:1234', binding: { host: '127.0.0.1', port: 1234 } })
  setInterval(() => {}, 1_000)
} else if (scenario === 'exit-before-ready' || scenario === 'timeout') {
  if (scenario === 'exit-before-ready') exitSoon(1, 10)
  else setInterval(() => {}, 1_000)
} else {
  const status = scenario === 'ready-http-fail' ? 503 : 200
  server = createServer((_request, response) => {
    response.writeHead(status, { 'content-type': 'text/plain' })
    response.end(status === 200 ? 'ok' : 'not ready')
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture did not bind')
    send({ type: 'ready', origin: `http://127.0.0.1:${address.port}`, binding: { host: '127.0.0.1', port: address.port } })
    if (scenario === 'exit-after-ready' || scenario === 'ready-http-fail') exitSoon(1, 30)
  })
  process.on('message', message => {
    if (message?.type !== 'stop' || stopped || scenario === 'shutdown-timeout') return
    stopped = true
    server.close(() => {
      send({ type: 'stopped' })
      process.disconnect?.()
      process.exit(0)
    })
  })
  if (scenario === 'shutdown-timeout') process.on('SIGTERM', () => {})
}
