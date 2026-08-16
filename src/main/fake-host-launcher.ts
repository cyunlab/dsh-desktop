import { createServer, type Server } from 'node:http'
import type { HostLauncher, HostHandle } from './host-launcher.js'

const page = `<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek Harness</title></head><body><main><h1>DeepSeek Harness Web Client</h1><p>Fake Host launcher active. Real Harness integration is implemented separately.</p></main></body></html>`

export class FakeHostLauncher implements HostLauncher {
  constructor(private failuresRemaining = 0) {}

  async launch(): Promise<HostHandle> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('Synthetic Host startup failure')
    }
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page)
    })
    await listen(server)
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fake Host did not acquire a TCP port')
    let disposed = false
    return {
      origin: `http://127.0.0.1:${address.port}`,
      binding: Object.freeze({ host: '127.0.0.1', port: address.port }),
      async dispose() {
        if (disposed) return
        disposed = true
        await close(server)
      }
    }
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
