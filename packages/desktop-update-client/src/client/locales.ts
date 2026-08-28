export const UPDATE_LOCALE_NAMESPACE = 'dsh-desktop-update'

export const zh = {
  available: '有新版本 {version}',
  downloading: '正在下载更新 {version}',
  failed: '更新失败',
  staged: '重启以更新到 {version}',
} as const

export const en = {
  available: 'Update {version} is available',
  downloading: 'Downloading update {version}',
  failed: 'Update failed',
  staged: 'Restart to update to {version}',
} satisfies Record<keyof typeof zh, string>

export type UpdateLocaleKey = keyof typeof zh

/** 使用简体中文词典格式化测试与无 Locale seat 时的文案。 */
export function translateZh(key: UpdateLocaleKey, parameters: Record<string, unknown> = {}) {
  return zh[key].replaceAll(/\{(\w+)\}/g, (_match, name: string) => String(parameters[name] ?? ''))
}
