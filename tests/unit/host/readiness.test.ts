import { describe, expect, it, vi } from 'vitest'
import { waitForHttpReady } from '../../../src/main/host/readiness.js'

describe('HTTP readiness', () => {
  it('retries until the Host responds successfully', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('listener not ready'))
      .mockResolvedValueOnce(new Response('starting', { status: 503 }))
      .mockResolvedValueOnce(new Response('<html></html>', { status: 200 }))
    await expect(waitForHttpReady('http://127.0.0.1:3456', {
      timeoutMs: 1_000,
      intervalMs: 0,
      fetch: request
    })).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('fails within its configured bound', async () => {
    await expect(waitForHttpReady('http://127.0.0.1:3456', {
      timeoutMs: 10,
      intervalMs: 1,
      fetch: vi.fn(async () => { throw new Error('refused') })
    })).rejects.toThrow('within 10 ms')
  })
})
