import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const defaultEndpoint = 'https://d.llmapi.pro:99'
let hostProcess
let mainWindow

function checkpoint(message) {
  process.stdout.write(`[MYTHOS Desktop] ${message}\n`)
}

function releaseRoot() {
  if (app.isPackaged) return join(process.resourcesPath, 'mythos-agent')
  const override = process.env.MYTHOS_RUNTIME_ROOT
  return override === undefined || override === '' ? undefined : resolve(override)
}

function sourceHome() {
  const bundled = releaseRoot()
  return bundled === undefined
    ? join(repositoryRoot, 'products', 'mythos-agent', 'home')
    : join(bundled, 'home')
}

async function ensureHome() {
  if (!app.isPackaged && releaseRoot() === undefined) {
    const home = sourceHome()
    checkpoint(`runtime home: ${home}`)
    return home
  }
  const home = join(app.getPath('userData'), 'dsh-home')
  checkpoint(`runtime home: ${home}`)
  if (!existsSync(join(home, 'profiles', 'mythos-web', 'cordis.yml'))) {
    await mkdir(home, { recursive: true })
    await cp(sourceHome(), home, { recursive: true })
  }
  // Product-owned composition advances with the Desktop build while sessions,
  // credentials, workspace state, and local settings remain untouched.
  for (const relativePath of [
    join('.agent-presets', 'mythos', 'agent.cordis.yml'),
    join('.agent-presets', 'mythos', 'preset.yml'),
    join('profiles', 'mythos', 'cordis.patch.yml'),
    join('profiles', 'mythos-web', 'cordis.patch.yml'),
  ]) {
    const destination = join(home, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(sourceHome(), relativePath), destination)
  }
  return home
}

function runtimeCli() {
  const bundled = releaseRoot()
  return bundled === undefined
    ? join(repositoryRoot, 'apps', 'cli', 'lib', 'bin.js')
    : join(bundled, 'runtime', 'dsh', 'lib', 'bin.js')
}

async function readDotEnv() {
  const candidates = [
    process.env.MYTHOS_ENV_FILE,
    '/Users/huhu/Work/mythos-agent/.env',
    join(repositoryRoot, '.env'),
  ].filter(value => typeof value === 'string' && value !== '')
  for (const path of candidates) {
    try {
      const source = await readFile(path, 'utf8')
      const result = {}
      for (const line of source.split(/\r?\n/u)) {
        const match = /^\s*(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL)\s*=\s*(.*?)\s*$/u.exec(line)
        if (match?.[1] === undefined || match[2] === undefined) continue
        result[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, '$2')
      }
      return result
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return {}
}

function settingsPath() {
  return join(app.getPath('userData'), 'secure-settings.json')
}

async function readSettings() {
  try {
    const stored = JSON.parse(await readFile(settingsPath(), 'utf8'))
    const encrypted = typeof stored.encryptedKey === 'string' ? stored.encryptedKey : ''
    return {
      endpoint: validatedEndpoint(stored.endpoint ?? defaultEndpoint),
      key: encrypted === '' || !safeStorage.isEncryptionAvailable()
        ? ''
        : safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { endpoint: defaultEndpoint, key: '' }
    throw error
  }
}

function validatedEndpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('Endpoint 必须是没有内嵌凭据的 HTTPS 地址')
  }
  return url.toString().replace(/\/$/u, '')
}

async function writeSettings(input) {
  const current = await readSettings()
  const endpoint = validatedEndpoint(input.endpoint)
  const key = typeof input.key === 'string' && input.key !== '' ? input.key : current.key
  if (key !== '' && !safeStorage.isEncryptionAvailable()) throw new Error('macOS 安全存储当前不可用')
  const encryptedKey = key === '' ? '' : safeStorage.encryptString(key).toString('base64')
  await mkdir(dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), `${JSON.stringify({ endpoint, encryptedKey })}\n`, { mode: 0o600 })
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'string' || address === null) return reject(new Error('无法分配本地端口'))
      const { port } = address
      server.close(error => error === undefined ? resolvePort(port) : reject(error))
    })
  })
}

async function resolvedEnvironment() {
  const [stored, dotenv] = await Promise.all([readSettings(), readDotEnv()])
  return {
    endpoint: stored.endpoint || dotenv.DEEPSEEK_BASE_URL || defaultEndpoint,
    key: stored.key || process.env.DEEPSEEK_API_KEY || dotenv.DEEPSEEK_API_KEY || '',
  }
}

async function startHost() {
  if (hostProcess !== undefined) return
  const port = await availablePort()
  const home = await ensureHome()
  const credential = await resolvedEnvironment()
  const env = {
    ...process.env,
    DEEPSEEK_BASE_URL: credential.endpoint,
    DSH_HOME: home,
    // Electron owns the visible desktop lifetime. Keep directory selection in
    // DSH Web so one UI request maps to one Host registration and cannot
    // outlive/reopen behind BrowserWindow through a detached osascript.
    DSH_DIRECTORY_PICKER: 'browse',
    DSH_TELEMETRY_DISABLED: '1',
  }
  const command = app.isPackaged || releaseRoot() !== undefined ? process.execPath : 'node'
  const nodeArgs = command === process.execPath ? ['--expose-internals'] : []
  if (command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  if (credential.key !== '') env.DEEPSEEK_API_KEY = credential.key
  hostProcess = spawn(command, [...nodeArgs, runtimeCli(), '--profile', 'mythos-web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: releaseRoot() ?? repositoryRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  hostProcess.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString('utf8')).slice(-12000) })
  hostProcess.once('exit', code => {
    if (code !== 0) process.stderr.write(`[MYTHOS Desktop] Host exit ${String(code)}\n${diagnostics}\n`)
    hostProcess = undefined
    if (!app.isQuitting && mainWindow !== undefined && !mainWindow.isDestroyed()) {
      void mainWindow.loadFile(join(here, 'loading.html')).then(() => {
        mainWindow.webContents.executeJavaScript(`document.querySelector('.step.active').textContent = ${JSON.stringify(`Host 已停止（${String(code)}）`)}`)
      })
    }
  })
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`DSH Host 启动超时\n${diagnostics}`)), 90000)
    hostProcess.stdout.on('data', chunk => {
      if (!chunk.toString('utf8').includes('dsh web:')) return
      clearTimeout(timer)
      resolveReady()
    })
    hostProcess.once('error', error => { clearTimeout(timer); reject(error) })
    hostProcess.once('exit', code => { clearTimeout(timer); reject(new Error(`DSH Host 启动失败（${String(code)}）\n${diagnostics}`)) })
  })
  return `http://127.0.0.1:${String(port)}`
}

async function stopHost() {
  const child = hostProcess
  if (child === undefined) return
  hostProcess = undefined
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 5000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function restartHost() {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  await mainWindow.loadFile(join(here, 'loading.html'))
  await stopHost()
  const url = await startHost()
  await mainWindow.loadURL(url)
}

async function createWindow() {
  checkpoint('createWindow')
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0d1624',
    title: 'MYTHOS',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 13 },
    show: false,
    webPreferences: {
      preload: join(here, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  checkpoint('BrowserWindow created')
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  await mainWindow.loadFile(join(here, 'loading.html'))
  checkpoint('loading screen loaded')
  mainWindow.show()
  checkpoint('window shown')
  try {
    const url = await startHost()
    checkpoint('DSH Host ready')
    await mainWindow.loadURL(url)
    checkpoint('DSH Web loaded')
    await mainWindow.webContents.insertCSS(await readFile(join(here, 'desktop-theme.css'), 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[MYTHOS Desktop] startup failed: ${message}\n`)
    await mainWindow.webContents.executeJavaScript(`document.querySelector('.step.active').textContent = ${JSON.stringify(message)}`)
  }
}

ipcMain.handle('mythos:settings:get', async () => {
  const settings = await resolvedEnvironment()
  return { endpoint: settings.endpoint, hasKey: settings.key !== '' }
})
ipcMain.handle('mythos:settings:test', async () => ({
  ok: hostProcess !== undefined && hostProcess.exitCode === null,
}))
ipcMain.handle('mythos:settings:save', async (_event, input) => {
  if (typeof input !== 'object' || input === null || typeof input.endpoint !== 'string' || typeof input.key !== 'string') {
    throw new Error('设置格式无效')
  }
  await writeSettings(input)
  await restartHost()
})

checkpoint('main module loaded')
app.on('before-quit', () => { app.isQuitting = true })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })

await app.whenReady()
checkpoint('app ready')
await createWindow()
