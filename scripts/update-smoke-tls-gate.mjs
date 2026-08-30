import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const MAX_MANIFEST_BYTES = 128 * 1024
const STABLE_PATH = '/dsh-desktop/channels/stable/latest.json'

/** 校验 runner gate 只拦截 production Stable 的固定、无凭证 HTTPS endpoint。 */
function validateGateConfig(config) {
  const endpoint = new URL(config.endpoint)
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'updates.cyunlab.com' || endpoint.pathname !== STABLE_PATH || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('update smoke TLS gate requires the exact uncredentialed production Stable endpoint')
  }
  if (!Buffer.isBuffer(config.manifest) || config.manifest.length <= 0 || config.manifest.length > MAX_MANIFEST_BYTES) {
    throw new Error('update smoke TLS gate manifest is outside the byte bound')
  }
  return endpoint
}

/** 合并 action 与 runner 清理失败，确保真正的 native 根因不被 finally 覆盖。 */
function combineGateErrors(primaryError, cleanupErrors) {
  if (!primaryError && cleanupErrors.length === 0) return undefined
  if (primaryError && cleanupErrors.length === 0) return primaryError
  if (!primaryError && cleanupErrors.length === 1) return cleanupErrors[0]
  return new AggregateError([primaryError, ...cleanupErrors].filter(Boolean), primaryError?.message ?? 'update smoke TLS gate cleanup failed')
}

/** 在 runner-only 系统边界内 hold Stable 请求，恢复真实路由后再放出候选 manifest。 */
export async function withUpdateSmokeTlsGate(config, action, systemAdapter) {
  const endpoint = validateGateConfig(config)
  if (typeof action !== 'function') throw new Error('update smoke TLS gate action is required')
  for (const method of ['createTlsIdentity', 'installCertificateAuthority', 'startHttpsGate', 'routeHostname', 'restoreHostname', 'removeCertificateAuthority']) {
    if (typeof systemAdapter?.[method] !== 'function') throw new Error(`update smoke TLS gate system adapter is missing ${method}`)
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-update-smoke-tls-'))
  let identity
  let server
  let trustInstalled = false
  let routingInstalled = false
  let primaryError
  let result
  try {
    identity = await systemAdapter.createTlsIdentity({ hostname: endpoint.hostname, directory })
    await systemAdapter.installCertificateAuthority(identity)
    trustInstalled = true
    server = await systemAdapter.startHttpsGate({
      hostname: endpoint.hostname,
      pathname: endpoint.pathname,
      manifest: config.manifest,
      identity,
    })
    for (const method of ['waitForRequest', 'releaseManifest', 'close']) if (typeof server?.[method] !== 'function') throw new Error(`update smoke TLS server is missing ${method}`)
    await systemAdapter.routeHostname(endpoint.hostname, '127.0.0.1')
    routingInstalled = true
    let released = false
    const gate = Object.freeze({
      /** 等候真实 Desktop 建立 exact Stable manifest 请求。 */
      waitForRequest: () => server.waitForRequest(),
      /** byte-for-byte 恢复 hosts 与 DNS，保证后续包下载访问真实 OSS。 */
      async restoreRouting() {
        if (!routingInstalled) return
        await systemAdapter.restoreHostname()
        routingInstalled = false
      },
      /** 仅允许一次放出本次 byte-exact candidate manifest。 */
      async releaseManifest() {
        if (routingInstalled) throw new Error('update smoke TLS manifest cannot be released before routing restoration')
        if (released) throw new Error('update smoke TLS manifest was already released')
        await server.releaseManifest()
        released = true
      },
    })
    result = await action(gate)
  } catch (error) {
    primaryError = error
  } finally {
    const cleanupErrors = []
    if (routingInstalled) {
      try { await systemAdapter.restoreHostname() } catch (error) { cleanupErrors.push(error) }
    }
    if (server) {
      try { await server.close() } catch (error) { cleanupErrors.push(error) }
    }
    if (trustInstalled) {
      try { await systemAdapter.removeCertificateAuthority(identity) } catch (error) { cleanupErrors.push(error) }
    }
    try { await rm(directory, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
    const failure = combineGateErrors(primaryError, cleanupErrors)
    if (failure) throw failure
  }
  return result
}
