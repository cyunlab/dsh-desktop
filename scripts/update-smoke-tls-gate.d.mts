export interface UpdateSmokeTlsGate {
  /** 等候真实 Desktop 建立 exact Stable manifest 请求。 */
  waitForRequest(): Promise<void>
  /** byte-for-byte 恢复 hosts 与 DNS，保证后续包下载访问真实 OSS。 */
  restoreRouting(): Promise<void>
  /** 仅允许一次放出本次 byte-exact candidate manifest。 */
  releaseManifest(): Promise<void>
}

export interface UpdateSmokeTlsSystemAdapter {
  createTlsIdentity(config: { readonly hostname: string; readonly directory: string }): Promise<unknown>
  installCertificateAuthority(identity: unknown): Promise<void>
  startHttpsGate(config: { readonly hostname: string; readonly pathname: string; readonly manifest: Buffer; readonly identity: unknown }): Promise<{
    waitForRequest(): Promise<void>
    releaseManifest(): Promise<void>
    close(): Promise<void>
  }>
  routeHostname(hostname: string, address: '127.0.0.1'): Promise<void>
  restoreHostname(): Promise<void>
  removeCertificateAuthority(identity: unknown): Promise<void>
}

/** 在 runner-only 系统边界内 hold Stable 请求，恢复真实路由后再放出候选 manifest。 */
export function withUpdateSmokeTlsGate<T>(
  config: { readonly endpoint: string; readonly manifest: Buffer },
  action: (gate: UpdateSmokeTlsGate) => Promise<T>,
  systemAdapter: UpdateSmokeTlsSystemAdapter,
): Promise<T>
