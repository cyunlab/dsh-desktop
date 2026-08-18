import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const server = createServer((request, response) => {
  if (request.url === '/plugin-smoke') {
    const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'plugin-node-smoke.mjs')], {
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk })
    child.once('close', code => {
      response.writeHead(code === 0 ? 200 : 500, { 'content-type': 'application/json' })
      response.end(output)
    })
    return
  }
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end('ready')
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture did not bind')
  const binding = { host: '127.0.0.1', port: address.port }
  process.send?.({ type: 'ready', origin: `http://127.0.0.1:${address.port}`, binding })
})

process.on('message', message => {
  if (message?.type !== 'stop') return
  server.close(() => {
    process.send?.({ type: 'stopped' }, () => {
      process.disconnect()
      process.exit(0)
    })
  })
})
