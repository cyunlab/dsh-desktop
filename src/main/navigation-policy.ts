export type NavigationDecision = 'allow' | 'external' | 'deny'

export class NavigationPolicy {
  #hostOrigin?: string
  readonly #startupUrl: string

  constructor(startupUrl: string) { this.#startupUrl = startupUrl }
  setHostOrigin(origin: string): void {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== origin) {
      throw new Error('Host origin must be an exact http://127.0.0.1 origin')
    }
    this.#hostOrigin = parsed.origin
  }
  decide(rawUrl: string): NavigationDecision {
    if (rawUrl === this.#startupUrl) return 'allow'
    let target: URL
    try { target = new URL(rawUrl) } catch { return 'deny' }
    if (this.#hostOrigin && target.origin === this.#hostOrigin && target.protocol === 'http:') return 'allow'
    if (target.protocol === 'http:' || target.protocol === 'https:') return 'external'
    return 'deny'
  }
}
