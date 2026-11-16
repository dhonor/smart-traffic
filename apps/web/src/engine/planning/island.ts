import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { buildBuildings, projectToPlane } from './geometry'
import type { CheckpointProps, FeatureCollection, RoadProps } from '@traffic/shared-types'

/**
 * 智慧交通业务园区岛（等距轴测形态）。
 *
 * 岛上对象是交通业务语义，不是能源域：
 *   ETC/卡口检测车道顶棚 + 龙门架与摄像机 + 地面检测线圈、
 *   十字路口信号灯与斑马线、VMS 情报板、交通指挥中心、边缘计算机柜、
 *   布控区轮廓、告警光柱、按真实坐标压缩的车流。
 *
 * 数据纪律：
 *   - 路网 / 建筑 / 卡口 / 布控区 / 告警均来自 PostGIS 与业务接口，与孪生视图同源；
 *   - 龙门架、信号灯、情报板、机柜等细部是**程序化示意设施**（库里无几何台账），
 *     注释与 README 如实标注，接入设备资产模型后再替换。
 *
 * 性能纪律：按材质分桶，每桶只在末尾合并成 1 个 Mesh，整岛约 9 次 DrawCall。
 */

export interface IslandData {
  roads: FeatureCollection<RoadProps, any> | null
  blocks: { features: Array<{ geometry: any; properties: any }> } | null
  checkpoints: FeatureCollection<CheckpointProps, any> | null
  zones: { features: Array<{ geometry: any; properties: any }> } | null
}

const ISLAND = { width: 1120, depth: 840, thickness: 18 }

/** 合并前统一为非索引：ExtrudeGeometry 无 index，Box/Cylinder 有，混用 merge 会失败 */
function normalize(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  return geometry.index ? geometry.toNonIndexed() : geometry
}

class Bucket {
  private readonly parts: THREE.BufferGeometry[] = []

  add(geometry: THREE.BufferGeometry): void {
    this.parts.push(normalize(geometry))
  }

  build(material: THREE.Material, name: string): THREE.Mesh | null {
    if (!this.parts.length) return null
    const merged = mergeGeometries(this.parts, false)
    this.parts.forEach((geometry) => geometry.dispose())
    if (!merged) return null
    const mesh = new THREE.Mesh(merged, material)
    mesh.name = name
    return mesh
  }
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d)
  geometry.translate(x, y, z)
  return geometry
}

function cylinder(
  rTop: number,
  rBottom: number,
  height: number,
  x: number,
  y: number,
  z: number,
  segments = 8,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(rTop, rBottom, height, segments)
  geometry.translate(x, y, z)
  return geometry
}

/** 从城市数据中裁出中心园区：仅保留与岛范围相交的对象 */
function clipFeatures<T extends { geometry?: { coordinates?: any } }>(features: T[]): T[] {
  const halfW = ISLAND.width / 2 + 120
  const halfD = ISLAND.depth / 2 + 120
  return features.filter((feature) => {
    const coordinates = feature.geometry?.coordinates
    if (!Array.isArray(coordinates)) return false
    // Polygon 是三层数组、LineString 是两层：拍平成 [lng,lat,...] 才能同时处理
    const flat = coordinates.flat(Infinity) as number[]
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (typeof flat[i] !== 'number' || typeof flat[i + 1] !== 'number') continue
      const [x, z] = projectToPlane(flat[i], flat[i + 1])
      if (Math.abs(x) < halfW && Math.abs(z) < halfD) return true
    }
    return false
  })
}

/** 车辆可行驶车道（岛内米制坐标），由真实路网裁切而来 */
export interface RoadLane {
  a: [number, number]
  b: [number, number]
  width: number
}

export interface IslandResult {
  group: THREE.Group
  /** 数据流起点（局部米制坐标），用于虚线与 HTML 指标卡投影 */
  anchors: Record<string, THREE.Vector3>
  lanes: RoadLane[]
  /** 南北 / 东西向信号灯灯泡材质：由场景层按相位每帧改色 */
  signalMaterials: { ns: THREE.MeshBasicMaterial; ew: THREE.MeshBasicMaterial }
}

/**
 * Liang–Barsky 线段裁剪。
 * 真实路网是「两个端点」的 LineString，端点在城市 10km 外、压缩后仍落在岛外；
 * 之前用「有点在岛内」过滤会把整条路丢掉，所以岛上一直没有真实路网。
 */
function clipSegment(
  a: [number, number],
  b: [number, number],
  halfW: number,
  halfD: number,
): [[number, number], [number, number]] | null {
  const dx = b[0] - a[0]
  const dz = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [
    [-dx, a[0] + halfW],
    [dx, halfW - a[0]],
    [-dz, a[1] + halfD],
    [dz, halfD - a[1]],
  ]) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  if (t1 - t0 < 0.02) return null
  return [
    [a[0] + t0 * dx, a[1] + t0 * dz],
    [a[0] + t1 * dx, a[1] + t1 * dz],
  ]
}

/** 卡口坐标 → 岛内米制坐标（与路网/车辆同一压缩系数） */
export function checkpointToIsland(lng: number, lat: number): [number, number] {
  const [x, z] = projectToPlane(
    114.0 + (lng - 114.0) * 0.12,
    22.575 + (lat - 22.575) * 0.12,
  )
  return [x, z]
}

export function buildIsland(data: IslandData): IslandResult {
  const group = new THREE.Group()
  group.name = 'planning:island'

  const shell = new Bucket() // 地台
  const asphalt = new Bucket() // 真实路网路面
  const curb = new Bucket() // 路缘亮边
  const laneLines = new Bucket() // 车道虚线 / 斑马线
  const glass = new Bucket() // 指挥中心幕墙
  const canopy = new Bucket() // ETC/卡口检测车道顶棚
  const markings = new Bucket() // 车道线 / 情报板 / 顶棚分格
  const glow = new Bucket() // 线圈 / 信号灯 / 龙门架灯（设备类，可被图层开关隐藏）
  const edge = new Bucket() // 岛缘光带：属于地台，不随设备图层隐藏
  const zoneGlow = new Bucket() // 布控区紫色轮廓
  const signalNs = new Bucket() // 南北向信号灯灯泡（独立材质，随相位变色）
  const signalEw = new Bucket() // 东西向信号灯灯泡
  const trees = new Bucket() // 行道树
  const equipment = new Bucket() // 龙门架 / 立杆 / 指挥中心 / 边缘机柜

  // ── 1. 悬浮地台 ──────────────────────────────────────────
  shell.add(box(ISLAND.width, ISLAND.thickness, ISLAND.depth, 0, -ISLAND.thickness / 2, 0))
  // 发光边缘：四条细长 Box，MeshBasic + Bloom 出一圈青蓝轮廓
  // 岛缘只做细描边（4m）：之前 9m + 高亮色被 Bloom 提成刺眼白光带
  const edgeWidth = 4
  edge.add(box(ISLAND.width, 3, edgeWidth, 0, 0, -ISLAND.depth / 2))
  edge.add(box(ISLAND.width, 3, edgeWidth, 0, 0, ISLAND.depth / 2))
  edge.add(box(edgeWidth, 3, ISLAND.depth, -ISLAND.width / 2, 0, 0))
  edge.add(box(edgeWidth, 3, ISLAND.depth, ISLAND.width / 2, 0, 0))
  // 岛底光晕：稍大的半透明加性平面，模拟悬浮辉光
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(ISLAND.width * 1.35, ISLAND.depth * 1.4),
    new THREE.MeshBasicMaterial({
      color: '#0b6ea8',
      transparent: true,
      opacity: 0.11,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  )
  halo.rotation.x = -Math.PI / 2
  halo.position.y = -ISLAND.thickness - 6
  group.add(halo)

  // ── 2. 真实路网：LineString 裁到岛内 → 宽沥青 + 路缘 + 车道线 + 斑马线 ──
  const lanes: RoadLane[] = []
  const halfW = ISLAND.width / 2 - 18
  const halfD = ISLAND.depth / 2 - 18
  for (const feature of data.roads?.features ?? []) {
    const coords = feature.geometry?.coordinates as number[][] | undefined
    if (!coords || coords.length < 2) continue
    const a = checkpointToIsland(coords[0][0], coords[0][1])
    const b = checkpointToIsland(coords[coords.length - 1][0], coords[coords.length - 1][1])
    const segment = clipSegment(a, b, halfW, halfD)
    if (!segment) continue

    const [p0, p1] = segment
    const dx = p1[0] - p0[0]
    const dz = p1[1] - p0[1]
    const length = Math.hypot(dx, dz)
    if (length < 40) continue
    const ux = dx / length
    const uz = dz / length
    const nx = -uz
    const nz = ux
    const angle = -Math.atan2(dz, dx)
    const cx = (p0[0] + p1[0]) / 2
    const cz = (p0[1] + p1[1]) / 2
    // 宽度只按等级取值、不随坐标压缩：否则 17m 干道缩成 2m 细线，路网根本读不出来
    const width = feature.properties?.level === 'expressway' ? 34
      : feature.properties?.level === 'arterial' ? 26 : 18
    lanes.push({ a: p0, b: p1, width })

    const road = new THREE.BoxGeometry(length, 0.8, width)
    road.rotateY(angle)
    road.translate(cx, 0.45, cz)
    asphalt.add(road)

    for (const side of [-1, 1]) {
      const ex = cx + nx * side * (width / 2 - 1)
      const ez = cz + nz * side * (width / 2 - 1)
      const kerb = new THREE.BoxGeometry(length, 0.5, 1.6)
      kerb.rotateY(angle)
      kerb.translate(ex, 0.9, ez)
      curb.add(kerb)
    }
    // 中央虚线
    for (let s = 10; s < length - 10; s += 22) {
      const dash = new THREE.BoxGeometry(11, 0.5, 1.1)
      dash.rotateY(angle)
      dash.translate(p0[0] + ux * s, 0.9, p0[1] + uz * s)
      laneLines.add(dash)
    }
    // 路口斑马线：每条路两处
    for (const fraction of [0.3, 0.7]) {
      const s = length * fraction
      const px = p0[0] + ux * s
      const pz = p0[1] + uz * s
      for (let k = -4; k <= 4; k += 1) {
        const stripe = new THREE.BoxGeometry(5, 0.5, 1.8)
        stripe.rotateY(angle)
        stripe.translate(px + nx * k * 3.4, 0.92, pz + nz * k * 3.4)
        laneLines.add(stripe)
      }
    }
  }

  // ── 3. 真实数据：中心园区内的建筑群 ─────────────────────────
  if (data.blocks?.features?.length) {
    const clipped = clipFeatures(data.blocks.features)
    const buildings = buildBuildings({ features: clipped })
    if (buildings) {
      // 缩到园区尺度后 shader 窗格会糊成噪点：换成纯色材质，保留"地块切分"的体块肌理
      ;(buildings.material as THREE.Material).dispose()
      buildings.material = new THREE.MeshStandardMaterial({
        color: '#5a7ea4',
        roughness: 0.66,
        metalness: 0.2,
      })
      buildings.scale.set(0.18, 0.7, 0.18)
      buildings.position.set(100, 0, -140)
      buildings.name = 'planning:island-buildings'
      group.add(buildings)
    }
  }

  // ── 4. ETC / 卡口检测车道（示意）：缩到岛角 2×2，不再盖住整片路网 ──
  const laneW = 76
  const laneD = 56
  for (let col = 0; col < 2; col += 1) {
    for (let row = 0; row < 2; row += 1) {
      const x = -470 + col * (laneW + 10) + laneW / 2
      const z = -330 + row * (laneD + 14) + laneD / 2
      const deck = new THREE.BoxGeometry(laneW, 1.6, laneD)
      deck.rotateX(-0.06)
      deck.translate(x, 26, z)
      canopy.add(deck)

      // 顶棚分格（车道划分）与地面车道线
      for (let k = 1; k < 4; k += 1) {
        markings.add(box(0.8, 0.4, laneD, x - laneW / 2 + (laneW / 4) * k, 27, z))
        glow.add(box(0.9, 0.4, laneD, x - laneW / 2 + (laneW / 4) * k, 0.7, z))
      }

      // 龙门架：两立柱 + 横梁 + 三只摄像机（发光点为镜头）
      for (const sx of [-1, 1]) {
        equipment.add(box(3, 25, 3, x + sx * (laneW / 2 - 6), 12.5, z + laneD / 2 - 10))
      }
      equipment.add(box(laneW - 8, 3, 3, x, 25, z + laneD / 2 - 10))
      for (let k = 0; k < 3; k += 1) {
        const cx = x - laneW / 4 + (laneW / 4) * k
        equipment.add(box(5, 5, 6, cx, 22, z + laneD / 2 - 10))
        glow.add(box(2.2, 1.4, 1, cx, 22, z + laneD / 2 - 6.6))
      }
      // 地感线圈：每条车道一组发光矩形
      for (let k = 0; k < 3; k += 1) {
        const cx = x - laneW / 4 + (laneW / 4) * k
        glow.add(box(16, 0.5, 1, cx, 0.7, z - 10))
        glow.add(box(16, 0.5, 1, cx, 0.7, z - 2))
      }
    }
  }

  // 卡口龙门架沿真实路段中点布设：横梁垂直于行车方向，摄像机对准来车
  lanes.forEach((lane, index) => {
    if (index % 2 !== 0) return
    const dx = lane.b[0] - lane.a[0]
    const dz = lane.b[1] - lane.a[1]
    const length = Math.hypot(dx, dz)
    const nx = -dz / length
    const nz = dx / length
    const angle = -Math.atan2(dz, dx)
    const px = (lane.a[0] + lane.b[0]) / 2
    const pz = (lane.a[1] + lane.b[1]) / 2
    const half = lane.width / 2 + 4

    for (const side of [-1, 1]) {
      equipment.add(box(3, 26, 3, px + nx * side * half, 13, pz + nz * side * half))
    }
    const beam = new THREE.BoxGeometry(lane.width + 12, 3, 3)
    beam.rotateY(angle + Math.PI / 2)
    beam.translate(px, 26, pz)
    equipment.add(beam)
    for (let k = -1; k <= 1; k += 1) {
      const cx = px + nx * k * (lane.width / 3)
      const cz = pz + nz * k * (lane.width / 3)
      equipment.add(box(4, 4, 5, cx, 23, cz))
      glow.add(box(2.2, 1.4, 1, cx, 23, cz))
    }
    // 地感线圈：横跨路面的检测线
    for (const offset of [-8, 0, 8]) {
      const lx = px + (dx / length) * offset
      const lz = pz + (dz / length) * offset
      const coil = new THREE.BoxGeometry(lane.width - 6, 0.5, 1.2)
      coil.rotateY(angle + Math.PI / 2)
      coil.translate(lx, 0.95, lz)
      glow.add(coil)
    }
  })

  // ── 5. 路口信号灯 + VMS 情报板：按真实路网交点定位 ──────────
  const verticalXs = lanes
    .filter((lane) => Math.abs(lane.b[0] - lane.a[0]) < 1)
    .map((lane) => (lane.a[0] + lane.b[0]) / 2)
    .sort((a, b) => a - b)
  const horizontalZs = lanes
    .filter((lane) => Math.abs(lane.b[1] - lane.a[1]) < 1)
    .map((lane) => (lane.a[1] + lane.b[1]) / 2)
    .sort((a, b) => a - b)
  const junctionX = verticalXs[Math.floor(verticalXs.length / 2)] ?? 0
  const junctionZ = horizontalZs[Math.floor(horizontalZs.length / 2)] ?? 0

  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const x = junctionX + sx * 26
    const z = junctionZ + sz * 26
    equipment.add(box(2.6, 18, 2.6, x, 9, z))
    equipment.add(box(3, 8, 3, x, 21, z))
    // 对角两组分别代表南北向 / 东西向信号
    const lamp = box(2, 1.6, 0.8, x, 23, z + 1.7)
    if (sx === sz) signalNs.add(lamp)
    else signalEw.add(lamp)
  }
  // 情报板立在路肩外（±78m），不要悬在车道上方
  for (const [x, z] of [
    [junctionX + 150, junctionZ - 78],
    [junctionX - 150, junctionZ + 78],
  ]) {
    equipment.add(box(3, 26, 3, x, 13, z))
    equipment.add(box(76, 20, 3, x, 34, z))
    markings.add(box(70, 16, 0.6, x, 34, z + 1.8))
    glow.add(box(70, 0.8, 0.8, x, 43, z + 2))
  }

  // ── 6. 真实卡口点位 + 布控区轮廓（来自 PostGIS，不是示意）────────
  for (const feature of data.checkpoints?.features ?? []) {
    const coordinates = feature.geometry?.coordinates as [number, number] | undefined
    if (!coordinates) continue
    const [x, z] = checkpointToIsland(coordinates[0], coordinates[1])
    if (Math.abs(x) > ISLAND.width / 2 - 20 || Math.abs(z) > ISLAND.depth / 2 - 20) continue
    equipment.add(cylinder(1.6, 1.6, 9, x, 4.5, z, 6))
    glow.add(cylinder(3.4, 3.4, 0.7, x, 0.7, z, 10))
  }
  for (const feature of clipFeatures(data.zones?.features ?? [])) {
    const ring = (feature.geometry?.coordinates as number[][][])?.[0]
    if (!ring) continue
    for (let i = 0; i < ring.length - 1; i += 1) {
      const [x0, z0] = checkpointToIsland(ring[i][0], ring[i][1])
      const [x1, z1] = checkpointToIsland(ring[i + 1][0], ring[i + 1][1])
      const dx = x1 - x0
      const dz = z1 - z0
      const length = Math.hypot(dx, dz)
      if (length < 1) continue
      // 先旋转再平移：box() 已把几何平移到世界坐标，再 rotateY 会绕原点甩出去
      const bar = new THREE.BoxGeometry(length, 0.8, 2.4)
      bar.rotateY(-Math.atan2(dz, dx))
      bar.translate((x0 + x1) / 2, 1.2, (z0 + z1) / 2)
      zoneGlow.add(bar)
    }
  }

  // ── 7. 交通指挥中心（示意）：收进岛角，不再压住路网 ────────────
  const hx = 400
  const hz = -300
  equipment.add(box(120, 34, 84, hx, 17, hz))
  equipment.add(box(86, 22, 60, hx, 45, hz))
  glass.add(box(121, 24, 85, hx, 18, hz))
  glass.add(box(87, 14, 61, hx, 45, hz))
  for (let i = 0; i < 2; i += 1) {
    equipment.add(box(14, 4, 10, hx - 26 + i * 40, 58, hz))
    glow.add(box(12, 0.6, 8, hx - 26 + i * 40, 60, hz))
  }

  // ── 8. 路侧边缘计算节点柜（示意）：右下角一排 4 台 ──────────────
  for (let i = 0; i < 4; i += 1) {
    const x = 400 + (i % 2) * 34
    const z = 220 + Math.floor(i / 2) * 56
    equipment.add(box(26, 18, 40, x, 9, z))
    glass.add(box(26.5, 10, 40.5, x, 10, z))
    glow.add(box(20, 0.7, 1, x, 16, z + 20.4))
  }

  // ── 9. 行道树：放在真实路网围出的街区中心，不再站到车道中间 ────
  const treeSpots: Array<[number, number]> = []
  for (let i = 0; i < verticalXs.length - 1; i += 1) {
    for (let j = 0; j < horizontalZs.length - 1; j += 1) {
      const x = (verticalXs[i] + verticalXs[i + 1]) / 2
      const z = (horizontalZs[j] + horizontalZs[j + 1]) / 2
      if (Math.abs(x) > 460 || Math.abs(z) > 340) continue
      treeSpots.push([x, z])
      if ((i + j) % 2 === 0) treeSpots.push([x + 34, z - 26])
    }
  }
  for (const [x, z] of treeSpots) {
    trees.add(cylinder(1.8, 2.4, 12, x, 6, z, 6))
    trees.add(new THREE.ConeGeometry(11, 24, 7).translate(x, 22, z))
  }

  // ── 10. 按材质合并 ─────────────────────────────────────────
  const add = (bucket: Bucket, material: THREE.Material, name: string): void => {
    const mesh = bucket.build(material, name)
    if (mesh) group.add(mesh)
  }

  add(
    shell,
    new THREE.MeshStandardMaterial({ color: '#12283f', roughness: 0.88, metalness: 0.22 }),
    'planning:island-shell',
  )
  // 沥青明显亮于地台，路网才能一眼读出来；标线用 Basic 材质，不受灯光影响
  add(
    asphalt,
    new THREE.MeshStandardMaterial({ color: '#2b3d52', roughness: 0.95, metalness: 0.04 }),
    'planning:island-asphalt',
  )
  add(
    curb,
    new THREE.MeshBasicMaterial({ color: '#5b8db5', toneMapped: false }),
    'planning:island-curb',
  )
  add(
    laneLines,
    new THREE.MeshBasicMaterial({ color: '#c2d9ec', toneMapped: false }),
    'planning:island-lane-lines',
  )
  add(
    canopy,
    new THREE.MeshStandardMaterial({
      color: '#123a72',
      roughness: 0.28,
      metalness: 0.55,
      emissive: '#123f7d',
      emissiveIntensity: 0.8,
    }),
    'planning:island-gantry-canopy',
  )
  add(
    markings,
    new THREE.MeshBasicMaterial({ color: '#4f86c6', toneMapped: false }),
    'planning:island-markings',
  )
  add(
    zoneGlow,
    new THREE.MeshBasicMaterial({ color: '#c084fc', toneMapped: false }),
    'planning:island-zones',
  )
  add(
    equipment,
    new THREE.MeshStandardMaterial({ color: '#aec6dc', roughness: 0.55, metalness: 0.35 }),
    'planning:island-equipment',
  )
  add(
    glass,
    new THREE.MeshStandardMaterial({
      color: '#1d6f9c',
      roughness: 0.2,
      metalness: 0.6,
      transparent: true,
      opacity: 0.32,
      emissive: '#0a3450',
      emissiveIntensity: 0.5,
    }),
    'planning:island-glass',
  )
  add(
    trees,
    new THREE.MeshStandardMaterial({ color: '#1d6a4a', roughness: 0.9 }),
    'planning:island-trees',
  )
  add(
    glow,
    new THREE.MeshBasicMaterial({ color: '#6ff2ff', toneMapped: false }),
    'planning:island-device-glow',
  )
  add(
    edge,
    new THREE.MeshBasicMaterial({ color: '#2b86ad', toneMapped: false }),
    'planning:island-edge',
  )

  // 两组灯泡用独立材质，场景层按信号相位切换红/绿
  const nsMaterial = new THREE.MeshBasicMaterial({ color: '#ef4444', toneMapped: false })
  const ewMaterial = new THREE.MeshBasicMaterial({ color: '#ef4444', toneMapped: false })
  add(signalNs, nsMaterial, 'planning:island-signal-ns')
  add(signalEw, ewMaterial, 'planning:island-signal-ew')

  const anchors: Record<string, THREE.Vector3> = {
    gate: new THREE.Vector3(-380, 30, -280),
    center: new THREE.Vector3(400, 60, -300),
    junction: new THREE.Vector3(0, 10, 0),
  }
  return { group, anchors, lanes, signalMaterials: { ns: nsMaterial, ew: ewMaterial } }
}

/**
 * 告警光柱：按告警所属卡口定位（真实坐标压缩），级别决定高度与颜色。
 * 与静态岛分离，WS 推送新告警时可整体替换，不必重建整岛。
 */
export function buildAlarmBeacons(
  alarms: Array<{ checkpoint_id: string; level: string }>,
  positions: Map<string, [number, number]>,
): THREE.Group {
  const group = new THREE.Group()
  group.name = 'planning:alarm-beacons'
  const red = new THREE.MeshBasicMaterial({ color: '#ff5964', toneMapped: false })
  const amber = new THREE.MeshBasicMaterial({ color: '#f5a524', toneMapped: false })
  const geometry = new THREE.CylinderGeometry(2.2, 2.2, 1, 8)

  for (const alarm of alarms.slice(0, 12)) {
    const location = positions.get(alarm.checkpoint_id)
    if (!location) continue
    const [x, z] = checkpointToIsland(location[0], location[1])
    if (Math.abs(x) > ISLAND.width / 2 || Math.abs(z) > ISLAND.depth / 2) continue
    const height = alarm.level === 'critical' ? 60 : alarm.level === 'warning' ? 38 : 22
    const beacon = new THREE.Mesh(geometry, alarm.level === 'critical' ? red : amber)
    beacon.scale.set(1, height, 1)
    beacon.position.set(x, height / 2, z)
    group.add(beacon)
  }
  return group
}
