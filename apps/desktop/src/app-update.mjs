function validateSlug(value, field) {
  if (typeof value !== 'string' || !/^[a-z0-9_.-]+$/iu.test(value)) {
    throw new Error(`MYTHOS 更新源 ${field} 无效`)
  }
}

/** Reject update metadata sources that could bypass the managed HTTPS channels. */
export function validateUpdateSource(source) {
  if (source?.provider === 'generic') {
    const url = new URL(source.url)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      throw new Error('MYTHOS generic 更新源必须使用不含凭据的 HTTPS URL')
    }
    return
  }
  if (source?.provider === 'github') {
    validateSlug(source.owner, 'owner')
    validateSlug(source.repo, 'repo')
    return
  }
  throw new Error('MYTHOS 更新源 provider 无效')
}

function progressPercent(progress) {
  const percent = Number(progress?.percent)
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : undefined
}

/** Coordinate one packaged-app update check across ordered managed sources. */
export function createAppUpdateCoordinator({ createUpdater, isPackaged, publish, reportError, sources }) {
  const managedSources = sources.map(source => ({ ...source }))
  for (const source of managedSources) validateUpdateSource(source)
  let activeUpdater
  let checkTask
  let state = { state: 'idle' }

  const snapshot = () => ({ ...state })
  const setState = next => {
    state = { ...state, ...next }
    publish(snapshot())
  }
  const attach = updater => {
    const listeners = {
      checking: () => setState({ percent: undefined, state: 'checking', version: undefined }),
      available: info => setState({ percent: undefined, state: 'downloading', version: info.version }),
      progress: progress => setState({ percent: progressPercent(progress), state: 'downloading' }),
      current: () => setState({ percent: undefined, state: 'current', version: undefined }),
      ready: info => setState({ percent: 100, state: 'ready', version: info.version }),
      error: error => reportError(error),
    }
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    // Desktop beta builds must request beta-mac.yml consistently from both
    // the primary generic feed and the GitHub fallback.
    updater.allowPrerelease = true
    updater.channel = 'beta'
    // electron-updater enables downgrades when the channel setter runs.
    updater.allowDowngrade = false
    updater.on('checking-for-update', listeners.checking)
    updater.on('update-available', listeners.available)
    updater.on('download-progress', listeners.progress)
    updater.on('update-not-available', listeners.current)
    updater.on('update-downloaded', listeners.ready)
    updater.on('error', listeners.error)
    return () => {
      updater.off('checking-for-update', listeners.checking)
      updater.off('update-available', listeners.available)
      updater.off('download-progress', listeners.progress)
      updater.off('update-not-available', listeners.current)
      updater.off('update-downloaded', listeners.ready)
      updater.off('error', listeners.error)
    }
  }

  const performCheck = async () => {
    activeUpdater = undefined
    setState({ percent: undefined, state: 'checking', version: undefined })
    for (const source of managedSources) {
      const updater = createUpdater(source)
      const detach = attach(updater)
      try {
        const result = await updater.checkForUpdates()
        if (result?.downloadPromise !== undefined) await result.downloadPromise
        if (state.state === 'ready') activeUpdater = updater
        else detach()
        return snapshot()
      } catch (error) {
        detach()
        reportError(error)
        setState({ percent: undefined, state: 'checking', version: undefined })
      }
    }
    setState({ percent: undefined, state: 'unavailable', version: undefined })
    return snapshot()
  }

  return {
    check: async () => {
      if (!isPackaged()) return snapshot()
      // Preserve the updater instance serving the downloaded ZIP until the
      // user installs it; a periodic recheck must not discard a ready update.
      if (state.state === 'ready') return snapshot()
      if (checkTask !== undefined) return await checkTask
      checkTask = performCheck()
      try {
        return await checkTask
      } finally {
        checkTask = undefined
      }
    },
    notify: () => publish(snapshot()),
    restartAndUpdate: () => {
      if (state.state !== 'ready' || activeUpdater === undefined) return false
      activeUpdater.quitAndInstall(false, true)
      return true
    },
    state: snapshot,
  }
}
