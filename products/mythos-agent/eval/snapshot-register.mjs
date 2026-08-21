import { register } from 'node:module'
import { resolve } from 'node:path'

const root = process.env.MYTHOS_EVAL_ARTIFACT_ROOT
if (!root) throw new Error('缺少已验证执行产物根目录')
register('./snapshot-loader.mjs', import.meta.url, {
  data: {
    mutableRoots: [
      resolve(root, 'products/mythos-agent/home/sessions'),
      resolve(root, 'products/mythos-agent/runs'),
    ],
    root,
  },
})
