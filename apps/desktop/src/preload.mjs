import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getSettings: () => ipcRenderer.invoke('mythos:settings:get'),
  saveSettings: settings => ipcRenderer.invoke('mythos:settings:save', settings),
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
  panel.setAttribute('aria-label', 'M3 安全设置')
  const title = createElement('h2', '', 'M3 安全设置')
  const note = createElement('p', '', '密钥由 macOS 安全存储加密，只传给本机 DSH Host，不写入网页存储或日志。保存后将重新连接。')
  const endpointLabel = createElement('label', '', 'Endpoint')
  const endpoint = document.createElement('input')
  endpoint.type = 'url'
  endpoint.autocomplete = 'off'
  const keyLabel = createElement('label', '', 'API Key（留空表示不修改）')
  const key = document.createElement('input')
  key.type = 'password'
  key.autocomplete = 'new-password'
  key.spellcheck = false
  endpointLabel.append(endpoint)
  keyLabel.append(key)
  const foot = createElement('div', 'mythos-settings__foot')
  const cancel = createElement('button', '', '取消')
  const save = createElement('button', '', '保存并重连')
  save.dataset.primary = ''
  foot.append(cancel, save)
  panel.append(title, note, endpointLabel, keyLabel, foot)
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
    endpoint.focus()
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
      save.textContent = '保存并重连'
    }
  })
}

window.addEventListener('DOMContentLoaded', () => {
  if (!location.href.startsWith('http://127.0.0.1:')) return
  const bar = createElement('header', 'mythos-desktop-bar')
  const identity = createElement('div', 'mythos-desktop-bar__identity', 'MYTHOS')
  identity.append(createElement('span', 'mythos-desktop-bar__beta', 'DESKTOP BETA'))
  const status = createElement('div', 'mythos-desktop-bar__status', 'M3 已连接 · deepseek-v4-flash')
  const actions = createElement('div', 'mythos-desktop-bar__actions')
  const settings = createElement('button', '', 'M3 设置')
  settings.addEventListener('click', openSettings)
  actions.append(settings)
  bar.append(identity, status, actions)
  document.body.prepend(bar)
})
