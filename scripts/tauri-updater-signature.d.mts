/** 使用 Node 内置 Ed25519 对真实 updater 包验证 Tauri minisign 签名。 */
export function verifyTauriUpdaterSignature(packageBytes: Buffer, encodedSignature: string, encodedPublicKey: string): Promise<true>
