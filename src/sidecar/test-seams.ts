/** 将未知异常转换为可安全传输的错误摘要，供 sidecar 单元测试复用。 */
export function serializeError(error: unknown): { readonly name: string; readonly message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'Error', message: String(error) }
}
