import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'

const OUTPUT_BOUND = 128 * 1024

/** 解析 root HTTPS helper 的固定成对参数。 */
function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!name?.startsWith('--') || value === undefined) throw new Error(`invalid TLS gate server argument: ${name ?? ''}`)
    values[name.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] = value
  }
  return values
}

/** 向非特权父进程写一条有界 JSONL 状态。 */
function emit(value) {
  const line = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(line) > OUTPUT_BOUND) throw new Error('TLS gate server event exceeds byte bound')
  process.stdout.write(line)
}

/** 启动只接受一个 exact Stable GET、并等待父进程放行 manifest 的本机 HTTPS server。 */
async function main() {
  const options = parseArguments(process.argv.slice(2))
  for (const name of ['hostname', 'pathname', 'certificate', 'key', 'manifest']) if (!options[name]) throw new Error(`TLS gate server option is required: ${name}`)
  const [certificate, key, manifest] = await Promise.all([
    readFile(options.certificate),
    readFile(options.key),
    readFile(options.manifest),
  ])
  if (manifest.length <= 0 || manifest.length > OUTPUT_BOUND) throw new Error('TLS gate server manifest is outside the byte bound')
  let pending
  let released = false
  const server = createServer({ cert: certificate, key }, (request, response) => {
    if (request.method !== 'GET' || request.url !== options.pathname || ![options.hostname, `${options.hostname}:443`].includes(request.headers.host ?? '')) {
      response.writeHead(404, { connection: 'close', 'content-length': '0' })
      response.end()
      return
    }
    if (pending || released) {
      response.writeHead(409, { connection: 'close', 'content-length': '0' })
      response.end()
      return
    }
    pending = response
    request.resume()
    emit({ event: 'request' })
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 443, exclusive: true }, resolve)
  })
  emit({ event: 'ready' })
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => {
    input += chunk
    if (Buffer.byteLength(input) > OUTPUT_BOUND) throw new Error('TLS gate server control input exceeds byte bound')
    for (;;) {
      const newline = input.indexOf('\n')
      if (newline < 0) break
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      const command = JSON.parse(line)
      if (command.command === 'release') {
        if (!pending || released) throw new Error('TLS gate manifest release is out of order')
        released = true
        pending.writeHead(200, {
          connection: 'close',
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(manifest.length),
          'cache-control': 'no-store',
        })
        pending.end(manifest)
        pending = undefined
        emit({ event: 'released' })
      } else if (command.command === 'close') {
        pending?.destroy()
        pending = undefined
        server.close(() => process.exit(0))
      } else {
        throw new Error('unknown TLS gate server control command')
      }
    }
  })
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
