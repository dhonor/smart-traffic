import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { FeatureCollection, RoadProps } from '@traffic/shared-types'

/**
 * 规划视图的几何生成（纯程序化，零外部资产）。
 *
 * 坐标约定：以园区中心为原点的局部米制平面，X 向东、Z 向南（three 右手系，Y 向上）。
 * 4km 范围内等距投影的误差 < 0.1%，足够规划视角用；跨城尺度再换 Web Mercator。
 */

const M_PER_DEG_LAT = 111_320
const CENTER = { lng: 114.0, lat: 22.575 }

export function projectToPlane(lng: number, lat: number): [number, number] {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((CENTER.lat * Math.PI) / 180)
  return [(lng - CENTER.lng) * mPerDegLng, -(lat - CENTER.lat) * M_PER_DEG_LAT]
}

/**
 * 竖向夸张系数：数据里的体块是 12~41m 的低层 + 400×500m 大足迹，
 * 真实比例下正交视图里只剩「平板」；规划可视化惯例做 1.5~2x 竖向放大。
 */
const HEIGHT_EXAGGERATION = 1.8

/** 建筑立面用世界坐标算窗格，避免给每个体块展开 UV（合并后仍是 1 次 DrawCall） */
function facadeMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    // 夜景立面要保留足够反照率，否则 RectAreaLight 打上去也是黑块
    color: '#33506f',
    roughness: 0.78,
    metalness: 0.08,
  })

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vFacade;\nvarying vec3 vFacadeN;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvFacade = position;\nvFacadeN = normal;',
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vFacade;
         varying vec3 vFacadeN;
         float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // 窗带只上垂直立面（屋顶是平面，normal.y≈1）：楼层 3.6m / 开间 5m，亮灯窗哈希稳定随机
         float vertical = 1.0 - smoothstep(0.35, 0.65, abs(vFacadeN.y));
         float band = fract(vFacade.y / 3.6);
         float col = fract((vFacade.x + vFacade.z) / 5.0);
         float win = step(0.24, band) * step(band, 0.76) * step(0.16, col) * step(col, 0.84) * vertical;
         float lit = step(0.58, hash21(floor(vec2((vFacade.x + vFacade.z) / 5.0, vFacade.y / 3.6))));
         diffuseColor.rgb = mix(diffuseColor.rgb * 0.4, diffuseColor.rgb * 1.12, win);
         totalEmissiveRadiance += win * lit * vec3(1.0, 0.72, 0.38) * 1.3;`,
      )
  }

  return material
}

/** 稳定伪随机：同一地块每次刷新长出一模一样的建筑群 */
function hash2(i: number, j: number, seed: number): number {
  const value = Math.sin(i * 127.1 + j * 311.7 + seed * 74.7) * 43758.5453
  return value - Math.floor(value)
}

function pointInPolygon(point: THREE.Vector2, polygon: THREE.Vector2[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = [polygon[i].x, polygon[i].y]
    const [xj, yj] = [polygon[j].x, polygon[j].y]
    const crosses = yi > point.y !== yj > point.y
    const at = ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
    if (crosses && point.x < at) inside = !inside
  }
  return inside
}

/**
 * 地块切分：400×500m 的整块地皮在正交视图里就是一块平板，
 * 按约 160m 的单元切成建筑群，随机高度（基准 ×0.55~1.7）并留出庭院/广场，
 * 城市肌理立刻从「平板」变成「街区」。
 */
function subdivideBlock(
  polygon: THREE.Vector2[],
  baseHeight: number,
  seed: number,
): Array<{ rect: [number, number, number, number]; height: number }> {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const point of polygon) {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  const width = maxX - minX
  const depth = maxY - minY
  const cols = THREE.MathUtils.clamp(Math.round(width / 160), 1, 4)
  const rows = THREE.MathUtils.clamp(Math.round(depth / 160), 1, 4)
  const cells: Array<{ rect: [number, number, number, number]; height: number }> = []

  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      // 约 1/7 的单元留空：广场 / 庭院 / 绿地，打破满铺感
      if (hash2(i, j, seed) < 0.14) continue
      const inset = 12
      const x0 = minX + (width / cols) * i + inset
      const x1 = minX + (width / cols) * (i + 1) - inset
      const y0 = minY + (depth / rows) * j + inset
      const y1 = minY + (depth / rows) * (j + 1) - inset
      if (!pointInPolygon(new THREE.Vector2((x0 + x1) / 2, (y0 + y1) / 2), polygon)) continue

      const height = Math.max(8, baseHeight * (0.55 + hash2(i, j, seed + 1) * 1.15))
      cells.push({ rect: [x0, y0, x1, y1], height })
    }
  }
  return cells
}

/** 建筑体块：地块 → 切分建筑群 → 拉伸，全部合并成一个 Mesh（1 DrawCall） */
export function buildBuildings(
  blocks: { features: Array<{ geometry: any; properties: any }> },
): THREE.Mesh | null {
  const geometries: THREE.BufferGeometry[] = []

  blocks.features.forEach((feature, index) => {
    const rings = (feature.geometry?.coordinates as number[][][])?.[0]
    if (!rings || rings.length < 4) return

    const polygon = rings.map(([lng, lat]) => {
      const [x, z] = projectToPlane(lng, lat)
      // shape 平面 (x, y) 经 rotateX(-90°) 后 y→-z，因此这里取 -z
      return new THREE.Vector2(x, -z)
    })
    const baseHeight = Math.max(Number(feature.properties?.height ?? 20), 6) * HEIGHT_EXAGGERATION

    for (const cell of subdivideBlock(polygon, baseHeight, index + 1)) {
      const [x0, y0, x1, y1] = cell.rect
      const shape = new THREE.Shape([
        new THREE.Vector2(x0, y0),
        new THREE.Vector2(x1, y0),
        new THREE.Vector2(x1, y1),
        new THREE.Vector2(x0, y1),
      ])
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: cell.height, bevelEnabled: false })
      geometry.rotateX(-Math.PI / 2)
      geometries.push(geometry)
    }
  })

  if (!geometries.length) return null
  const merged = mergeGeometries(geometries, false)
  geometries.forEach((geometry) => geometry.dispose())
  if (!merged) return null

  const mesh = new THREE.Mesh(merged, facadeMaterial())
  mesh.name = 'planning:buildings'
  return mesh
}

interface RibbonOptions {
  width: number
  /** UV 沿路方向的重复间距（米） */
  uvScale: number
}

function ribbon(coords: number[][], options: RibbonOptions): THREE.BufferGeometry | null {
  if (coords.length < 2) return null
  const points = coords.map(([lng, lat]) => projectToPlane(lng, lat))
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  let distance = 0

  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, z0] = points[i]
    const [x1, z1] = points[i + 1]
    const dx = x1 - x0
    const dz = z1 - z0
    const length = Math.hypot(dx, dz)
    if (length < 0.01) continue

    const nx = -dz / length
    const nz = dx / length
    const half = options.width / 2
    const base = positions.length / 3

    positions.push(
      x0 + nx * half, 0, z0 + nz * half,
      x0 - nx * half, 0, z0 - nz * half,
      x1 + nx * half, 0, z1 + nz * half,
      x1 - nx * half, 0, z1 - nz * half,
    )
    const u0 = distance / options.uvScale
    const u1 = (distance + length) / options.uvScale
    uvs.push(u0, 1, u0, 0, u1, 1, u1, 0)
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
    distance += length
  }

  if (!positions.length) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/** 车道虚线：沿中心线每 14m 画一段 6m 的短杠，路面与标线仍各 1 次 DrawCall */
function laneDashes(coords: number[][]): THREE.BufferGeometry | null {
  if (coords.length < 2) return null
  const points = coords.map(([lng, lat]) => projectToPlane(lng, lat))
  const positions: number[] = []
  const indices: number[] = []
  let carry = 0

  for (let i = 0; i < points.length - 1; i += 1) {
    const [x0, z0] = points[i]
    const [x1, z1] = points[i + 1]
    const dx = x1 - x0
    const dz = z1 - z0
    const length = Math.hypot(dx, dz)
    if (length < 0.01) continue
    const ux = dx / length
    const uz = dz / length
    const nx = -uz * 0.22
    const nz = ux * 0.22

    // 沿段采样：carry 记录上一段末尾到当前段起点的相位
    for (let s = 14 - carry; s < length; s += 14) {
      const sx = x0 + ux * s
      const sz = z0 + uz * s
      const ex = sx + ux * 6
      const ez = sz + uz * 6
      const base = positions.length / 3
      positions.push(
        sx + nx, 0.06, sz + nz,
        sx - nx, 0.06, sz - nz,
        ex + nx, 0.06, ez + nz,
        ex - nx, 0.06, ez - nz,
      )
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2)
    }
    carry = (carry + length) % 14
  }

  if (!positions.length) return null
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export interface RoadMeshes {
  surface: THREE.Mesh | null
  markings: THREE.Mesh | null
  laneCasing: THREE.Mesh | null
}

/**
 * 路网：路面（宽按等级）+ 中央虚线 + 两侧路缘带。
 * 宽度按真实车道数：快速路 26m / 主干 17m / 支路 11m。
 */
export function buildRoads(roads: FeatureCollection<RoadProps, any>): RoadMeshes {
  const surfaces: THREE.BufferGeometry[] = []
  const casings: THREE.BufferGeometry[] = []
  const dashes: THREE.BufferGeometry[] = []

  for (const feature of roads.features) {
    const coords = (feature.geometry?.coordinates ?? []) as number[][]
    const level = feature.properties?.level
    const width = level === 'expressway' ? 26 : level === 'arterial' ? 17 : 11

    const surface = ribbon(coords, { width, uvScale: 12 })
    if (surface) surfaces.push(surface)
    const casing = ribbon(coords, { width: width + 2.4, uvScale: 12 })
    if (casing) {
      // 路缘只露两侧：抬到路面下方 0.02m，靠宽度差形成描边
      casing.translate(0, -0.04, 0)
      casings.push(casing)
    }
    const dash = laneDashes(coords)
    if (dash) dashes.push(dash)
  }

  const merge = (list: THREE.BufferGeometry[]): THREE.Mesh | null => {
    if (!list.length) return null
    const merged = mergeGeometries(list, false)
    list.forEach((geometry) => geometry.dispose())
    return merged ? new THREE.Mesh(merged) : null
  }

  const surface = merge(surfaces)
  if (surface) {
    surface.material = new THREE.MeshStandardMaterial({
      color: '#35465c',
      roughness: 0.94,
      metalness: 0.04,
    })
    surface.name = 'planning:roads'
  }

  const laneCasing = merge(casings)
  if (laneCasing) {
    laneCasing.material = new THREE.MeshStandardMaterial({
      color: '#46617c',
      roughness: 0.9,
      metalness: 0.05,
    })
    laneCasing.name = 'planning:road-casing'
  }

  const markings = merge(dashes)
  if (markings) {
    markings.material = new THREE.MeshBasicMaterial({ color: '#93aecb', toneMapped: false })
    markings.name = 'planning:road-markings'
  }

  return { surface, markings, laneCasing }
}
