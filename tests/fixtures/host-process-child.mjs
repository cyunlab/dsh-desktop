import { createServer } from 'node:http'

const server = createServer((_request, response) => {
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
