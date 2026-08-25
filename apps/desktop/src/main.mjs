import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import electronUpdater from 'electron-updater'
import { createAppUpdateCoordinator } from './app-update.mjs'
import { activeConfigRoot, checkHotConfig } from './hot-config.mjs'
import { activatePackagedRuntime } from './runtime-store.mjs'
import { loadServiceEndpoints, searchEndpoint, selectServiceEndpoint } from './service-routing.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const { MacUpdater } = electronUpdater
const updateSources = [
  { provider: 'generic', url: 'https://llmapi.pro/mythos/desktop/updates/macos/arm64' },
  { provider: 'github', owner: '97wow', repo: 'deepseek-harness' },
]
const hotConfigSources = [
  {
    assetBaseUrl: 'https://llmapi.pro/mythos/desktop/config/files/',
    manifestUrl: 'https://llmapi.pro/mythos/desktop/config/manifest.json',
    signatureUrl: 'https://llmapi.pro/mythos/desktop/config/manifest.json.sig',
  },
  {
    assetBaseUrl: 'https://github.com/97wow/deepseek-harness/releases/latest/download/',
    manifestUrl: 'https://github.com/97wow/deepseek-harness/releases/latest/download/mythos-config-manifest.json',
    signatureUrl: 'https://github.com/97wow/deepseek-harness/releases/latest/download/mythos-config-manifest.json.sig',
  },
]
let hostProcess
let activeHostUrl
let mainWindow
let activeEndpoint
let updateInitialized = false
let configRevision = 0
let packagedReleaseRoot

const appUpdates = createAppUpdateCoordinator({
  createUpdater: source => new MacUpdater(source),
  isPackaged: () => app.isPackaged,
  publish: () => broadcastUpdateState(),
  // Remote failures may contain query strings or CDN details. Keep logs useful
  // without persisting provider-controlled error text that could carry secrets.
  reportError: () => checkpoint('managed update source unavailable'),
  sources: updateSources,
})

function checkpoint(message) {
  process.stdout.write(`[MYTHOS Desktop] ${message}\n`)
}

function releaseRoot() {
  if (app.isPackaged) return packagedReleaseRoot
  const override = process.env.MYTHOS_RUNTIME_ROOT
  return override === undefined || override === '' ? undefined : resolve(override)
}

function sourceHome() {
  const bundled = releaseRoot()
  return bundled === undefined
    ? join(repositoryRoot, 'products', 'mythos-agent', 'home')
    : join(bundled, 'home')
}

function configCacheRoot() {
  return join(app.getPath('userData'), 'product-config')
}

async function productConfigSource() {
  return await activeConfigRoot(configCacheRoot()) ?? sourceHome()
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
  const configSource = await productConfigSource()
  // These profile entry files are not hot-config assets, but they still belong
  // to the application release. Refresh them on every launch so an upgraded
  // Desktop never keeps an older profile resolver around newer patch files.
  for (const relativePath of [
    join('profiles', 'mythos', 'cordis.yml'),
    join('profiles', 'mythos', 'package.json'),
    join('profiles', 'mythos', 'pnpm-workspace.yaml'),
    join('profiles', 'mythos-web', 'cordis.yml'),
    join('profiles', 'mythos-web', 'package.json'),
    join('profiles', 'mythos-web', 'pnpm-workspace.yaml'),
  ]) {
    const destination = join(home, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(sourceHome(), relativePath), destination)
  }
  // Product-owned composition advances with the Desktop build while sessions,
  // credentials, workspace state, and local settings remain untouched.
  for (const relativePath of [
    join('.agent-presets', 'mythos', 'agent.cordis.yml'),
    join('.agent-presets', 'mythos', 'preset.yml'),
    join('desktop', 'service-routing.json'),
    join('profiles', 'mythos', 'cordis.patch.yml'),
    join('profiles', 'mythos-web', 'cordis.patch.yml'),
  ]) {
    const destination = join(home, relativePath)
    await mkdir(dirname(destination), { recursive: true })
    await cp(join(configSource, relativePath), destination)
  }
  const [webProfile, preset] = await Promise.all([
    readFile(join(home, 'profiles', 'mythos-web', 'cordis.patch.yml'), 'utf8'),
    readFile(join(home, '.agent-presets', 'mythos', 'preset.yml'), 'utf8'),
  ])
  if (!/default:\s*mythos/u.test(webProfile)
    || !webProfile.includes("process.env.DSH_HOME + '/.agent-presets'")
    || !/^name:\s*Mythos Agent\s*$/mu.test(preset)) {
    throw new Error('MYTHOS Agent 预设资源不完整，已停止启动以避免创建无法恢复的会话')
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
        const match = /^\s*(DEEPSEEK_API_KEY)\s*=\s*(.*?)\s*$/u.exec(line)
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
      key: encrypted === '' || !safeStorage.isEncryptionAvailable()
        ? ''
        : safeStorage.decryptString(Buffer.from(encrypted, 'base64')),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { key: '' }
    throw error
  }
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
  const key = stored.key || process.env.DEEPSEEK_API_KEY || dotenv.DEEPSEEK_API_KEY || ''
  const endpoints = await loadServiceEndpoints(await productConfigSource())
  const route = await selectServiceEndpoint(key, fetch, endpoints)
  activeEndpoint = route.endpoint
  return {
    endpoint: route.endpoint,
    key,
    reachable: route.reachable,
  }
}

async function startHost() {
  if (hostProcess !== undefined) {
    if (activeHostUrl === undefined) throw new Error('MYTHOS Host 正在启动，请稍后重试')
    return activeHostUrl
  }
  const port = await availablePort()
  const home = await ensureHome()
  const credential = await resolvedEnvironment()
  const env = {
    ...process.env,
    DEEPSEEK_BASE_URL: credential.endpoint,
    DEEPSEEK_SEARCH_BASE_URL: searchEndpoint(credential.endpoint),
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
    activeHostUrl = undefined
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
  activeHostUrl = `http://127.0.0.1:${String(port)}`
  return activeHostUrl
}

async function stopHost() {
  const child = hostProcess
  if (child === undefined) return
  hostProcess = undefined
  activeHostUrl = undefined
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

function currentUpdateState() {
  return { ...appUpdates.state(), configRevision, currentVersion: app.getVersion() }
}

function broadcastUpdateState() {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mythos:update:state', currentUpdateState())
  }
}

async function checkForUpdates() {
  await appUpdates.check()
  return currentUpdateState()
}

async function checkProductConfig() {
  const result = await checkHotConfig(configCacheRoot(), hotConfigSources)
  configRevision = result.revision
  appUpdates.notify()
  if (result.updated && hostProcess !== undefined) await restartHost()
  return result
}

function initializeUpdates() {
  if (updateInitialized) return
  updateInitialized = true
  const initialConfig = setTimeout(() => { void checkProductConfig() }, 3000)
  initialConfig.unref()
  const initial = setTimeout(() => { void checkForUpdates() }, 8000)
  initial.unref()
  const recurringConfig = setInterval(() => { void checkProductConfig() }, 30 * 60 * 1000)
  recurringConfig.unref()
  const recurring = setInterval(() => { void checkForUpdates() }, 6 * 60 * 60 * 1000)
  recurring.unref()
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
  mainWindow.once('closed', () => { mainWindow = undefined })
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
    if (app.isPackaged && packagedReleaseRoot === undefined) {
      checkpoint('activating packaged runtime')
      packagedReleaseRoot = await activatePackagedRuntime({
        archive: join(process.resourcesPath, 'mythos-runtime.tar.gz'),
        digestFile: join(process.resourcesPath, 'mythos-runtime.tar.gz.sha256'),
        storeRoot: join(app.getPath('userData'), 'runtime'),
      })
      checkpoint(`packaged runtime ready: ${packagedReleaseRoot}`)
    }
    const url = await startHost()
    checkpoint('DSH Host ready')
    await mainWindow.loadURL(url)
    checkpoint('DSH Web loaded')
    await mainWindow.webContents.insertCSS(await readFile(join(here, 'desktop-theme.css'), 'utf8'))
    initializeUpdates()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[MYTHOS Desktop] startup failed: ${message}\n`)
    await mainWindow.webContents.executeJavaScript(`document.querySelector('.step.active').textContent = ${JSON.stringify(message)}`)
  }
}

ipcMain.handle('mythos:settings:test', async () => {
  const previousEndpoint = activeEndpoint
  const credential = await resolvedEnvironment()
  const changed = previousEndpoint !== undefined && previousEndpoint !== credential.endpoint
  if (changed) await restartHost()
  return { ok: credential.reachable && hostProcess !== undefined && hostProcess.exitCode === null }
})
ipcMain.handle('mythos:update:get', () => currentUpdateState())
ipcMain.handle('mythos:update:check', async () => {
  await checkProductConfig()
  return await checkForUpdates()
})
ipcMain.handle('mythos:update:restart', () => {
  return appUpdates.restartAndUpdate()
})

checkpoint('main module loaded')
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) {
  checkpoint('another Desktop instance already owns the session store')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined || mainWindow.isDestroyed()) {
      void createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('before-quit', () => {
    app.isQuitting = true
    hostProcess?.kill('SIGTERM')
  })
  app.on('before-quit-for-update', () => {
    app.isQuitting = true
    hostProcess?.kill('SIGTERM')
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })

  await app.whenReady()
  checkpoint('app ready')
  await createWindow()
}
