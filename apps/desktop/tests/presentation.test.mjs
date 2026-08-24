import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { adaptMythosSurface, executionStatus } from '../src/presentation.mjs'

test('hides single-choice infrastructure and translates user-facing controls', () => {
  const dom = new JSDOM(`<body>
    <button title="即将开始的这个会话所用的 Agent 预设">Mythos Agent<svg></svg></button>
    <div><button aria-label="选择模型，当前 Mythos M3，推理等级 Max" title="Mythos M3 · Max">Mythos M3</button></div>
    <button aria-label="访问模式，当前：Workspace Write">Workspace Write</button>
    <button>Session log</button>
    <button aria-label="选择工作区">work</button>
    <span>探索未至之境</span><span>预览版</span>
  </body>`)
  const status = dom.window.document.createElement('div')
  adaptMythosSurface(dom.window.document.body, status)
  assert.equal(dom.window.document.querySelector('[data-mythos-context-label]')?.textContent, 'Mythos Agent')
  assert.ok(dom.window.document.querySelector('[data-mythos-single-service]'))
  assert.match(dom.window.document.body.textContent, /可修改文件/u)
  assert.match(dom.window.document.body.textContent, /会话记录/u)
  assert.match(dom.window.document.body.textContent, /描述你想完成的任务/u)
  assert.doesNotMatch(dom.window.document.body.textContent, /选择一个项目/u)
  assert.doesNotMatch(dom.window.document.body.textContent, /Workspace Write|Session log|预览版/u)
  assert.equal(status.textContent, '服务可用')
})

test('empty guidance asks for a project only before one is selected', () => {
  const dom = new JSDOM('<body><button aria-label="选择工作区">选择工作区</button><span>探索未至之境</span></body>')
  const status = dom.window.document.createElement('div')
  adaptMythosSurface(dom.window.document.body, status)
  assert.match(dom.window.document.body.textContent, /选择一个项目，然后描述你想完成的任务/u)
})

test('derives plain-language running status without changing event names', () => {
  const dom = new JSDOM('<body><button data-state="running" data-tool-call>Read</button></body>')
  assert.equal(executionStatus(dom.window.document.body), 'MYTHOS 正在读取…')
  const status = dom.window.document.createElement('div')
  adaptMythosSurface(dom.window.document.body, status)
  assert.equal(dom.window.document.querySelector('button')?.textContent, '读取')
  assert.equal(status.textContent, 'MYTHOS 正在读取…')
})
