process.stdout.write(JSON.stringify({
  nodeMode: process.env.ELECTRON_RUN_AS_NODE === '1',
  cwd: process.cwd()
}))
