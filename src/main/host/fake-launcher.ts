import { createServer, type Server } from 'node:http'
import type { HostLauncher, HostHandle } from './launcher.js'

const page = `<!doctype html><html><head><meta charset="utf-8"><title>DeepSeek Harness</title></head><body><main><h1>DeepSeek Harness Web Client</h1><p>Fake Host launcher active. Real Harness integration is implemented separately.</p></main></body></html>`

/** 用于 E2E/生命周期测试的本地 HTTP Host adapter。 */
export class FakeHostLauncher implements HostLauncher {
  /** 创建带有可控失败次数的测试 Host adapter。 */
  constructor(private failuresRemaining = 0) {}

  /** 启动本地 fake HTTP 服务，模拟生产 HostHandle 的关闭语义。 */
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
    let resolveClosed!: (event: { intentional: boolean }) => void
    const closed = new Promise<{ intentional: boolean }>(resolve => { resolveClosed = resolve })
    return {
      origin: `http://127.0.0.1:${address.port}`,
      binding: Object.freeze({ host: '127.0.0.1', port: address.port }),
      closed,
      async dispose() {
        if (disposed) return
        disposed = true
        try { await close(server) } finally { resolveClosed({ intentional: true }) }
      }
    }
  }
}

/** 监听 loopback fake Host 服务。 */
function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
}

/** 关闭 fake Host 服务并等待底层 TCP listener 释放。 */
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
