import { connectStartupPage } from './controller.js'

const api = window.desktopStartup
if (!api) throw new Error('Desktop startup bridge is unavailable')
connectStartupPage(api, document)
