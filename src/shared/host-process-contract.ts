/** Host 子进程向 Desktop 主进程报告的 loopback 绑定信息。 */
export interface HostProcessBinding {
  readonly host: '127.0.0.1'
  readonly port: number
}

/** 仅允许跨进程传播的受控错误字段。 */
export interface SerializedHostProcessError {
  readonly name: string
  readonly message: string
  readonly code?: string | number
}

/** Host 子进程到主进程的最小消息协议。 */
export type HostProcessMessage =
  | { readonly type: 'ready'; readonly origin: string; readonly binding: HostProcessBinding }
  | { readonly type: 'startup-failed'; readonly error: SerializedHostProcessError }
  | { readonly type: 'stopped' }

/** 主进程到 Host 子进程的最小命令协议。 */
export type HostProcessCommand = { readonly type: 'stop' }

const MAX_ERROR_FIELD_LENGTH = 1_024
const MAX_PORT = 65_535

/** 将未知值校验为严格的 Host 子进程消息。 */
export function parseHostProcessMessage(value: unknown): HostProcessMessage {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('Invalid Host process message')
  if (value.type === 'ready') return parseReady(value)
  if (value.type === 'startup-failed') return parseStartupFailed(value)
  if (value.type === 'stopped') {
    assertExactKeys(value, ['type'])
    return { type: 'stopped' }
  }
  throw new Error('Unknown Host process message type')
}

/** 将未知值校验为严格的主进程命令。 */
export function parseHostProcessCommand(value: unknown): HostProcessCommand {
  if (!isRecord(value) || value.type !== 'stop') throw new Error('Invalid Host process command')
  assertExactKeys(value, ['type'])
  return { type: 'stop' }
}

/** 将任意启动异常压缩为不会携带对象图或敏感上下文的错误。 */
export function serializeHostProcessError(error: unknown): SerializedHostProcessError {
  const source = isRecord(error) ? error : undefined
  const name = boundedString(source?.name, 'Error')
  const message = boundedString(source?.message, String(error), true)
  const code = typeof source?.code === 'string' || typeof source?.code === 'number'
    ? source.code
    : undefined
  return Object.freeze({ name, message, ...(code === undefined ? {} : { code }) })
}

/** 从受控错误消息创建主进程可抛出的 Error。 */
export function deserializeHostProcessError(error: SerializedHostProcessError): Error {
  const result = new Error(error.message)
  result.name = error.name
  if (error.code !== undefined) Object.assign(result, { code: error.code })
  return result
}

/** 构造与绑定完全一致的 loopback origin。 */
export function hostOrigin(binding: HostProcessBinding): string {
  return `http://127.0.0.1:${binding.port}`
}

/** 校验 ready 消息中的绑定、origin 及精确字段集合。 */
function parseReady(value: Record<string, unknown>): HostProcessMessage {
  assertExactKeys(value, ['type', 'origin', 'binding'])
  if (typeof value.origin !== 'string' || !isRecord(value.binding)) throw new Error('Invalid Host ready message')
  assertExactKeys(value.binding, ['host', 'port'])
  if (value.binding.host !== '127.0.0.1') throw new Error('Host must bind to 127.0.0.1')
  if (!isPort(value.binding.port)) throw new Error('Host binding port is invalid')
  const expectedOrigin = hostOrigin(value.binding as unknown as HostProcessBinding)
  if (value.origin !== expectedOrigin) throw new Error('Host origin does not match binding')
  return {
    type: 'ready',
    origin: value.origin,
    binding: Object.freeze({ host: '127.0.0.1', port: value.binding.port })
  }
}

/** 校验并复制启动失败消息中的受控错误字段。 */
function parseStartupFailed(value: Record<string, unknown>): HostProcessMessage {
  assertExactKeys(value, ['type', 'error'])
  if (!isRecord(value.error)) throw new Error('Invalid Host startup failure')
  assertAllowedKeys(value.error, ['name', 'message', 'code'])
  if (typeof value.error.name !== 'string' || typeof value.error.message !== 'string') {
    throw new Error('Host startup failure fields are invalid')
  }
  if (value.error.name.length === 0 || value.error.name.length > MAX_ERROR_FIELD_LENGTH) throw new Error('Host error name is invalid')
  if (value.error.message.length > MAX_ERROR_FIELD_LENGTH) throw new Error('Host error message is invalid')
  if (value.error.code !== undefined && typeof value.error.code !== 'string' && typeof value.error.code !== 'number') {
    throw new Error('Host error code is invalid')
  }
  return {
    type: 'startup-failed',
    error: Object.freeze({
      name: value.error.name,
      message: value.error.message,
      ...(value.error.code === undefined ? {} : { code: value.error.code })
    })
  }
}

/** 判断未知值是否为不带原型约束的普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 要求协议对象只包含给定的精确字段。 */
function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = Object.keys(value).sort()
  const expected = [...allowed].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('Host process message contains unexpected fields')
  }
}

/** 校验可选字段协议对象不携带额外对象图。 */
function assertAllowedKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error('Host process message contains unexpected fields')
  }
}

/** 校验 loopback 端口为合法的非零整数。 */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_PORT
}

/** 将错误字段限制长度并提供安全默认值。 */
function boundedString(value: unknown, fallback: string, preserveFallback = false): string {
  const text = typeof value === 'string' ? value : fallback
  if (text.length === 0 && !preserveFallback) return 'Error'
  return text.slice(0, MAX_ERROR_FIELD_LENGTH)
}
