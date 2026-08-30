import { describe, expect, it } from 'vitest'
import { buildTauriArguments } from '../../scripts/run-tauri.mjs'

const publicKey = 'untrusted comment: minisign public key: 29315C4AA703DC93\nRWST3AOnSlwxKdQeGVbg9+u22K2c7niKQPaCJy4ECs9GpC6Moedx+9uf'

describe('Tauri command launcher', () => {
  /** 正式 build 必须把同一份 updater 公钥同时交给 bundler 配置。 */
  it('injects the updater public key into release build configuration', () => {
    const args = buildTauriArguments('build', ['--verbose'], { DSH_UPDATER_PUBLIC_KEY: publicKey })
    expect(args.slice(0, 3)).toEqual(['build', '--config', JSON.stringify({ plugins: { updater: { pubkey: publicKey } } })])
    expect(args.at(-1)).toBe('--verbose')
  })

  /** 二次 base64 包装会令 Tauri 无法解析公钥，必须在昂贵打包前拒绝。 */
  it('rejects an encoded public-key file instead of producing unsigned updater artifacts', () => {
    expect(() => buildTauriArguments('build', [], { DSH_UPDATER_PUBLIC_KEY: Buffer.from(publicKey).toString('base64') }))
      .toThrow('minisign public key')
  })

  /** 开发与行为测试不应被正式发布配置污染。 */
  it('leaves non-release commands unchanged', () => {
    expect(buildTauriArguments('dev', ['--debug'], { DSH_UPDATER_PUBLIC_KEY: publicKey })).toEqual(['dev', '--debug'])
    expect(buildTauriArguments('build', ['--debug'], {})).toEqual(['build', '--debug'])
  })
})
