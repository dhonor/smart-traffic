import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { VehicleTarget } from '@traffic/shared-types'
import type { RoadLane } from './island'

/**
 * 车辆仿真模型（纯程序化，零外部资产）。
 *
 * 逼真度靠四件事，而不是靠堆面数：
 *   1. RoundedBox 圆角车身 + 独立座舱/车顶/侧裙/格栅，轮廓不再是方块；
 *   2. 顶点色分区：车漆（乘以 instanceColor）、深色玻璃、黑轮胎、银轮毂、深色饰件；
 *   3. 前后灯是独立 InstancedMesh（不受车漆色影响），Bloom 下能读到车头方向；
 *   4. 贴地椭圆接触阴影，否则车像悬浮在路面上。
 *
 * 朝向：车头朝 -Z；WS heading「正北 0°、顺时针」→ 绕 Y 轴旋转 -heading。
 * 仍是示意图，按 VEHICLE_SCALE 放大以保证 1.5km 视宽下可辨识（注释如实标注）。
 */

/** 已落到岛内车道上的车辆：由 VehicleFlow 每帧生成，不再直接用城市经纬度 */
export interface PlacedVehicle {
  vehicle_id: string
  x: number
  z: number
  heading: number
  speed_kph: number
  color: string
}

type VehicleKind = 'sedan' | 'truck' | 'bus'

const MAX_PER_KIND = 400
const MAX_TOTAL = 1200
const KINDS: VehicleKind[] = ['sedan', 'truck', 'bus']
/** 示意放大 2.2x：全景轴测下车长约 10px 才能读出车身轮廓，滚轮拉近后可见细节 */
const VEHICLE_SCALE = 2.2
/** 路面高度（园区岛道路面 y≈0.75），车轮必须落在路面上而不是埋进地台 */
const ROAD_Y = 0.82

const PAINT = {
  body: [1, 1, 1], // 由 instanceColor 决定车漆色
  glass: [0.1, 0.17, 0.24],
  tire: [0.05, 0.06, 0.07],
  rim: [0.58, 0.63, 0.7],
  trim: [0.2, 0.24, 0.29],
  roof: [0.82, 0.86, 0.9],
} as const

type Rgb = readonly [number, number, number]

/** 顶点色写入 + 统一非索引（mergeGeometries 不接受索引/非索引混用） */
function painted(geometry: THREE.BufferGeometry, rgb: Rgb): THREE.BufferGeometry {
  const result = geometry.index ? geometry.toNonIndexed() : geometry
  const count = result.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = rgb[0]
    colors[i * 3 + 1] = rgb[1]
    colors[i * 3 + 2] = rgb[2]
  }
  result.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return result
}

function rounded(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  radius: number, rgb: Rgb,
): THREE.BufferGeometry {
  const geometry = new RoundedBoxGeometry(w, h, d, 2, radius)
  geometry.translate(x, y, z)
  return painted(geometry, rgb)
}

function box(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  rgb: Rgb,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d)
  geometry.translate(x, y, z)
  return painted(geometry, rgb)
}

function wheelSet(
  parts: THREE.BufferGeometry[],
  radius: number,
  width: number,
  positions: Array<[number, number]>,
): void {
  for (const [x, z] of positions) {
    const tire = new THREE.CylinderGeometry(radius, radius, width, 14)
    tire.rotateZ(Math.PI / 2)
    tire.translate(x, radius, z)
    parts.push(painted(tire, PAINT.tire))
    for (const side of [-1, 1]) {
      const rim = new THREE.CylinderGeometry(radius * 0.52, radius * 0.52, 0.03, 12)
      rim.rotateZ(Math.PI / 2)
      rim.translate(x + side * (width / 2 + 0.015), radius, z)
      parts.push(painted(rim, PAINT.rim))
    }
  }
}

/** 每种车型：几何 + 前后灯在车身局部坐标中的位置 */
interface VehicleSpec {
  geometry: THREE.BufferGeometry
  frontZ: number
  rearZ: number
  lightY: number
  lightWidth: number
  shadow: [number, number]
}

function sedanSpec(): VehicleSpec {
  const parts: THREE.BufferGeometry[] = []
  parts.push(rounded(1.86, 0.7, 4.5, 0, 0.72, 0, 0.28, PAINT.body))
  parts.push(rounded(1.66, 0.54, 2.3, 0, 1.32, 0.18, 0.22, PAINT.glass))
  parts.push(rounded(1.52, 0.1, 1.9, 0, 1.6, 0.2, 0.05, PAINT.body))
  parts.push(box(1.88, 0.1, 3.5, 0, 0.42, 0, PAINT.trim))
  parts.push(box(1.24, 0.16, 0.09, 0, 0.74, -2.26, PAINT.trim))
  parts.push(box(1.24, 0.16, 0.09, 0, 0.74, 2.26, PAINT.trim))
  wheelSet(parts, 0.34, 0.22, [
    [-0.93, -1.42], [0.93, -1.42], [-0.93, 1.42], [0.93, 1.42],
  ])
  return {
    geometry: mergeGeometries(parts, false)!,
    frontZ: -2.3, rearZ: 2.3, lightY: 0.78, lightWidth: 1.4, shadow: [2.4, 5.4],
  }
}

function truckSpec(): VehicleSpec {
  const parts: THREE.BufferGeometry[] = []
  parts.push(rounded(2.4, 0.42, 15.6, 0, 0.95, 0, 0.1, PAINT.trim))
  parts.push(rounded(2.5, 2.5, 2.6, 0, 2.3, -6.1, 0.32, PAINT.body))
  parts.push(rounded(2.44, 0.85, 0.1, 0, 2.85, -7.42, 0.05, PAINT.glass))
  parts.push(rounded(2.3, 0.24, 0.8, 0, 3.62, -6.6, 0.1, PAINT.roof))
  parts.push(rounded(2.55, 3.0, 12.4, 0, 2.45, 1.9, 0.14, PAINT.roof))
  parts.push(box(2.6, 0.16, 12.2, 0, 1.5, 1.9, PAINT.trim))
  for (const x of [-1.05, 1.05]) {
    const stack = new THREE.CylinderGeometry(0.11, 0.11, 1.5, 8)
    stack.translate(x, 3.0, -4.75)
    parts.push(painted(stack, PAINT.rim))
  }
  wheelSet(parts, 0.5, 0.3, [
    [-1.08, -6.6], [1.08, -6.6], [-1.08, -5.3], [1.08, -5.3],
    [-1.08, 3.6], [1.08, 3.6], [-1.08, 4.9], [1.08, 4.9], [-1.08, 6.4], [1.08, 6.4],
  ])
  return {
    geometry: mergeGeometries(parts, false)!,
    frontZ: -7.5, rearZ: 8.2, lightY: 1.35, lightWidth: 2.1, shadow: [3.2, 17],
  }
}

function busSpec(): VehicleSpec {
  const parts: THREE.BufferGeometry[] = []
  parts.push(rounded(2.5, 2.5, 11.4, 0, 1.8, 0, 0.34, PAINT.body))
  parts.push(rounded(2.54, 0.92, 10.5, 0, 2.35, 0, 0.07, PAINT.glass))
  parts.push(rounded(2.0, 0.24, 2.2, 0, 3.18, 1.2, 0.1, PAINT.roof))
  parts.push(box(2.56, 0.12, 10.8, 0, 0.68, 0, PAINT.trim))
  parts.push(box(1.8, 0.3, 0.09, 0, 2.92, -5.73, PAINT.trim))
  wheelSet(parts, 0.47, 0.3, [
    [-1.1, -3.9], [1.1, -3.9], [-1.1, 3.9], [1.1, 3.9],
  ])
  return {
    geometry: mergeGeometries(parts, false)!,
    frontZ: -5.78, rearZ: 5.78, lightY: 1.05, lightWidth: 2.0, shadow: [3.1, 12.4],
  }
}

function kindOf(vehicleId: string): VehicleKind {
  // 稳定哈希：同一辆车永远同车型，不会在帧间跳变
  let hash = 0
  for (let i = 0; i < vehicleId.length; i += 1) hash = (hash * 31 + vehicleId.charCodeAt(i)) | 0
  const bucket = Math.abs(hash) % 10
  if (bucket < 7) return 'sedan'
  if (bucket < 9) return 'truck'
  return 'bus'
}

export class VehicleFleet {
  private readonly specs: Record<VehicleKind, VehicleSpec>
  private readonly meshes = new Map<VehicleKind, THREE.InstancedMesh>()
  private readonly headlights: THREE.InstancedMesh
  private readonly taillights: THREE.InstancedMesh
  private readonly shadows: THREE.InstancedMesh
  private readonly matrix = new THREE.Matrix4()
  private readonly lightMatrix = new THREE.Matrix4()
  private readonly shadowMatrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly offset = new THREE.Vector3()
  private readonly quaternion = new THREE.Quaternion()
  private readonly flatQuaternion = new THREE.Quaternion()
  private readonly scale = new THREE.Vector3()
  private readonly color = new THREE.Color()
  private readonly axisY = new THREE.Vector3(0, 1, 0)

  constructor(scene: THREE.Scene) {
    this.specs = { sedan: sedanSpec(), truck: truckSpec(), bus: busSpec() }

    const material = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      vertexColors: true,
      roughness: 0.34,
      metalness: 0.32,
    })
    const white = new THREE.Color('#ffffff')

    for (const kind of KINDS) {
      const mesh = new THREE.InstancedMesh(this.specs[kind].geometry, material, MAX_PER_KIND)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.name = `planning:vehicles:${kind}`
      for (let i = 0; i < MAX_PER_KIND; i += 1) mesh.setColorAt(i, white)
      scene.add(mesh)
      this.meshes.set(kind, mesh)
    }

    const lightGeometry = new THREE.BoxGeometry(1, 0.3, 0.16)
    this.headlights = new THREE.InstancedMesh(
      lightGeometry,
      new THREE.MeshBasicMaterial({ color: '#fff3cf', toneMapped: false }),
      MAX_TOTAL,
    )
    this.taillights = new THREE.InstancedMesh(
      lightGeometry,
      new THREE.MeshBasicMaterial({ color: '#ff3b30', toneMapped: false }),
      MAX_TOTAL,
    )
    for (const mesh of [this.headlights, this.taillights]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.name = 'planning:vehicle-lights'
      scene.add(mesh)
    }

    const shadowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
    this.shadows = new THREE.InstancedMesh(
      shadowGeometry,
      new THREE.MeshBasicMaterial({
        color: '#02060c',
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
      MAX_TOTAL,
    )
    this.shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.shadows.count = 0
    this.shadows.frustumCulled = false
    this.shadows.name = 'planning:vehicle-shadows'
    scene.add(this.shadows)
  }

  update(placed: PlacedVehicle[]): void {
    const used: Record<VehicleKind, number> = { sedan: 0, truck: 0, bus: 0 }
    let lightCount = 0

    for (const target of placed) {
      const kind = kindOf(target.vehicle_id)
      const index = used[kind]
      const mesh = this.meshes.get(kind)!
      const spec = this.specs[kind]
      if (index >= MAX_PER_KIND || lightCount >= MAX_TOTAL) continue

      const x = target.x
      const z = target.z
      this.position.set(x, ROAD_Y, z)
      // heading: 正北 0° 顺时针 → 几何 -Z 朝向，绕 Y 轴转 -heading
      this.quaternion.setFromAxisAngle(this.axisY, (-target.heading * Math.PI) / 180)
      const jitter = 0.96 + ((index % 7) / 7) * 0.08
      const factor = jitter * VEHICLE_SCALE
      this.scale.set(factor, factor, factor)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      mesh.setMatrixAt(index, this.matrix)

      this.color.set(target.speed_kph < 22 ? '#d9534f' : target.color || '#c8dcf0')
      mesh.setColorAt(index, this.color)
      used[kind] = index + 1

      // 前后灯：局部偏移先按航向旋转，再叠加到车身位置
      const lightScale = new THREE.Vector3(spec.lightWidth * factor, factor, factor)
      for (const [instance, localZ] of [
        [this.headlights, spec.frontZ],
        [this.taillights, spec.rearZ],
      ] as const) {
        this.offset
          .set(0, spec.lightY * factor, localZ * factor)
          .applyQuaternion(this.quaternion)
          .add(this.position)
        this.lightMatrix.compose(this.offset, this.quaternion, lightScale)
        instance.setMatrixAt(lightCount, this.lightMatrix)
      }

      // 接触阴影：贴路面、不随车身旋转以外的变换，略放大一圈
      this.shadowMatrix.compose(
        new THREE.Vector3(x, ROAD_Y - 0.06, z),
        this.flatQuaternion,
        new THREE.Vector3(spec.shadow[0] * factor, 1, spec.shadow[1] * factor),
      )
      this.shadows.setMatrixAt(lightCount, this.shadowMatrix)
      lightCount += 1
    }

    for (const kind of KINDS) {
      const mesh = this.meshes.get(kind)!
      mesh.count = used[kind]
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
    for (const mesh of [this.headlights, this.taillights, this.shadows]) {
      mesh.count = lightCount
      mesh.instanceMatrix.needsUpdate = true
    }
  }

  setVisible(visible: boolean): void {
    for (const mesh of this.meshes.values()) mesh.visible = visible
    this.headlights.visible = visible
    this.taillights.visible = visible
    this.shadows.visible = visible
  }

  dispose(): void {
    const sharedMaterial = this.meshes.values().next().value?.material as THREE.Material | undefined
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose()
      mesh.removeFromParent()
    }
    this.meshes.clear()
    sharedMaterial?.dispose()
    for (const mesh of [this.headlights, this.taillights, this.shadows]) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      mesh.removeFromParent()
    }
  }
}

/**
 * 车流驱动：把真实车辆的「数量 / 速度 / 车色 / 车型 id」绑定到示意车道上。
 *
 * 为什么不用真实经纬度：园区岛是城市 10km 路网 0.12 压缩后的示意场景，
 * 把 10km 车流坐标硬压进 1.1km 岛里，车会散落在建筑、草地上且朝向乱。
 * 现在位置由车道动画生成（双向分道、右侧通行、按速度推进、首尾循环），
 * 速度仍逐帧取 WS 推送值，所以拥堵变红、车流快慢都是真实数据。
 */
interface FlowState {
  laneIndex: number
  direction: 1 | -1
  /** 沿法向的车道偏移（右行为负/正随方向而定） */
  lateral: number
  /** 车队中的固定序号：队列顺序不随帧变化 */
  queueIndex: number
  /** 沿行进方向的环形弧长 [0, laneLength) */
  s: number
  speedKph: number
  actualSpeed: number
  /** 车身长度（含 2.2x 示意放大），决定最小车距 */
  lengthM: number
  color: string
}

const FLOW_PAINTS = ['#dbe5ef', '#94a9bd', '#334b66', '#a8b8c8', '#c9a24a', '#b04a44']
/** 示意时间倍率：1.6x 让 1.1km 岛上的流动肉眼可辨 */
const FLOW_TIME_SCALE = 1.6
/** 两车半长之和之外再留 6m 安全余量 */
const SAFE_GAP = 6
const BODY_LENGTH: Record<VehicleKind, number> = { sedan: 4.5, truck: 16.5, bus: 11.4 }

/** 路口信号：东西绿 5s → 全红 1s → 南北绿 5s → 全红 1s */
const SIGNAL_CYCLE = 12
const SIGNAL_GREEN = 5
const SIGNAL_ALL_RED = 1
/** 冲突区半宽与停止线余量：车身最长 36m，20m 内视为占用路口 */
const CONFLICT_HALF = 20
const STOP_MARGIN = CONFLICT_HALF + 3

type Axis = 'ns' | 'ew'
interface Crossing {
  /** 交点在该路段上的参数 t∈(0,1) */
  t: number
  key: string
}
interface LaneInfo {
  length: number
  axis: Axis
  crossings: Crossing[]
}

function vehicleLengthM(id: string): number {
  return BODY_LENGTH[kindOf(id)] * VEHICLE_SCALE
}

/** 跟驰最小车距：前后两车各半个车身 + 安全余量 */
function minGap(front: FlowState, back: FlowState): number {
  return (front.lengthM + back.lengthM) / 2 + SAFE_GAP
}

function hashId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return Math.abs(hash)
}

function laneLength(lane: RoadLane): number {
  return Math.hypot(lane.b[0] - lane.a[0], lane.b[1] - lane.a[1])
}

interface LaneGroup {
  key: string
  length: number
  cars: FlowState[]
}

export class VehicleFlow {
  private readonly states = new Map<string, FlowState>()
  /** 每条「车道+方向」的车队相位：整队共享，相对间距恒定 */
  private readonly lanePhase = new Map<string, number>()
  private readonly queueCounts = new Map<string, number>()
  private readonly laneInfo = new Map<number, LaneInfo>()
  private elapsed = 0

  constructor(private lanes: RoadLane[]) {}

  setLanes(lanes: RoadLane[]): void {
    this.lanes = lanes
    this.states.clear()
    this.lanePhase.clear()
    this.queueCounts.clear()
    this.laneInfo.clear()
    this.elapsed = 0

    // 横路（东西向）与竖路（南北向）的常量坐标，用于求路口交点
    const horizontals: number[] = []
    const verticals: number[] = []
    lanes.forEach((lane) => {
      const dx = Math.abs(lane.b[0] - lane.a[0])
      const dz = Math.abs(lane.b[1] - lane.a[1])
      if (dx >= dz) horizontals.push((lane.a[1] + lane.b[1]) / 2)
      else verticals.push((lane.a[0] + lane.b[0]) / 2)
    })

    lanes.forEach((lane, index) => {
      const dx = lane.b[0] - lane.a[0]
      const dz = lane.b[1] - lane.a[1]
      const length = Math.hypot(dx, dz)
      const axis: Axis = Math.abs(dx) >= Math.abs(dz) ? 'ew' : 'ns'
      const cx = (lane.a[0] + lane.b[0]) / 2
      const cz = (lane.a[1] + lane.b[1]) / 2
      // 只取真正落在本路段上的交点：横路配所有竖路 x，竖路配所有横路 z
      const points = axis === 'ew'
        ? verticals.map((x) => ({ x, z: cz }))
        : horizontals.map((z) => ({ x: cx, z }))
      const crossings: Crossing[] = []
      for (const point of points) {
        const t = ((point.x - lane.a[0]) * dx + (point.z - lane.a[1]) * dz) / (length * length)
        if (t > 0.03 && t < 0.97) {
          crossings.push({ t, key: `${Math.round(point.x)}:${Math.round(point.z)}` })
        }
      }
      this.laneInfo.set(index, { length, axis, crossings })
    })
  }

  /** 当前绿灯方向；null 表示全红清空相位 */
  private greenAxis(): Axis | null {
    const cycle = this.elapsed % SIGNAL_CYCLE
    if (cycle < SIGNAL_GREEN) return 'ew'
    if (cycle >= SIGNAL_GREEN + SIGNAL_ALL_RED && cycle < SIGNAL_GREEN * 2 + SIGNAL_ALL_RED) {
      return 'ns'
    }
    return null
  }

  /** 按路口统计占用方向：互斥只在单个路口生效，避免一个方向的车队让全城另一方向饥饿 */
  private occupancy(): Map<string, Set<Axis>> {
    const map = new Map<string, Set<Axis>>()
    for (const state of this.states.values()) {
      const info = this.laneInfo.get(state.laneIndex)
      if (!info) continue
      for (const cross of info.crossings) {
        const sCross = state.direction > 0 ? cross.t * info.length : (1 - cross.t) * info.length
        const raw = Math.abs(state.s - sCross)
        if (Math.min(raw, info.length - raw) < CONFLICT_HALF) {
          const set = map.get(cross.key) ?? new Set<Axis>()
          set.add(info.axis)
          map.set(cross.key, set)
        }
      }
    }
    return map
  }

  /** 全局方向占用（仅诊断用） */
  private busyAxes(): Set<Axis> {
    const busy = new Set<Axis>()
    for (const state of this.states.values()) {
      const info = this.laneInfo.get(state.laneIndex)
      if (!info) continue
      for (const cross of info.crossings) {
        const sCross = state.direction > 0 ? cross.t * info.length : (1 - cross.t) * info.length
        const raw = Math.abs(state.s - sCross)
        if (Math.min(raw, info.length - raw) < CONFLICT_HALF) {
          busy.add(info.axis)
          break
        }
      }
    }
    return busy
  }

  /** 沿行进方向的下一个停止线及其所属路口 */
  private nextStop(
    phase: number,
    info: LaneInfo,
    direction: 1 | -1,
  ): { delta: number; key: string } | null {
    let best: { delta: number; key: string } | null = null
    for (const cross of info.crossings) {
      const sCross = direction > 0 ? cross.t * info.length : (1 - cross.t) * info.length
      const sStop = (((sCross - STOP_MARGIN) % info.length) + info.length) % info.length
      const delta = (((sStop - phase) % info.length) + info.length) % info.length
      if (!best || delta < best.delta) best = { delta, key: cross.key }
    }
    return best
  }

  /** 找一段能容纳整条车队、且不压任何路口冲突区的初始相位 */
  private findSafePhase(
    length: number,
    info: LaneInfo | undefined,
    direction: 1 | -1,
    ordered: FlowState[],
  ): number {
    if (!info || !info.crossings.length) return length * 0.9
    const offsets: number[] = []
    let acc = 0
    for (let i = 0; i < ordered.length; i += 1) {
      if (i > 0) acc += minGap(ordered[i - 1], ordered[i])
      offsets.push(acc)
    }
    const sCrosses = info.crossings.map((cross) =>
      direction > 0 ? cross.t * length : (1 - cross.t) * length,
    )
    for (let candidate = length * 0.95; candidate > 0; candidate -= 10) {
      let safe = true
      for (const offset of offsets) {
        const s = (((candidate - offset) % length) + length) % length
        for (const sCross of sCrosses) {
          const raw = Math.abs(s - sCross)
          if (Math.min(raw, length - raw) < CONFLICT_HALF + 2) {
            safe = false
            break
          }
        }
        if (!safe) break
      }
      if (safe) return candidate
    }
    return length * 0.9
  }

  sync(targets: VehicleTarget[]): void {
    if (!this.lanes.length) return
    const seen = new Set<string>()

    targets.forEach((target) => {
      const id = target.vehicle_id
      // 1/8 抽样：车队长度必须小于路口间距，才能整队停在两个路口之间等红灯
      // （按 id 稳定哈希，WS 数组顺序变化不会整批重建车辆）
      if (hashId(id) % 8 !== 0) return
      seen.add(id)
      let state = this.states.get(id)

      if (!state) {
        const seed = hashId(id)
        const laneIndex = seed % this.lanes.length
        const direction: 1 | -1 = (seed >> 3) % 2 === 0 ? 1 : -1
        const lane = this.lanes[laneIndex]
        const key = `${laneIndex}:${direction}`
        const queueIndex = this.queueCounts.get(key) ?? 0
        this.queueCounts.set(key, queueIndex + 1)
        state = {
          laneIndex,
          direction,
          queueIndex,
          // 右侧通行：normal=(-uz, ux) 指向左侧，故乘 -direction
          lateral: -direction * lane.width * 0.26,
          s: 0,
          speedKph: target.speed_kph,
          actualSpeed: (target.speed_kph / 3.6) * FLOW_TIME_SCALE,
          lengthM: vehicleLengthM(id),
          color: FLOW_PAINTS[seed % FLOW_PAINTS.length],
        }
        this.states.set(id, state)
      }

      state.speedKph = target.speed_kph
      state.color = target.speed_kph < 22 ? '#d9534f' : FLOW_PAINTS[hashId(id) % FLOW_PAINTS.length]
    })

    for (const id of this.states.keys()) {
      if (!seen.has(id)) this.states.delete(id)
    }
    // 新车立即按队列相位落位，避免第一帧全部堆在 s=0
    this.advance(0)
  }

  /** 按「车道 + 行驶方向」分组：双向车道互不干扰 */
  private groups(): LaneGroup[] {
    const map = new Map<string, FlowState[]>()
    for (const state of this.states.values()) {
      const key = `${state.laneIndex}:${state.direction}`
      const list = map.get(key) ?? []
      list.push(state)
      map.set(key, list)
    }
    return [...map.entries()].map(([key, cars]) => ({
      key,
      length: laneLength(this.lanes[Number(key.split(':')[0])]),
      cars,
    }))
  }

  /**
   * 相位队列：一条车道 = 一个刚性车队。
   *   队首相位按该车道**最慢车**的真实速度推进（跟驰约定：最慢车决定队速，
   *   拥堵变红时整队减速）；第 i 辆车位置 = 相位 - 累计最小车距（环形取模）。
   * 相对间距恒定且由车长决定，因此离散帧、低帧率、队首绕回终点都不会穿模，
   * 也不会出现后车压过前车。
   */
  private advance(dt: number): void {
    this.elapsed += dt
    const green = this.greenAxis()
    const occupancy = this.occupancy()

    for (const group of this.groups()) {
      const ordered = [...group.cars].sort((a, b) => a.queueIndex - b.queueIndex)
      if (!ordered.length) continue
      const laneIndex = Number(group.key.split(':')[0])
      const direction = Number(group.key.split(':')[1]) as 1 | -1
      const info = this.laneInfo.get(laneIndex)
      // 队速取车道平均真实速度（低速车 20km/h 兜底）：取最小值会让一辆慢车
      // 把整条车道拖到近乎静止，车流既难看也永远走不到路口
      const leadSpeed =
        (ordered.reduce((sum, car) => sum + Math.max(car.speedKph, 20), 0) /
          ordered.length /
          3.6) *
        FLOW_TIME_SCALE
      // 首次初始化时挑一个"整队都不压在任何路口冲突区"的相位，避免启动即冲突
      const phase = this.lanePhase.get(group.key)
        ?? this.findSafePhase(group.length, info, direction, ordered)

      let step = leadSpeed * dt
      if (info) {
        const stop = this.nextStop(phase, info, direction)
        if (stop) {
          const occ = occupancy.get(stop.key)
          const other: Axis = info.axis === 'ew' ? 'ns' : 'ew'
          const blockedByOther = occ?.has(other) ?? false
          // 自己车队尾部还没离开该路口时继续清空，避免占着路口把对方永久卡住
          const selfClearing = occ?.has(info.axis) ?? false
          const canGo = !blockedByOther && (green === info.axis || selfClearing)
          // 不放行时整队只开到这个路口的停止线，后车不会被甩进冲突区
          if (!canGo) step = Math.min(step, Math.max(0, stop.delta - 0.2))
        }
      }
      const next = (phase + step) % group.length
      this.lanePhase.set(group.key, next)

      let offset = 0
      for (let i = 0; i < ordered.length; i += 1) {
        if (i > 0) offset += minGap(ordered[i - 1], ordered[i])
        ordered[i].s = (((next - offset) % group.length) + group.length) % group.length
        ordered[i].actualSpeed = step / Math.max(dt, 0.0001)
      }
    }
  }

  /** 供场景层每帧更新信号灯颜色 */
  signalPhase(): { green: Axis | null; cycle: number } {
    return { green: this.greenAxis(), cycle: this.elapsed % SIGNAL_CYCLE }
  }

  /** 验收用：同一路口冲突区内同时出现南北向与东西向车辆的数量 */
  debugConflicts(): {
    conflicts: number
    green: Axis | null
    busy: string[]
    cycle: number
    crossings: number
    lanes: number
    minDist: number
  } {
    const byKey = new Map<string, Set<Axis>>()
    let minDist = Infinity
    for (const state of this.states.values()) {
      const info = this.laneInfo.get(state.laneIndex)
      if (!info) continue
      for (const cross of info.crossings) {
        const sCross = state.direction > 0 ? cross.t * info.length : (1 - cross.t) * info.length
        const raw = Math.abs(state.s - sCross)
        const dist = Math.min(raw, info.length - raw)
        if (dist < minDist) minDist = dist
        if (dist >= CONFLICT_HALF) continue
        const set = byKey.get(cross.key) ?? new Set<Axis>()
        set.add(info.axis)
        byKey.set(cross.key, set)
      }
    }
    let conflicts = 0
    for (const set of byKey.values()) if (set.size > 1) conflicts += 1
    let crossings = 0
    for (const info of this.laneInfo.values()) crossings += info.crossings.length
    return {
      conflicts,
      green: this.greenAxis(),
      busy: [...this.busyAxes()],
      cycle: Math.round((this.elapsed % SIGNAL_CYCLE) * 10) / 10,
      crossings,
      lanes: this.laneInfo.size,
      minDist: Number.isFinite(minDist) ? Math.round(minDist) : -1,
    }
  }

  tick(dtSeconds: number): void {
    if (!this.lanes.length) return
    // 上限 0.25s：切后台回来不会瞬移；低帧率下相位仍按真实时间推进
    this.advance(Math.min(Math.max(dtSeconds, 0), 0.25))
  }

  /** 验收用：同车道相邻车的净距（扣掉最小车距后）与违规数 */
  debugSpacing(): {
    minClearance: number | null
    violations: number
    lanes: number
    total: number
    worst: number[]
  } {
    let minClearance = Infinity
    let violations = 0
    let lanes = 0
    let worst: number[] = []
    for (const group of this.groups()) {
      if (group.cars.length < 2) continue
      lanes += 1
      // 必须与 advance() 用同一个队列顺序，否则绕回终点时顺序错开会误判
      const ordered = [...group.cars].sort((a, b) => a.queueIndex - b.queueIndex)
      for (let i = 0; i < ordered.length; i += 1) {
        const front = ordered[i]
        const back = ordered[(i + 1) % ordered.length]
        const gap = (((front.s - back.s) % group.length) + group.length) % group.length
        const clearance = gap - minGap(front, back)
        if (clearance < minClearance) {
          minClearance = clearance
          worst = ordered.map((car) => Math.round(car.s))
        }
        if (clearance < -0.01) violations += 1
      }
    }
    return {
      minClearance: Number.isFinite(minClearance) ? Math.round(minClearance * 100) / 100 : null,
      violations,
      lanes,
      total: this.states.size,
      worst: worst.slice(0, 12),
    }
  }

  snapshot(): PlacedVehicle[] {
    const placed: PlacedVehicle[] = []
    for (const [id, state] of this.states) {
      const lane = this.lanes[state.laneIndex]
      if (!lane) continue
      const dx = lane.b[0] - lane.a[0]
      const dz = lane.b[1] - lane.a[1]
      const length = Math.hypot(dx, dz)
      const ux = dx / length
      const uz = dz / length
      const nx = -uz
      const nz = ux
      const t = state.direction > 0 ? state.s / length : 1 - state.s / length
      const x = lane.a[0] + dx * t + nx * state.lateral
      const z = lane.a[1] + dz * t + nz * state.lateral
      // 几何车头朝 -Z；heading 正北 0° 顺时针 → 由行进向量反解
      const vx = ux * state.direction
      const vz = uz * state.direction
      const heading = (Math.atan2(vx, -vz) * 180) / Math.PI
      placed.push({
        vehicle_id: id,
        x,
        z,
        heading,
        speed_kph: state.speedKph,
        color: state.color,
      })
    }
    return placed
  }
}
