import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js'
import type { VehicleTarget } from '@traffic/shared-types'
import { buildAlarmBeacons, buildIsland, type IslandData } from './island'
import { VehicleFleet, VehicleFlow } from './vehicles'

/**
 * 规划视图：独立 three.js 上下文 + 正交相机 + 辉光。
 *
 * 为什么不复用 Cesium 的共享上下文：
 *   UnrealBloomPass 需要把整帧渲染到离屏 RT 再叠加，共享上下文里 Cesium 的 FBO
 *   与深度精度（远平面 5e8）会让 Three 的深度测试失效、画面被 Cesium 覆盖。
 *   规划视图是「第二渲染模式」，两个画布互斥显示，独立上下文最稳。
 *
 * 相机：正交投影 + 固定 45° 俯角，缩放改视景体大小（不移动相机距离），
 *       保证不同缩放下建筑立面比例一致 —— 这是规划图与轴测图的读图习惯。
 */

export interface PlanningStaticData extends IslandData {}

const CAMERA_DIR = new THREE.Vector3(0.9, 0.75, 0.9).normalize()

/** 三张指标卡：卡口区 / 指挥中心 / 路口，业务指标由 App 层传入 */
const LABEL_KEYS = ['gate', 'center', 'junction'] as const
type LabelKey = (typeof LABEL_KEYS)[number]

export interface EnergyLabel {
  title: string
  value: string
  unit: string
}

export class PlanningScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 16000)
  private readonly composer: EffectComposer
  private readonly bloom: UnrealBloomPass
  private readonly fleet: VehicleFleet
  private readonly flow = new VehicleFlow([])
  private readonly target = new THREE.Vector3(0, 0, 0)
  private readonly canvas: HTMLCanvasElement
  private readonly resizeObserver: ResizeObserver
  private readonly labelLayer: HTMLDivElement
  private readonly labelElements = new Map<LabelKey, HTMLDivElement>()
  private island: THREE.Group | null = null
  private energyLines: THREE.Group | null = null
  private alarmBeacons: THREE.Group | null = null
  private layerState: Record<string, boolean> = {}
  private anchors: Record<string, THREE.Vector3> = {}
  private signalMaterials: { ns: THREE.MeshBasicMaterial; ew: THREE.MeshBasicMaterial } | null = null
  private viewSize = 1600
  private zoom = 1600
  private visible = false
  private frame = 0
  private dragging = false
  private lastPointer = { x: 0, y: 0 }
  private latest: VehicleTarget[] = []
  private lastFrameAt = 0

  constructor(private readonly container: HTMLElement) {
    RectAreaLightUniformsLib.init()

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.12
    this.renderer.domElement.className = 'planning-canvas'
    container.appendChild(this.renderer.domElement)
    this.canvas = this.renderer.domElement

    // 能量标签是 HTML（不是 3D 文字）：正交相机下每帧投影一次，永远正对屏幕且清晰
    this.labelLayer = document.createElement('div')
    this.labelLayer.className = 'planning-labels'
    for (const key of LABEL_KEYS) {
      const element = document.createElement('div')
      element.className = `energy-label energy-label--${key}`
      this.labelLayer.appendChild(element)
      this.labelElements.set(key, element)
    }
    container.appendChild(this.labelLayer)

    this.scene.background = new THREE.Color('#050b15')

    this.camera.near = 1
    this.camera.far = 16000
    this.scene.add(this.camera)

    this.buildGround()
    this.buildLights()

    this.fleet = new VehicleFleet(this.scene)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    // 阈值抬高、半径收小：只让车灯/信号灯这类小发光体溢出，岛缘与建筑不再糊成白光带
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.72, 0.35, 0.82)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointerleave', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })

    this.applyView()
  }

  private buildGround(): void {
    // 程序化径向渐变底图：无外部贴图，给悬浮岛一层深蓝辉光背景
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 512
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createRadialGradient(256, 256, 20, 256, 256, 256)
    gradient.addColorStop(0, '#061627')
    gradient.addColorStop(0.45, '#040e1c')
    gradient.addColorStop(1, '#02060d')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 512, 512)
    const texture = new THREE.CanvasTexture(canvas)
    // Canvas 像素是 sRGB；不声明会被当线性值，暗底被 OutputPass 提亮成青蓝色
    texture.colorSpace = THREE.SRGBColorSpace

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(9000, 9000),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.35
    ground.name = 'planning:ground'
    this.scene.add(ground)

    const grid = new THREE.GridHelper(9000, 90, '#16304a', '#0c2034')
    grid.position.y = -0.2
    // 网格是参照系：只留极淡的暗示，不能抢园区岛的视觉主体
    const gridMaterial = grid.material as THREE.Material
    gridMaterial.transparent = true
    gridMaterial.opacity = 0.12
    this.scene.add(grid)
  }

  private buildLights(): void {
    // RectAreaLight 只留一盏暖色顶光：发光面大于视窗（边缘不进画面），
    // 且不投影阴影；冷色基调交给 Hemisphere + Directional，避免第二盏面光
    // 的矩形边缘在画面里切出明暗分界（实测踩坑）
    const key = new THREE.RectAreaLight(0xffd8a3, 0.9, 6000, 6000)
    key.position.set(0, 700, 0)
    key.lookAt(0, 0, 0)
    this.scene.add(key)

    const hemi = new THREE.HemisphereLight(0x8fb8ff, 0x0a1220, 1.15)
    this.scene.add(hemi)

    const sun = new THREE.DirectionalLight(0xa9c8ff, 1.5)
    sun.position.set(320, 620, 240)
    this.scene.add(sun)
  }

  setStatic(data: PlanningStaticData): void {
    if (this.island) {
      this.island.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material?.dispose()
      })
      this.scene.remove(this.island)
      this.island = null
    }
    if (this.energyLines) {
      this.energyLines.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else material?.dispose()
      })
      this.scene.remove(this.energyLines)
      this.energyLines = null
    }

    const island = buildIsland(data)
    this.island = island.group
    this.anchors = island.anchors
    this.signalMaterials = island.signalMaterials
    this.scene.add(this.island)
    // 车道来自真实路网裁切：车流与路面共用同一份几何依据，不会跑出路面
    this.flow.setLanes(island.lanes)
    this.flow.sync(this.latest)
    this.fleet.update(this.flow.snapshot())
    this.buildEnergyLines()

    // 园区岛固定 1.1km 见方，不需要按数据包围盒取景
    this.target.set(0, 0, 0)
    this.viewSize = 1250
    this.zoom = this.viewSize
    this.resize()
    this.setLayerVisibility(this.layerState)
  }

  /** 能量流虚线：从设施锚点竖直向上再折向标签，配色对应三类指标 */
  private buildEnergyLines(): void {
    const group = new THREE.Group()
    const colors: Record<LabelKey, string> = {
      gate: '#f8c34a',
      center: '#43e0ff',
      junction: '#4d8bff',
    }
    const heights: Record<LabelKey, number> = { gate: 190, center: 250, junction: 170 }
    const matrix = new THREE.Matrix4()

    for (const key of LABEL_KEYS) {
      const anchor = this.anchors[key]
      if (!anchor) continue
      const height = heights[key]
      // WebGL 的 Line 线宽恒为 1px：正交视图里能量流会细到看不见。
      // 用 InstancedMesh 画「实体虚线段」，每段 3m 宽，Bloom 才能给它一圈光晕。
      const dashes: THREE.Vector3[] = []
      for (let d = 8; d < height; d += 18) {
        dashes.push(new THREE.Vector3(anchor.x, anchor.y + d, anchor.z))
      }
      const direction = key === 'center' ? 1 : -1
      for (let d = 0; d < 90; d += 18) {
        dashes.push(new THREE.Vector3(anchor.x + direction * d, anchor.y + height, anchor.z))
      }

      const geometry = new THREE.BoxGeometry(3, 9, 3)
      const material = new THREE.MeshBasicMaterial({ color: colors[key], toneMapped: false })
      const mesh = new THREE.InstancedMesh(geometry, material, dashes.length)
      dashes.forEach((point, index) => {
        matrix.makeTranslation(point.x, point.y, point.z)
        mesh.setMatrixAt(index, matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.frustumCulled = false
      group.add(mesh)

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(5, 10, 8),
        new THREE.MeshBasicMaterial({ color: colors[key], toneMapped: false }),
      )
      dot.position.copy(anchor)
      group.add(dot)

      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(4, 10, 8),
        new THREE.MeshBasicMaterial({ color: colors[key], toneMapped: false }),
      )
      cap.position.set(anchor.x + direction * 90, anchor.y + height, anchor.z)
      group.add(cap)
    }

    this.energyLines = group
    this.scene.add(group)
  }

  /**
   * 图层开关与左侧面板共用一份状态：默认视图下也必须真的生效。
   * 用对象名分组，避免把岛缘/地台这类"背景骨架"一起隐藏。
   */
  setLayerVisibility(layers: Record<string, boolean>): void {
    this.layerState = { ...layers }
    const groups: Record<string, string[]> = {
      blocks: ['planning:island-buildings', 'planning:island-glass'],
      roads: [
        'planning:island-asphalt',
        'planning:island-curb',
        'planning:island-lane-lines',
        'planning:island-markings',
      ],
      checkpoints: [
        'planning:island-gantry-canopy',
        'planning:island-equipment',
        'planning:island-device-glow',
        'planning:island-signal-ns',
        'planning:island-signal-ew',
      ],
      zones: ['planning:island-zones'],
    }

    this.island?.children.forEach((child) => {
      const owner = Object.entries(groups).find(([, names]) => names.includes(child.name))
      if (owner) child.visible = layers[owner[0]] !== false
    })
    this.alarmBeacons?.children.forEach((child) => {
      child.visible = layers.alarms !== false
    })
    this.fleet.setVisible(layers.vehicles !== false)
  }

  /** 告警光柱：按真实告警所属卡口定位，WS 推送时整体替换（不重建整岛） */
  setAlarms(
    alarms: Array<{ checkpoint_id: string; level: string }>,
    positions: Map<string, [number, number]>,
  ): void {
    if (this.alarmBeacons) {
      const geometries = new Set<THREE.BufferGeometry>()
      const materials = new Set<THREE.Material>()
      this.alarmBeacons.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.geometry) geometries.add(mesh.geometry)
        const material = mesh.material as THREE.Material | undefined
        if (material) materials.add(material)
      })
      geometries.forEach((geometry) => geometry.dispose())
      materials.forEach((material) => material.dispose())
      this.scene.remove(this.alarmBeacons)
    }
    this.alarmBeacons = buildAlarmBeacons(alarms, positions)
    this.alarmBeacons.children.forEach((child) => {
      child.visible = this.layerState.alarms !== false
    })
    this.scene.add(this.alarmBeacons)
  }

  /** 标签内容由业务层传入（真实指标，不写死假数） */
  setLabels(labels: Partial<Record<LabelKey, EnergyLabel>>): void {
    for (const key of LABEL_KEYS) {
      const label = labels[key]
      const element = this.labelElements.get(key)!
      if (!label) {
        element.style.display = 'none'
        continue
      }
      element.style.display = ''
      element.innerHTML =
        `<span class="energy-label__title">${label.title}</span>` +
        `<span class="energy-label__value">${label.value}<small>${label.unit}</small></span>`
    }
  }

  /** 每帧把标签挂到虚线终点的屏幕投影上（正交相机投影是纯线性，成本可忽略） */
  private updateLabels(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    const heights: Record<LabelKey, number> = { gate: 190, center: 250, junction: 170 }

    for (const key of LABEL_KEYS) {
      const anchor = this.anchors[key]
      const element = this.labelElements.get(key)
      if (!anchor || !element || element.style.display === 'none') continue
      const point = anchor
        .clone()
        .setY(anchor.y + heights[key] + 30)
        .project(this.camera)
      const screenX = (point.x * 0.5 + 0.5) * width
      const screenY = (-point.y * 0.5 + 0.5) * height
      element.style.left = `${screenX}px`
      element.style.top = `${screenY}px`
      // 近景时锚点会移出视口：把卡片淡出，避免半截卡片挂在屏幕边缘
      element.style.opacity =
        screenX < 60 || screenX > width - 60 || screenY < 40 || screenY > height - 20 ? '0' : '1'
    }
  }

  /**
   * WS 只提供「有哪些车、跑多快、什么颜色/车型」；位置由路网车流驱动。
   * 这样车永远在车道上、朝向与行驶方向一致，且逐帧平滑推进。
   */
  updateVehicles(targets: VehicleTarget[]): void {
    this.latest = targets
    this.flow.sync(targets)
    if (this.visible) this.fleet.update(this.flow.snapshot())
  }

  /** 视角预设：全景看态势，路口近景看车型与设备细节（滚轮仍可自由缩放） */
  setPreset(preset: 'overview' | 'junction'): void {
    if (preset === 'junction') {
      this.target.set(-40, 0, 210)
      this.viewSize = 420
    } else {
      this.target.set(0, 0, 0)
      this.viewSize = 1250
    }
    this.zoom = this.viewSize
    this.resize()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      this.resize()
      this.fleet.update(this.flow.snapshot())
      this.lastFrameAt = 0
      this.start()
    } else {
      this.stop()
    }
  }

  private start(): void {
    if (this.frame) return
    const loop = (now: number): void => {
      this.frame = requestAnimationFrame(loop)
      const dt = this.lastFrameAt ? (now - this.lastFrameAt) / 1000 : 0.016
      this.lastFrameAt = now
      // 车流按信号相位与跟驰队列推进，再写一次实例矩阵
      this.flow.tick(dt)
      const phase = this.flow.signalPhase()
      if (this.signalMaterials) {
        this.signalMaterials.ns.color.set(phase.green === 'ns' ? '#22c55e' : '#ef4444')
        this.signalMaterials.ew.color.set(phase.green === 'ew' ? '#22c55e' : '#ef4444')
      }
      const placed = this.flow.snapshot()
      this.fleet.update(placed)
      // 仅开发模式暴露 3 辆车的坐标，供无头截图脚本验证车流确实在动
      if (import.meta.env.DEV) {
        ;(window as any).__planningFlow = placed
          .slice(0, 3)
          .map((vehicle) => [Math.round(vehicle.x), Math.round(vehicle.z)])
        ;(window as any).__planningSpacing = this.flow.debugSpacing()
        ;(window as any).__planningConflicts = this.flow.debugConflicts()
        ;(window as any).__planningStep = (seconds: number) => {
          this.flow.tick(seconds)
          return this.flow.debugConflicts()
        }
      }
      this.updateLabels()
      this.composer.render()
    }
    this.frame = requestAnimationFrame(loop)
  }

  private stop(): void {
    if (!this.frame) return
    cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  resize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (!width || !height) return

    this.renderer.setSize(width, height, false)
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.composer.setSize(width, height)

    const aspect = width / height
    const halfH = this.viewSize / 2
    const halfW = halfH * aspect
    this.camera.left = -halfW
    this.camera.right = halfW
    this.camera.top = halfH
    this.camera.bottom = -halfH
    this.camera.updateProjectionMatrix()
    this.applyView()
  }

  private applyView(): void {
    this.camera.position.copy(this.target).addScaledVector(CAMERA_DIR, 4200)
    this.camera.lookAt(this.target)
    this.camera.updateMatrixWorld()
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.dragging = true
    this.lastPointer = { x: event.clientX, y: event.clientY }
    this.canvas.setPointerCapture(event.pointerId)
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return
    const dx = event.clientX - this.lastPointer.x
    const dy = event.clientY - this.lastPointer.y
    this.lastPointer = { x: event.clientX, y: event.clientY }

    const worldPerPixel = this.viewSize / Math.max(this.container.clientHeight, 1)
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0)
    right.y = 0
    right.normalize()
    // 屏幕向下 = 视线在水平面上的投影方向
    const forward = new THREE.Vector3()
      .subVectors(this.target, this.camera.position)
      .setY(0)
      .normalize()

    this.target.addScaledVector(right, -dx * worldPerPixel)
    this.target.addScaledVector(forward, dy * worldPerPixel)
    this.applyView()
  }

  private onPointerUp = (): void => {
    this.dragging = false
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const next = THREE.MathUtils.clamp(this.viewSize * Math.exp(event.deltaY * 0.001), 180, 6400)
    this.viewSize = next
    this.zoom = next
    this.resize()
  }

  dispose(): void {
    this.stop()
    this.resizeObserver.disconnect()
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointerleave', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)

    this.fleet.dispose()
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((item) => item.dispose())
      else material?.dispose()
    })
    this.composer.dispose()
    this.renderer.dispose()
    this.canvas.remove()
    this.labelLayer.remove()
  }
}
