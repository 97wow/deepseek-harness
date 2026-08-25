import { contextBridge, ipcRenderer } from 'electron'
import { adaptMythosSurface } from './presentation.mjs'

const api = {
  getSettings: () => ipcRenderer.invoke('mythos:settings:get'),
  saveSettings: settings => ipcRenderer.invoke('mythos:settings:save', settings),
  testConnection: () => ipcRenderer.invoke('mythos:settings:test'),
}
contextBridge.exposeInMainWorld('mythosDesktop', api)

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
  panel.setAttribute('aria-label', '设置')
  const title = createElement('h2', '', '设置')
  const service = createElement('section', 'mythos-settings__service')
  const serviceCopy = createElement('div')
  serviceCopy.append(
    createElement('strong', '', '智能服务'),
    createElement('span', '', '默认 · 服务可用'),
  )
  const test = createElement('button', '', '测试连接')
  service.append(serviceCopy, test)
  const testResult = createElement('p', 'mythos-settings__result', 'MYTHOS 已准备好处理项目任务。')
  const advanced = createElement('details', 'mythos-settings__advanced')
  const advancedSummary = createElement('summary', '', '高级 / 技术信息')
  const technical = createElement('dl', 'mythos-settings__technical')
  technical.innerHTML = '<div><dt>模型</dt><dd>claude-sonnet-5</dd></div>'
  const note = createElement('p', '', '连接凭据由 macOS 安全存储加密，不进入网页存储或日志。')
  const endpointLabel = createElement('label', '', '服务地址')
  const endpoint = document.createElement('input')
  endpoint.type = 'url'
  endpoint.autocomplete = 'off'
  const keyLabel = createElement('label', '', 'API Key')
  const key = document.createElement('input')
  key.type = 'password'
  key.autocomplete = 'new-password'
  key.spellcheck = false
  endpointLabel.append(endpoint)
  keyLabel.append(key)
  advanced.append(advancedSummary, technical, note, endpointLabel, keyLabel)
  const foot = createElement('div', 'mythos-settings__foot')
  const cancel = createElement('button', '', '取消')
  const save = createElement('button', '', '保存')
  save.dataset.primary = ''
  foot.append(cancel, save)
  panel.append(title, service, testResult, advanced, foot)
  shade.append(panel)
  document.body.append(shade)
  const close = () => shade.remove()
  cancel.addEventListener('click', close)
  shade.addEventListener('click', event => { if (event.target === shade) close() })
  document.addEventListener('keydown', function escape(event) {
    if (event.key !== 'Escape' || !shade.isConnected) return
    document.removeEventListener('keydown', escape)
    close()
  })
  void api.getSettings().then(settings => {
    endpoint.value = settings.endpoint
    key.placeholder = settings.hasKey ? '已安全保存；留空表示不修改' : '尚未配置'
    test.focus()
  })
  test.addEventListener('click', async () => {
    test.disabled = true
    test.textContent = '正在测试…'
    try {
      const result = await api.testConnection()
      testResult.textContent = result.ok ? '连接正常，服务可用。' : '当前无法连接，请展开高级设置检查连接信息。'
    } catch {
      testResult.textContent = '当前无法连接，请展开高级设置检查连接信息。'
    } finally {
      test.disabled = false
      test.textContent = '测试连接'
    }
  })
  save.addEventListener('click', async () => {
    save.disabled = true
    save.textContent = '正在保存…'
    try {
      await api.saveSettings({ endpoint: endpoint.value, key: key.value })
      key.value = ''
      close()
    } catch (error) {
      note.textContent = error instanceof Error ? error.message : String(error)
      save.disabled = false
      save.textContent = '保存'
    }
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
  const settings = createElement('button', '', '设置')
  settings.addEventListener('click', openSettings)
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
