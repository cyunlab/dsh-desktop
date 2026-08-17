export type NavigationDecision = 'allow' | 'external' | 'deny'

/** 控制启动页、受信任 Host 与外部链接之间的导航边界。 */
export class NavigationPolicy {
  #hostOrigin?: string
  readonly #startupUrl: string

  /** 使用唯一允许的启动页 URL 初始化策略。 */
  constructor(startupUrl: string) { this.#startupUrl = startupUrl }
  /** 登记当前 Desktop 实例拥有的精确 Host origin。 */
  setHostOrigin(origin: string): void {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.origin !== origin) {
      throw new Error('Host origin must be an exact http://127.0.0.1 origin')
    }
    this.#hostOrigin = parsed.origin
  }
  /** 对目标 URL 作出允许、外部交由系统或拒绝的决定。 */
  decide(rawUrl: string): NavigationDecision {
    if (rawUrl === this.#startupUrl) return 'allow'
    let target: URL
    try { target = new URL(rawUrl) } catch { return 'deny' }
    if (this.#hostOrigin && target.origin === this.#hostOrigin && target.protocol === 'http:') return 'allow'
    if (target.protocol === 'http:' || target.protocol === 'https:') return 'external'
    return 'deny'
  }
}
