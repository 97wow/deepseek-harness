import { contextBridge, ipcRenderer } from 'electron'
import { adaptMythosSurface } from './presentation.mjs'

const api = {
  testConnection: () => ipcRenderer.invoke('mythos:settings:test'),
  getUpdateState: () => ipcRenderer.invoke('mythos:update:get'),
  checkForUpdates: () => ipcRenderer.invoke('mythos:update:check'),
  restartAndUpdate: () => ipcRenderer.invoke('mythos:update:restart'),
}
contextBridge.exposeInMainWorld('mythosDesktop', api)

const updatePresenters = new Set()
ipcRenderer.on('mythos:update:state', (_event, state) => {
  for (const present of updatePresenters) present(state)
})

function createElement(tag, className, text) {
  const element = document.createElement(tag)
  if (className !== '') element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

function openSettings() {
  const shade = createElement('div', 'mythos-settings-shade')
  const panel = createElement('section', 'mythos-settings')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', '应用状态与更新')
  const title = createElement('h2', '', '应用状态与更新')
  const service = createElement('section', 'mythos-settings__service')
  const serviceCopy = createElement('div')
  serviceCopy.append(
    createElement('strong', '', '智能服务'),
    createElement('span', '', '默认 · 服务可用'),
  )
  const test = createElement('button', '', '测试连接')
  service.append(serviceCopy, test)
  const testResult = createElement('p', 'mythos-settings__result', 'MYTHOS 已准备好处理项目任务。')
  const updates = createElement('section', 'mythos-settings__service')
  const updateCopy = createElement('div')
  const updateVersion = createElement('span', '', '正在读取版本…')
  updateCopy.append(createElement('strong', '', '应用更新'), updateVersion)
  const updateAction = createElement('button', '', '检查更新')
  updates.append(updateCopy, updateAction)
  const updateResult = createElement('p', 'mythos-settings__result', 'MYTHOS 会在后台自动检查并下载可用更新。')
  const foot = createElement('div', 'mythos-settings__foot')
  const closeButton = createElement('button', '', '关闭')
  closeButton.dataset.primary = ''
  foot.append(closeButton)
  panel.append(title, service, testResult, updates, updateResult, foot)
  shade.append(panel)
  document.body.append(shade)
  const close = () => {
    updatePresenters.delete(renderUpdate)
    shade.remove()
  }
  closeButton.addEventListener('click', close)
  shade.addEventListener('click', event => { if (event.target === shade) close() })
  document.addEventListener('keydown', function escape(event) {
    if (event.key !== 'Escape' || !shade.isConnected) return
    document.removeEventListener('keydown', escape)
    close()
  })
  test.focus()
  test.addEventListener('click', async () => {
    test.disabled = true
    test.textContent = '正在测试…'
    try {
      const result = await api.testConnection()
      testResult.textContent = result.ok ? '连接正常，服务可用。' : '当前无法连接，MYTHOS 会自动切换备用线路并重试。'
    } catch {
      testResult.textContent = '当前无法连接，MYTHOS 会自动切换备用线路并重试。'
    } finally {
      test.disabled = false
      test.textContent = '测试连接'
    }
  })
  const renderUpdate = state => {
    const configLabel = state.configRevision > 0 ? `配置 ${state.configRevision}` : '内置配置'
    updateVersion.textContent = `当前版本 ${state.currentVersion} · ${configLabel}`
    updateAction.disabled = state.state === 'checking' || state.state === 'downloading'
    if (state.state === 'checking') {
      updateAction.textContent = '正在检查…'
      updateResult.textContent = '正在检查可用更新。'
    } else if (state.state === 'downloading') {
      updateAction.textContent = state.percent === undefined ? '正在下载…' : `下载 ${state.percent}%`
      updateResult.textContent = '发现新版本，正在后台下载。'
    } else if (state.state === 'ready') {
      updateAction.disabled = false
      updateAction.textContent = '重启并更新'
      updateResult.textContent = `版本 ${state.version} 已下载。可以继续工作，稍后重启也会完成更新。`
    } else if (state.state === 'current') {
      updateAction.textContent = '再次检查'
      updateResult.textContent = '当前已是最新版本。'
    } else if (state.state === 'unavailable') {
      updateAction.textContent = '重试检查'
      updateResult.textContent = '暂时无法检查更新，不影响继续使用。'
    } else {
      updateAction.textContent = '检查更新'
      updateResult.textContent = 'MYTHOS 会在后台自动检查并下载可用更新。'
    }
  }
  updatePresenters.add(renderUpdate)
  void api.getUpdateState().then(renderUpdate)
  updateAction.addEventListener('click', async () => {
    if (updateAction.textContent === '重启并更新') {
      await api.restartAndUpdate()
      return
    }
    renderUpdate(await api.checkForUpdates())
  })
}

window.addEventListener('DOMContentLoaded', () => {
  if (!location.href.startsWith('http://127.0.0.1:')) return
  const bar = createElement('header', 'mythos-desktop-bar')
  const identity = createElement('div', 'mythos-desktop-bar__identity', 'MYTHOS')
  identity.append(createElement('span', 'mythos-desktop-bar__beta', 'DESKTOP BETA'))
  const status = createElement('div', 'mythos-desktop-bar__status', '服务可用')
  status.title = '智能服务：MYTHOS\n模型：claude-sonnet-5'
  const actions = createElement('div', 'mythos-desktop-bar__actions')
  const settings = createElement('button', '', '更新')
  settings.addEventListener('click', openSettings)
  const presentTopLevelUpdate = state => {
    if (state.state === 'ready') {
      settings.textContent = '重启更新'
      settings.title = `版本 ${state.version} 已下载；点击查看更新选项`
    } else {
      settings.textContent = '更新'
      settings.removeAttribute('title')
    }
  }
  updatePresenters.add(presentTopLevelUpdate)
  ipcRenderer.invoke('mythos:update:get').then(presentTopLevelUpdate)
  actions.append(settings)
  bar.append(identity, status, actions)
  document.body.prepend(bar)
  const applyPresentation = () => { adaptMythosSurface(document.body, status) }
  applyPresentation()
  let presentationScheduled = false
  let presentationRetry
  const schedulePresentation = () => {
    if (!presentationScheduled) {
      presentationScheduled = true
      requestAnimationFrame(() => {
        presentationScheduled = false
        applyPresentation()
      })
    }
    clearTimeout(presentationRetry)
    presentationRetry = setTimeout(applyPresentation, 120)
  }
  const observer = new MutationObserver((records) => {
    const relevant = records.some((record) => {
      if (record.type !== 'characterData') return true
      const parent = record.target.parentElement
      if (parent !== null && parent.closest('button,[role="menuitem"],[role="menuitemradio"]') !== null) return true
      return /^(探索未至之境|预览版|描述你想完成的任务|选择一个项目，然后描述你想完成的任务|基于 DeepSeek Harness、由 Mythos M3 驱动的完整编码 Agent。)$/u.test(record.target.nodeValue?.trim() ?? '')
    })
    if (relevant) schedulePresentation()
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title', 'data-state'] })
})
