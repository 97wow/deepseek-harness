const { app } = require('electron')

process.stdout.write('[MYTHOS Desktop] bootstrap loaded\n')
app.whenReady().then(
  () => import('./main.mjs'),
  error => {
    process.stderr.write(`[MYTHOS Desktop] bootstrap failed: ${String(error)}\n`)
    app.quit()
  },
)
