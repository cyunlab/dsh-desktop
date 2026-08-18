import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
  stdio: 'ignore'
})
if (process.env.DSH_TREE_PID_FILE && descendant.pid) writeFileSync(process.env.DSH_TREE_PID_FILE, String(descendant.pid))
process.on('SIGTERM', () => {})
if (process.env.DSH_TREE_EXIT_LEADER === '1') setTimeout(() => process.exit(1), 20)
setInterval(() => {}, 1000)
