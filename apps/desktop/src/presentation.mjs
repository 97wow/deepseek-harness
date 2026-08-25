const EXACT_LABELS = new Map([
  ['Read Only', '仅查看'],
  ['Workspace Write', '可修改文件'],
  ['Full access', '完全访问'],
  ['Session log', '会话记录'],
  ['Think', '分析'],
  ['Read', '读取'],
  ['Search', '搜索'],
  ['Bash', '运行命令'],
  ['Write', '修改'],
  ['Edit', '修改'],
])

const ATTRIBUTE_LABELS = [
  ['Read Only', '仅查看'],
  ['Workspace Write', '可修改文件'],
  ['Full access', '完全访问'],
  ['Session log', '会话记录'],
]

function replaceAllLabels(value) {
  return ATTRIBUTE_LABELS.reduce(
    (result, [source, replacement]) => result.replaceAll(source, replacement),
    value,
  )
}

function normalizedText(element) {
  return element.textContent?.replace(/\s+/gu, ' ').trim() ?? ''
}

function translateControl(control) {
  for (const attribute of ['aria-label', 'title']) {
    const value = control.getAttribute(attribute)
    const replacement = value === null ? null : replaceAllLabels(value)
    if (replacement !== null && replacement !== value) control.setAttribute(attribute, replacement)
  }
  const walker = control.ownerDocument.createTreeWalker(control, 4)
  let node = walker.nextNode()
  while (node !== null) {
    const replacement = EXACT_LABELS.get(node.nodeValue?.trim() ?? '')
    if (replacement !== undefined) node.nodeValue = replacement
    node = walker.nextNode()
  }
}

function markSingleChoiceControls(root) {
  for (const button of root.querySelectorAll('button')) {
    const label = normalizedText(button)
    const aria = button.getAttribute('aria-label') ?? ''
    const title = button.getAttribute('title') ?? ''
    if (label === 'Mythos Agent' && /Agent|预设/u.test(title) && !button.hasAttribute('data-mythos-context-label')) {
      button.dataset.mythosContextLabel = ''
      button.setAttribute('aria-label', '当前助手：Mythos Agent')
      button.setAttribute('title', '当前助手')
      button.disabled = true
    }
    if (/^(选择模型|Select model)/u.test(aria) || /^(?:Mythos M3|claude-sonnet-5)(?:\s*·|$)/u.test(title)) {
      const wrapper = button.closest('div')
      if (wrapper !== null && !wrapper.hasAttribute('data-mythos-single-service')) {
        wrapper.setAttribute('data-mythos-single-service', '')
      }
    }
  }
}

function translateKnownControls(root) {
  for (const control of root.querySelectorAll('button,[role="menuitem"],[role="menuitemradio"]')) {
    translateControl(control)
  }
}

function simplifyEmptyState(root) {
  const workspace = root.querySelector('button[aria-label="选择工作区"],button[aria-label="Choose workspace"]')
  const hasWorkspace = workspace !== null
    && !/^(选择工作区|Choose workspace)$/u.test(normalizedText(workspace))
  const nextStep = hasWorkspace
    ? '描述你想完成的任务'
    : '选择一个项目，然后描述你想完成的任务'
  const walker = root.ownerDocument.createTreeWalker(root, 4)
  let node = walker.nextNode()
  while (node !== null) {
    const value = node.nodeValue?.trim()
    if (value === '探索未至之境'
      || value === '描述你想完成的任务'
      || value === '选择一个项目，然后描述你想完成的任务') node.nodeValue = nextStep
    if (value === '基于 DeepSeek Harness、由 Mythos M3 驱动的完整编码 Agent。') {
      node.nodeValue = '面向项目任务的 MYTHOS 编码助手。'
    }
    if (value === '预览版') node.nodeValue = ''
    node = walker.nextNode()
  }
}

export function executionStatus(root) {
  const running = [...root.querySelectorAll('[data-state="running"]')].at(-1)
  if (running === undefined) return '服务可用'
  const text = normalizedText(running)
  if (/Think|分析/u.test(text)) return 'MYTHOS 正在分析…'
  if (/Read|读取|Search|搜索/u.test(text)) return 'MYTHOS 正在读取…'
  if (/Write|Edit|修改/u.test(text)) return 'MYTHOS 正在修改…'
  return 'MYTHOS 正在执行…'
}

export function adaptMythosSurface(root, status) {
  markSingleChoiceControls(root)
  translateKnownControls(root)
  simplifyEmptyState(root)
  const nextStatus = executionStatus(root)
  if (status.textContent !== nextStatus) status.textContent = nextStatus
}
