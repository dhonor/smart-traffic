import * as THREE from 'three'
import type { VehicleTarget } from '@traffic/shared-types'
import type { SceneCoordinator } from './coordinator'

/**
 * 车辆实例化图层。
 *
 * 为什么不用 Cesium Entity：千级目标下逐条 Entity 的 Property 求值与 Draw Call 会直接压垮帧率。
 * 这里用 InstancedMesh —— 所有车辆共享一份几何，一次 Draw Call；
 * 每个实例只写 4x4 矩阵与颜色，位置在**数据到达时**算一次，不参与逐帧计算。
 */
export class VehicleLayer {
  readonly mesh: THREE.InstancedMesh
  private readonly max = 2000
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly up = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()
  private readonly color = new THREE.Color()

  constructor(private readonly coordinator: SceneCoordinator) {
    // 车辆做成「贴地光条」而不是锥体：
    //   夜视风格下，锥体像撒了一地路障；沿航向拉长的光条才读得出"车流在动"，
    //   而且 additive 混合会自然叠出车流密度（拥堵路段更亮）。
    //   depth 沿 +Z：与下面 makeBasis(right, up, forward) 的前向一致。
    // 拖尾别拉太长: 加性混合是「过绘制」，长度直接乘以屏幕覆盖面积。
    // 实测 84m 长条 + 1000 辆在软件渲染下会卡死，64~72m 是这台的可用上限。
    const geometry = new THREE.BoxGeometry(12, 0.7, 72)
    geometry.translate(0, 0, 15) // 让车头在前、拖尾在后

    // 头亮尾暗的顶点色：没有贴图也能一眼读出"往哪开"。
    // 最终颜色 = instanceColor（车辆色） × 顶点色（方向渐变），乘算不会互相覆盖。
    const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute
    const ramp = new Float32Array(positionAttr.count * 3)
    for (let i = 0; i < positionAttr.count; i += 1) {
      const z = positionAttr.getZ(i)
      const t = THREE.MathUtils.clamp((z + 21) / 72, 0, 1) // 0=尾 1=头
      const value = 0.28 + 0.72 * t
      ramp[i * 3] = value
      ramp[i * 3 + 1] = value
      ramp[i * 3 + 2] = value
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(ramp, 3))

    // 关掉深度测试：
    //   Cesium 的投影 near/far 跨度极大（远平面 5e8），共享上下文里 Three 算出的 z
    //   会被压到 1.0，与 Cesium 的深度值相同 → `depthTest` 一律判失败，物体整体不可见。
    //   车辆/光柱这类「必须看得见」的目标本就不该被地形遮挡，关掉是正确取舍。
    //   需要真实遮挡时，正确做法是开启 Cesium 的 logarithmicDepthBuffer 并同步到 Three 的着色器。
    const material = new THREE.MeshBasicMaterial({
      toneMapped: false,
      // 顶点色承载方向渐变，instanceColor 承载车辆配色
      vertexColors: true,
      transparent: true,
      // 不用加性混合: 全景视角下几百条长光条铺满屏幕，过绘制会把集显/软件渲染拖死。
      // 材质本身是 unlit（不受光），普通混合已经足够"自发光"的观感。
      opacity: 0.95,
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false,
    })

    this.mesh = new THREE.InstancedMesh(geometry, material, this.max)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    coordinator.threeScene.add(this.mesh)
  }

  /** 数据驱动：WS 每次推送车辆位置时调用一次 */
  update(targets: VehicleTarget[]): void {
    const count = Math.min(targets.length, this.max)
    this.mesh.count = count

    // 光条是世界尺寸：不随视距缩放的话，5km 高空看是细线、1km 近景就是巨型胶囊。
    // 按相机高度归一，让它在屏幕上保持大致恒定的可读大小。
    const scale = THREE.MathUtils.clamp(this.coordinator.cameraHeight / 3000, 0.6, 1)

    for (let i = 0; i < count; i += 1) {
      const target = targets[i]
      const { east, north, up } = this.coordinator.enuBasis(target.lng, target.lat)
      const heading = (target.heading * Math.PI) / 180

      this.forward.copy(north).multiplyScalar(Math.cos(heading)).addScaledVector(east, Math.sin(heading))
      this.right.copy(this.forward).cross(up).normalize()
      this.up.copy(this.right).cross(this.forward).normalize()

      this.matrix.makeBasis(this.right, this.up, this.forward)
      // 贴地 3m：光条要"压"在路面上，抬高会变成悬空的棍子
      this.position.copy(this.coordinator.toLocalEcef(target.lng, target.lat, 3))
      // 车道横向偏移：所有车都压在同一条中线上时会糊成一根粗线，
      // 按车辆 id 稳定散到 3 条车道上，来回方向也就分得开了。
      const laneSeed = Number(target.vehicle_id.replace(/\D/g, '')) % 3
      this.position.addScaledVector(this.right, (laneSeed - 1) * 11)
      // 只拉长不放大：速度越快拖尾越长，静止/拥堵时收缩成短光点
      const stretch = 0.55 + Math.min(target.speed_kph, 120) / 120
      // 宽度不跟着缩：缩了在 3km 以上就细到看不见；只按视距收长度
      this.matrix.scale(new THREE.Vector3(1, 1, stretch * scale))
      this.matrix.setPosition(this.position)
      this.mesh.setMatrixAt(i, this.matrix)

      // 拥堵车辆偏红、畅通偏青，颜色本身也是信息
      const jam = target.speed_kph < 25
      this.color.set(jam ? '#ff6b6b' : target.color || '#3fa9f5')
      this.mesh.setColorAt(i, this.color)
    }

    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  /** 诊断用：首个实例的屏幕投影位置 + 视锥内实例数 */
  sampleNdc(): { x: number; y: number; z: number; inView: number; count: number } | null {
    if (!this.mesh.count) return null
    const array = this.mesh.instanceMatrix.array as Float32Array
    const position = new THREE.Vector3(array[12], array[13], array[14])
    const ndc = this.coordinator.projectToNdc(position)

    let inView = 0
    for (let i = 0; i < this.mesh.count; i += 1) {
      const p = new THREE.Vector3(array[i * 16 + 12], array[i * 16 + 13], array[i * 16 + 14])
      const n = this.coordinator.projectToNdc(p)
      if (Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1 && n.z >= -1 && n.z <= 1) inView += 1
    }
    return { ...ndc, inView, count: this.mesh.count }
  }

  setVisible(visible: boolean): void {
    this.mesh.visible = visible
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.coordinator.threeScene.remove(this.mesh)
  }
}
