export const UPDATE_CLIENT_STYLE = `
.dsh-desktop-update-action{align-items:center;background:transparent;border:0;border-radius:10px;color:var(--dsw-alias-label-secondary);cursor:pointer;display:flex;gap:8px;min-height:36px;min-width:36px;padding:6px 8px;width:100%}
.dsh-desktop-update-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-desktop-update-action[data-wide=false]{justify-content:center;padding:6px;width:36px}
.dsh-desktop-update-icon{align-items:center;display:inline-flex;font-size:16px;height:20px;justify-content:center;position:relative;width:20px}
.dsh-desktop-update-action[data-tone=failed] .dsh-desktop-update-icon{color:var(--dsw-alias-status-error)}
.dsh-desktop-update-action[data-tone=staged] .dsh-desktop-update-icon{color:var(--dsw-alias-status-success)}
.dsh-desktop-update-copy{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-desktop-update-progress{background:var(--dsw-alias-border-l2);border-radius:999px;height:3px;inset:auto 5px 2px;overflow:hidden;position:absolute}
.dsh-desktop-update-progress>span{background:currentColor;display:block;height:100%}
.dsh-desktop-update-progress[data-indeterminate=true]>span{animation:dsh-desktop-update-progress 1.2s ease-in-out infinite;width:45%}
@keyframes dsh-desktop-update-progress{from{transform:translateX(-120%)}to{transform:translateX(240%)}}
@media (prefers-reduced-motion:reduce){.dsh-desktop-update-progress[data-indeterminate=true]>span{animation:none;width:100%}}
`

/** 安装由更新插件拥有的样式，并返回幂等清理函数。 */
export function installUpdateClientStyle(documentObject: Document = document) {
  const selector = 'style[data-plugin-css="@cyunlab/dsh-desktop-update-client"]'
  if (documentObject.querySelector(selector)) return () => undefined
  const style = documentObject.createElement('style')
  style.dataset.plugin = '@cyunlab/dsh-desktop-update-client'
  style.dataset.pluginCss = '@cyunlab/dsh-desktop-update-client'
  style.textContent = UPDATE_CLIENT_STYLE
  documentObject.head.append(style)
  /** 移除当前插件实例安装的样式。 */
  return function disposeUpdateClientStyle() {
    style.remove()
  }
}
