import { resolve } from 'node:path'
import { signMacApplication } from './scripts/sign-macos.mjs'

const runtimeArchive = process.env.MYTHOS_SIGNED_RUNTIME_ARCHIVE
if (runtimeArchive === undefined || runtimeArchive === '') {
  throw new Error('MYTHOS_SIGNED_RUNTIME_ARCHIVE must name the prepared Desktop runtime')
}
const signingIdentity = process.env.MYTHOS_MAC_SIGN_IDENTITY

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
  publish: [{
    provider: 'generic',
    url: 'https://llmapi.pro/mythos/desktop/updates/macos/arm64',
  }],
  extraResources: [
    { from: runtimeArchive, to: 'mythos-runtime.tar.gz' },
    { from: `${runtimeArchive}.sha256`, to: 'mythos-runtime.tar.gz.sha256' },
  ],
  mac: {
    category: 'public.app-category.developer-tools',
    darkModeSupport: true,
    extendInfo: { ElectronTeamID: 'Z6M3LSX64A' },
    hardenedRuntime: signingIdentity !== undefined,
    identity: signingIdentity ?? null,
    sign: signingIdentity === undefined ? null : signMacApplication,
    target: ['dir', 'dmg', 'zip'],
  },
  dmg: {
    backgroundColor: '#0d1624',
    sign: false,
    title: 'MYTHOS Desktop Beta',
  },
}
