import { resolve } from 'node:path'

const runtimeRoot = process.env.MYTHOS_RUNTIME_ROOT
if (runtimeRoot === undefined || runtimeRoot === '') {
  throw new Error('MYTHOS_RUNTIME_ROOT must name an extracted Mythos release')
}

export default {
  appId: 'pro.llmapi.mythos.desktop',
  productName: 'MYTHOS',
  artifactName: 'MYTHOS-${version}-${arch}.${ext}',
  asar: true,
  // The Electron shell has no runtime npm dependencies. DSH Host ships as the
  // separately frozen release closure under extraResources, so explicitly
  // tell electron-builder the app dependency tree is handled externally.
  npmRebuild: false,
  beforeBuild: () => false,
  directories: {
    output: resolve('dist'),
  },
  files: [
    'src/**/*',
    'package.json',
  ],
  extraResources: [{ from: runtimeRoot, to: 'mythos-agent' }],
  mac: {
    category: 'public.app-category.developer-tools',
    darkModeSupport: true,
    hardenedRuntime: false,
    identity: null,
    target: ['dir', 'dmg'],
  },
  dmg: {
    backgroundColor: '#0d1624',
    sign: false,
    title: 'MYTHOS Desktop Beta',
  },
}
