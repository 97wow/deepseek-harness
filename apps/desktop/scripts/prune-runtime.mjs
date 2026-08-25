import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const MAC_ARM64_PREBUILD = 'darwin-arm64'

async function findNodePtyPrebuildRoots(root, results) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    if (entry.name === 'node-pty') {
      const prebuilds = join(path, 'prebuilds')
      try {
        const children = await readdir(prebuilds, { withFileTypes: true })
        if (children.some(child => child.isDirectory() && child.name === MAC_ARM64_PREBUILD)) {
          results.push({ path: prebuilds, children })
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    await findNodePtyPrebuildRoots(path, results)
  }
}

/**
 * Removes node-pty native variants that cannot run in the macOS arm64 build.
 * The generic JavaScript package and the darwin-arm64 prebuild remain intact.
 * @param {string} release Extracted Mythos runtime root.
 * @returns {Promise<string[]>} Removed prebuild directory names.
 */
export async function pruneRuntimeForMacArm64(release) {
  const roots = []
  await findNodePtyPrebuildRoots(release, roots)
  const removed = []
  for (const root of roots) {
    for (const child of root.children) {
      if (!child.isDirectory() || child.name === MAC_ARM64_PREBUILD) continue
      await rm(join(root.path, child.name), { force: true, recursive: true })
      removed.push(child.name)
    }
  }
  return removed.sort()
}
