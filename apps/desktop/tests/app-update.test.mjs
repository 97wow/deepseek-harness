import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createAppUpdateCoordinator, validateUpdateSource } from '../src/app-update.mjs'

class FakeUpdater extends EventEmitter {
  constructor(check) {
    super()
    this.check = check
    this.installCalls = []
  }

  async checkForUpdates() {
    return await this.check(this)
  }

  quitAndInstall(...args) {
    this.installCalls.push(args)
  }
}

const sources = [
  { provider: 'generic', url: 'https://updates.test/mythos/' },
  { provider: 'github', owner: '97wow', repo: 'deepseek-harness' },
]

test('accepts only managed HTTPS or GitHub update source shapes', () => {
  assert.doesNotThrow(() => validateUpdateSource(sources[0]))
  assert.doesNotThrow(() => validateUpdateSource(sources[1]))
  assert.throws(() => validateUpdateSource({ provider: 'generic', url: 'http://updates.test/' }), /HTTPS/u)
  assert.throws(() => validateUpdateSource({ provider: 'generic', url: 'https://token@updates.test/' }), /不含凭据/u)
  assert.throws(() => validateUpdateSource({ provider: 'github', owner: '../97wow', repo: 'deepseek-harness' }), /owner/u)
  assert.throws(() => validateUpdateSource({ provider: 's3', bucket: 'updates' }), /provider/u)
})

test('falls back after a primary download failure and installs only the verified ready source', async () => {
  const errors = []
  const states = []
  const primary = new FakeUpdater(async updater => {
    updater.emit('update-available', { version: '0.2.0-beta.6' })
    return { downloadPromise: Promise.reject(new Error('primary download failed')) }
  })
  const fallback = new FakeUpdater(async updater => {
    updater.emit('update-available', { version: '0.2.0-beta.6' })
    updater.emit('download-progress', { percent: 57.6 })
    updater.emit('update-downloaded', { version: '0.2.0-beta.6' })
    return { downloadPromise: Promise.resolve() }
  })
  const updaters = [primary, fallback]
  const coordinator = createAppUpdateCoordinator({
    createUpdater: () => updaters.shift(),
    isPackaged: () => true,
    publish: state => states.push(state),
    reportError: error => errors.push(error),
    sources,
  })

  assert.deepEqual(await coordinator.check(), { percent: 100, state: 'ready', version: '0.2.0-beta.6' })
  assert.equal(errors.length, 1)
  assert.ok(states.some(state => state.percent === 58 && state.state === 'downloading'))
  assert.equal(primary.autoDownload, true)
  assert.equal(primary.autoInstallOnAppQuit, true)
  assert.equal(primary.allowDowngrade, false)
  assert.deepEqual(await coordinator.check(), { percent: 100, state: 'ready', version: '0.2.0-beta.6' })
  assert.equal(errors.length, 1)
  assert.equal(coordinator.restartAndUpdate(), true)
  assert.deepEqual(primary.installCalls, [])
  assert.deepEqual(fallback.installCalls, [[false, true]])
})

test('coalesces concurrent checks and reports unavailable only after every source fails', async () => {
  let checks = 0
  let release
  const pending = new Promise((_, reject) => { release = () => reject(new Error('offline')) })
  const coordinator = createAppUpdateCoordinator({
    createUpdater: () => new FakeUpdater(async () => {
      checks += 1
      if (checks === 1) return { downloadPromise: pending }
      throw new Error('fallback offline')
    }),
    isPackaged: () => true,
    publish: () => {},
    reportError: () => {},
    sources,
  })

  const first = coordinator.check()
  const second = coordinator.check()
  release()
  assert.deepEqual(await Promise.all([first, second]), [
    { percent: undefined, state: 'unavailable', version: undefined },
    { percent: undefined, state: 'unavailable', version: undefined },
  ])
  assert.equal(checks, 2)
  assert.equal(coordinator.restartAndUpdate(), false)
})

test('does not contact update sources from an unpackaged development app', async () => {
  let created = false
  const coordinator = createAppUpdateCoordinator({
    createUpdater: () => { created = true },
    isPackaged: () => false,
    publish: () => {},
    reportError: () => {},
    sources,
  })
  assert.deepEqual(await coordinator.check(), { state: 'idle' })
  assert.equal(created, false)
})
