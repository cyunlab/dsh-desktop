import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'

/** 解码 Tauri 配置对 minisign 文本增加的外层 base64。 */
function decodeTauriText(value, label) {
  const input = String(value ?? '').trim()
  if (!input) throw new Error(`invalid ${label}`)
  const decoded = Buffer.from(input, 'base64').toString('utf8')
  if (Buffer.from(decoded).toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) throw new Error(`invalid ${label}`)
  return decoded
}

/** 解析 minisign 公钥 packet、key id 与 Ed25519 key。 */
function parsePublicKey(encoded) {
  const lines = decodeTauriText(encoded, 'updater public key').trim().split(/\r?\n/)
  const packet = Buffer.from(lines[1] ?? '', 'base64')
  if (lines.length !== 2 || packet.length !== 42 || !['Ed', 'ED'].includes(packet.subarray(0, 2).toString('ascii'))) throw new Error('invalid updater public key')
  return { id: packet.subarray(2, 10), key: packet.subarray(10) }
}

/** 解析 Tauri `.sig` 的 minisign signature 与可信注释。 */
function parseSignature(encoded) {
  const lines = decodeTauriText(encoded, 'updater signature').trim().split(/\r?\n/)
  const packet = Buffer.from(lines[1] ?? '', 'base64')
  const global = Buffer.from(lines[3] ?? '', 'base64')
  if (lines.length !== 4 || !lines[2].startsWith('trusted comment: ') || packet.length !== 74 || global.length !== 64 || !['Ed', 'ED'].includes(packet.subarray(0, 2).toString('ascii'))) throw new Error('invalid updater signature')
  return { algorithm: packet.subarray(0, 2).toString('ascii'), id: packet.subarray(2, 10), signature: packet.subarray(10), comment: lines[2].slice(17), global }
}

/** 使用 Node 内置 Ed25519 对真实 updater 包验证 Tauri minisign 签名。 */
export async function verifyTauriUpdaterSignature(packageBytes, encodedSignature, encodedPublicKey) {
  const publicKey = parsePublicKey(encodedPublicKey)
  const signature = parseSignature(encodedSignature)
  if (!publicKey.id.equals(signature.id)) throw new Error('invalid updater signature key id')
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey.key]), format: 'der', type: 'spki' })
  const message = signature.algorithm === 'ED' ? createHash('blake2b512').update(packageBytes).digest() : packageBytes
  if (!verifySignature(null, message, key, signature.signature)) throw new Error('invalid updater package signature')
  if (!verifySignature(null, Buffer.concat([signature.signature, Buffer.from(signature.comment)]), key, signature.global)) throw new Error('invalid updater global signature')
  return true
}
