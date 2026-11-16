/**
 * 把 Cesium 的静态资源拷到 public/cesium（Widgets / Workers / Assets / ThirdParty）。
 * 不做这一步，Viewer 起来会缺 Workers，瓦片与地形也拿不到。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = join(root, 'node_modules', 'cesium', 'Build', 'Cesium')
const target = join(root, 'public', 'cesium')

if (!existsSync(source)) {
  console.error('[cesium] 未找到 node_modules/cesium/Build/Cesium，请先 pnpm install')
  process.exit(1)
}

// 不做「先删后拷」：覆盖式拷贝即可满足需求，
// 还避免了在 dev server 运行时删除正在使用的静态资源（部分环境会拦截删除操作）。
mkdirSync(target, { recursive: true })

for (const folder of ['Workers', 'ThirdParty', 'Assets', 'Widgets']) {
  cpSync(join(source, folder), join(target, folder), { recursive: true, force: true })
}

console.log('[cesium] 静态资源已就绪 -> public/cesium')
