import { spawn } from 'node:child_process'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OUTPUT_BOUND = 128 * 1024
const HOSTS_BOUND = 1024 * 1024
const SERVER_SCRIPT = path.resolve(import.meta.dirname, 'update-smoke-tls-gate-server.mjs')

/** 向独立 child process group 发送信号，Windows 则终止 exact child。 */
function signalChild(child, signal) {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, signal) } catch {}
  }
  try { child.kill(signal) } catch {}
}

/** 无 shell 执行有界系统命令，并只传入显式环境。 */
export function runBoundedCommand(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    let terminationReason
    let finished = false
    let hardKillTimeout
    let reapTimeout
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.environment ?? {},
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks = []
    let bytes = 0
    const graceMilliseconds = options.terminationGraceMilliseconds ?? 2_000
    /** 只完成一次 Promise，并清理全部强制回收 timer。 */
    const finish = (error, output) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      clearTimeout(hardKillTimeout)
      clearTimeout(reapTimeout)
      if (error) reject(error)
      else resolve(output)
    }
    /** 先 TERM、再 KILL，并以独立 deadline 保证调用方绝不会无限等待。 */
    const terminate = reason => {
      if (terminationReason) return
      terminationReason = reason
      signalChild(child, 'SIGTERM')
      hardKillTimeout = setTimeout(() => signalChild(child, 'SIGKILL'), graceMilliseconds)
      reapTimeout = setTimeout(() => finish(new Error(`${path.basename(executable)} ${reason} and could not be reaped`)), graceMilliseconds * 2)
    }
    const timeout = setTimeout(() => {
      terminate('timed out')
    }, options.timeoutMilliseconds ?? 5 * 60 * 1000)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length
      if (bytes <= (options.outputBound ?? OUTPUT_BOUND)) chunks.push(chunk)
      else terminate('output exceeded byte bound')
    })
    child.once('error', error => {
      finish(error)
    })
    child.once('close', code => {
      const output = Buffer.concat(chunks).toString('utf8')
      if (terminationReason) finish(new Error(`${path.basename(executable)} ${terminationReason}`))
      else if (code !== 0) finish(new Error(`${path.basename(executable)} failed (${code}): ${output.trim().slice(0, 2048)}`))
      else finish(undefined, output)
    })
  })
}

/** 只选择系统命令、证书工具和 Desktop 启动所需的公开 runner 环境。 */
function selectCommandEnvironment(environment) {
  const names = [
    'PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'PSModulePath', 'OS',
    'HOME', 'USERPROFILE', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'TMPDIR',
  ]
  return Object.fromEntries(names.flatMap(name => environment[name] === undefined ? [] : [[name, environment[name]]]))
}

/** 在不改写既有内容的前提下，追加唯一的 exact hostname loopback 映射。 */
export function buildTemporaryHostsBytes(original, hostname, address) {
  if (!Buffer.isBuffer(original) || original.length > HOSTS_BOUND || original.includes(0)) throw new Error('runner hosts file is outside the byte bound')
  if (hostname !== 'updates.cyunlab.com' || address !== '127.0.0.1') throw new Error('runner hosts mapping must be the exact update hostname and loopback address')
  const body = original.toString('utf8')
  const existing = body.split(/\r?\n/).some(line => {
    const content = line.split('#', 1)[0].trim()
    return content && content.split(/\s+/).slice(1).includes(hostname)
  })
  if (existing) throw new Error('runner hosts file already contains the update hostname')
  const newline = body.includes('\r\n') ? '\r\n' : '\n'
  const separator = body.length === 0 || body.endsWith('\n') ? '' : newline
  return Buffer.from(`${body}${separator}${address} ${hostname}${newline}`)
}

/** 为唯一临时 CA 生成各平台精确、可逆的信任存储命令。 */
export function tlsTrustCommandPlan(platform, identity, linuxDestination) {
  if (platform === 'darwin') return {
    install: { executable: 'sudo', args: ['-n', 'security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', identity.authority] },
    remove: { executable: 'sudo', args: ['-n', 'security', 'delete-certificate', '-Z', identity.sha1Fingerprint, '/Library/Keychains/System.keychain'] },
  }
  if (platform === 'win32') return {
    install: { executable: 'certutil.exe', args: ['-addstore', '-f', 'Root', identity.authority] },
    remove: { executable: 'certutil.exe', args: ['-delstore', 'Root', identity.sha1Fingerprint] },
  }
  if (platform === 'linux') return {
    install: [
      { executable: 'sudo', args: ['-n', 'install', '-m', '0644', identity.authority, linuxDestination] },
      { executable: 'sudo', args: ['-n', 'update-ca-certificates'] },
    ],
    remove: [
      { executable: 'sudo', args: ['-n', 'rm', '-f', '--', linuxDestination] },
      { executable: 'sudo', args: ['-n', 'update-ca-certificates'] },
    ],
  }
  throw new Error(`unsupported TLS trust platform: ${platform}`)
}

/** 顺序执行一个或多个精确命令计划。 */
async function executePlan(plan, command, environment) {
  for (const item of Array.isArray(plan) ? plan : [plan]) await command(item.executable, item.args, { environment })
}

/** 解析 OpenSSL SHA-1 指纹为 certutil/security 接受的唯一大写十六进制。 */
function parseSha1Fingerprint(output) {
  const value = output.trim().split('=').at(-1)?.replaceAll(':', '').toUpperCase()
  if (!/^[0-9A-F]{40}$/.test(value ?? '')) throw new Error('temporary CA SHA-1 fingerprint is invalid')
  return value
}

/** 创建由 runner trust store 接受、只覆盖 exact update hostname 的临时 CA 与 leaf。 */
async function createTlsIdentity(config, command, environment) {
  if (config.hostname !== 'updates.cyunlab.com') throw new Error('temporary TLS identity requires the exact update hostname')
  const authority = path.join(config.directory, 'authority.pem')
  const authorityKey = path.join(config.directory, 'authority.key')
  const certificate = path.join(config.directory, 'leaf.pem')
  const key = path.join(config.directory, 'leaf.key')
  const request = path.join(config.directory, 'leaf.csr')
  const authorityConfig = path.join(config.directory, 'authority.cnf')
  const leafConfig = path.join(config.directory, 'leaf.cnf')
  await Promise.all([
    writeFile(authorityConfig, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3_ca\n[dn]\nCN=DSH Desktop Update Smoke Temporary CA\n[v3_ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign,digitalSignature\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n'),
    writeFile(leafConfig, `[req]\nprompt=no\ndistinguished_name=dn\nreq_extensions=v3_req\n[dn]\nCN=${config.hostname}\n[v3_req]\nsubjectAltName=DNS:${config.hostname}\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`),
  ])
  await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-config', authorityConfig, '-keyout', authorityKey, '-out', authority], { environment })
  await command('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-config', leafConfig, '-keyout', key, '-out', request], { environment })
  await command('openssl', ['x509', '-req', '-in', request, '-CA', authority, '-CAkey', authorityKey, '-CAcreateserial', '-days', '1', '-sha256', '-extfile', leafConfig, '-extensions', 'v3_req', '-out', certificate], { environment })
  const sha1Fingerprint = parseSha1Fingerprint(await command('openssl', ['x509', '-in', authority, '-noout', '-fingerprint', '-sha1'], { environment }))
  await Promise.all([chmod(authorityKey, 0o600), chmod(key, 0o600)])
  return Object.freeze({ authority, authorityKey, certificate, key, directory: config.directory, sha1Fingerprint, trustName: `dsh-update-smoke-${sha1Fingerprint.slice(0, 12)}` })
}

/** 创建受控 root child，并把 JSONL 事件转换为有界一次性等待。 */
function startGateChild(config, environment, command) {
  const arguments_ = [SERVER_SCRIPT, '--hostname', config.hostname, '--pathname', config.pathname, '--certificate', config.identity.certificate, '--key', config.identity.key, '--manifest', config.manifestPath]
  const executable = process.platform === 'win32' ? process.execPath : 'sudo'
  const args = process.platform === 'win32' ? arguments_ : ['-n', process.execPath, ...arguments_]
  const child = spawn(executable, args, { env: environment, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let exited
  const waiters = new Map()
  const observed = new Set()
  /** 拒绝所有未完成事件等待，保留最先出现的 helper 根因。 */
  const rejectWaiters = error => {
    for (const waiter of waiters.values()) waiter.reject(error)
    waiters.clear()
  }
  /** 记录一次 server 事件，或完成它已有的唯一 waiter。 */
  const observe = event => {
    const waiter = waiters.get(event)
    if (waiter) {
      waiters.delete(event)
      waiter.resolve()
    } else {
      observed.add(event)
    }
  }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
    if (Buffer.byteLength(stdout) > OUTPUT_BOUND) {
      const error = new Error('TLS gate server output exceeded byte bound')
      rejectWaiters(error)
      void stop(false).catch(stopError => rejectWaiters(new AggregateError([error, stopError], error.message)))
      return
    }
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline < 0) break
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      try { observe(JSON.parse(line).event) } catch { rejectWaiters(new Error('TLS gate server emitted invalid JSONL')) }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    if (Buffer.byteLength(stderr) < OUTPUT_BOUND) stderr += chunk.slice(0, OUTPUT_BOUND - Buffer.byteLength(stderr))
  })
  child.once('error', error => {
    exited = { code: null, signal: null, stderr: error.message }
    rejectWaiters(error)
  })
  child.once('exit', (code, signal) => {
    exited = { code, signal, stderr: stderr.trim() }
    if (code !== 0) rejectWaiters(new Error(`TLS gate server failed (${code}): ${stderr.trim().slice(0, 2048)}`))
  })
  /** 等待一个 server 事件，或在 child 异常退出/超时后失败。 */
  function waitFor(event, timeoutMilliseconds = 30_000) {
    if (observed.delete(event)) return Promise.resolve()
    if (exited) return Promise.reject(new Error(`TLS gate server exited before ${event} (${exited.code}): ${exited.stderr}`))
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(event)
        reject(new Error(`TLS gate server timed out waiting for ${event}`))
      }, timeoutMilliseconds)
      waiters.set(event, {
        resolve: () => { clearTimeout(timeout); resolve() },
        reject: error => { clearTimeout(timeout); reject(error) },
      })
    })
  }
  /** 向 root helper 发送一个无路径、无密钥的固定控制命令。 */
  function send(command) {
    child.stdin.write(`${JSON.stringify({ command })}\n`)
  }
  /** 读取 sudo wrapper 或 Windows helper 的当前退出记录。 */
  function currentExit() {
    return exited
  }
  /** 用提权 signal 0 判断 Unix exact process group 是否仍有成员。 */
  async function unixProcessGroupExists() {
    try {
      await command('sudo', ['-n', '/bin/kill', '-0', '--', `-${child.pid}`], { environment, timeoutMilliseconds: 5_000 })
      return true
    } catch (error) {
      if (/no such process|not found/i.test(error.message)) return false
      throw error
    }
  }
  /** 等待 wrapper 退出且整个 helper process group 在 deadline 内消失。 */
  async function waitForReaped(timeoutMilliseconds) {
    const deadline = Date.now() + timeoutMilliseconds
    while (Date.now() < deadline) {
      if (process.platform === 'win32' ? Boolean(exited) : exited && !(await unixProcessGroupExists())) return exited
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return undefined
  }
  /** 优先走控制通道；失效后按 exact process group 提权 TERM/KILL 并确认回收。 */
  async function stop(graceful = true) {
    if (await waitForReaped(1)) return exited
    if (graceful) {
      try { send('close') } catch {}
      if (await waitForReaped(10_000)) return exited
    }
    if (process.platform === 'win32') {
      await command('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { environment }).catch(() => {})
    } else {
      await command('sudo', ['-n', '/bin/kill', '-TERM', '--', `-${child.pid}`], { environment, timeoutMilliseconds: 5_000 }).catch(() => {})
      if (await waitForReaped(2_000)) return exited
      await command('sudo', ['-n', '/bin/kill', '-KILL', '--', `-${child.pid}`], { environment, timeoutMilliseconds: 5_000 }).catch(() => {})
    }
    if (!(await waitForReaped(2_000))) throw new Error('TLS gate server process group could not be reaped')
    return exited
  }
  return { child, waitFor, send, stop, exited: currentExit }
}

/** 刷新本机 DNS cache；不支持缓存服务时保留 hosts mutation 的主结果。 */
async function flushDns(platform, command, environment) {
  const plans = platform === 'darwin'
    ? [{ executable: 'dscacheutil', args: ['-flushcache'] }, { executable: 'sudo', args: ['-n', 'killall', '-HUP', 'mDNSResponder'] }]
    : platform === 'win32'
      ? [{ executable: 'ipconfig.exe', args: ['/flushdns'] }]
      : [{ executable: 'resolvectl', args: ['flush-caches'] }]
  for (const plan of plans) await command(plan.executable, plan.args, { environment }).catch(() => {})
}

/** 返回 runner-only TLS gate 的真实系统适配器。 */
export function createUpdateSmokeTlsSystemAdapter(environment = process.env, dependencies = {}) {
  const command = dependencies.runCommand ?? runBoundedCommand
  const commandEnvironment = selectCommandEnvironment(environment)
  const platform = dependencies.platform ?? process.platform
  const hostsPath = dependencies.hostsPath ?? (platform === 'win32'
    ? path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')
    : '/etc/hosts')
  let originalHosts
  let temporaryHostsPath
  let originalHostsPath
  let trustPlan
  return {
    /** 生成本次 runner 唯一的临时 CA 与 leaf。 */
    createTlsIdentity: config => createTlsIdentity(config, command, commandEnvironment),
    /** 安装唯一临时 CA，不触碰其他信任根。 */
    async installCertificateAuthority(identity) {
      const linuxDestination = `/usr/local/share/ca-certificates/${identity.trustName}.crt`
      trustPlan = tlsTrustCommandPlan(platform, identity, linuxDestination)
      try {
        await executePlan(trustPlan.install, command, commandEnvironment)
      } catch (error) {
        await executePlan(trustPlan.remove, command, commandEnvironment).catch(() => {})
        trustPlan = undefined
        throw error
      }
    },
    /** 启动 root port 443 exact-path hold server。 */
    async startHttpsGate(config) {
      const manifestPath = path.join(config.identity.directory, 'candidate-manifest.json')
      await writeFile(manifestPath, config.manifest, { flag: 'wx' })
      const control = startGateChild({ ...config, manifestPath }, commandEnvironment, command)
      try {
        await control.waitFor('ready')
      } catch (error) {
        let cleanupError
        try { await control.stop(false) } catch (failure) { cleanupError = failure }
        if (cleanupError) throw new AggregateError([error, cleanupError], error.message)
        throw error
      }
      return {
        /** 等候真实 Desktop 请求到达 root helper。 */
        waitForRequest: () => control.waitFor('request', 4 * 60 * 1000),
        /** 恢复 DNS 后让已建立连接收到 byte-exact manifest。 */
        async releaseManifest() { control.send('release'); await control.waitFor('released') },
        /** 关闭并确认 root helper 已退出。 */
        async close() {
          await control.stop(true)
          if (control.exited().code !== 0) throw new Error(`TLS gate server cleanup failed (${control.exited().code})`)
        },
      }
    },
    /** byte-for-byte 备份 hosts 后只追加 exact mapping。 */
    async routeHostname(hostname, address) {
      if (originalHosts) throw new Error('runner hosts mapping is already installed')
      originalHosts = await readFile(hostsPath)
      const temporary = buildTemporaryHostsBytes(originalHosts, hostname, address)
      const writableDirectory = dependencies.temporaryDirectory ?? environment.RUNNER_TEMP ?? environment.TEMP ?? environment.TMPDIR
      if (!writableDirectory) throw new Error('runner temporary directory is unavailable')
      temporaryHostsPath = path.join(writableDirectory, `dsh-update-smoke-hosts-${process.pid}.temporary`)
      originalHostsPath = path.join(writableDirectory, `dsh-update-smoke-hosts-${process.pid}.original`)
      await Promise.all([writeFile(temporaryHostsPath, temporary, { flag: 'wx' }), writeFile(originalHostsPath, originalHosts, { flag: 'wx' })])
      if (platform === 'win32') await writeFile(hostsPath, temporary)
      else await command('sudo', ['-n', 'install', '-m', '0644', temporaryHostsPath, hostsPath], { environment: commandEnvironment })
      await flushDns(platform, command, commandEnvironment)
    },
    /** 从独立备份 byte-for-byte 恢复 hosts 并验证内容。 */
    async restoreHostname() {
      if (!originalHosts || !originalHostsPath) return
      if (platform === 'win32') await writeFile(hostsPath, originalHosts)
      else await command('sudo', ['-n', 'install', '-m', '0644', originalHostsPath, hostsPath], { environment: commandEnvironment })
      await flushDns(platform, command, commandEnvironment)
      const restored = await readFile(hostsPath)
      if (!restored.equals(originalHosts)) throw new Error('runner hosts bytes were not restored exactly')
      originalHosts = undefined
    },
    /** 删除本次唯一临时 CA。 */
    async removeCertificateAuthority() {
      if (trustPlan) await executePlan(trustPlan.remove, command, commandEnvironment)
      trustPlan = undefined
      for (const file of [temporaryHostsPath, originalHostsPath]) if (file && (await stat(file).catch(() => null))) await import('node:fs/promises').then(module => module.rm(file, { force: true }))
    },
  }
}
