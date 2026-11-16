import * as THREE from 'three'
import type { SceneCoordinator } from './coordinator'

interface Beacon {
  mesh: THREE.Mesh
  bornAt: number
  basePosition: THREE.Vector3
}

/**
 * 告警光柱（Three.js 的典型局部特效）。
 *
 * 这类「与 GIS 数据无关、但要贴着地理坐标发光」的效果正是 Three 该做的事：
 * 共享 Cesium 的深度与相机，光柱会被建筑正确遮挡。
 */
export class BeaconLayer {
  private readonly group = new THREE.Group()
  private readonly beacons: Beacon[] = []
  private readonly max = 24

  constructor(private readonly coordinator: SceneCoordinator) {
    coordinator.threeScene.add(this.group)
    coordinator.onBeforeRender(() => this.animate())
  }

  add(lng: number, lat: number, level: string, height = 220): void {
    const color = level === 'critical' ? '#ef4444' : level === 'warning' ? '#f59e0b' : '#38bdf8'
    const geometry = new THREE.CylinderGeometry(9, 16, height, 12, 1, true)
    geometry.translate(0, height / 2, 0)

    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // 与车辆同理：Cesium 的深度精度不足以在同一条管线里做遮挡判定
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.copy(this.coordinator.toLocalEcef(lng, lat, 4))

    // 定向：把圆柱的 +Y 轴对齐到该点的 ENU up
    const { east, north, up } = this.coordinator.enuBasis(lng, lat)
    const right = new THREE.Vector3().copy(north).cross(up).normalize()
    const matrix = new THREE.Matrix4().makeBasis(right, up, new THREE.Vector3().copy(right).cross(up))
    mesh.quaternion.setFromRotationMatrix(matrix)

    this.group.add(mesh)
    this.beacons.push({ mesh, bornAt: performance.now(), basePosition: mesh.position.clone() })

    while (this.beacons.length > this.max) {
      const oldest = this.beacons.shift()!
      this.group.remove(oldest.mesh)
      oldest.mesh.geometry.dispose()
      ;(oldest.mesh.material as THREE.Material).dispose()
    }
  }

  /** 呼吸 + 轻微上浮：让它像「事件」而不是静态广告牌 */
  private animate(): void {
    const now = performance.now()
    for (const beacon of this.beacons) {
      const age = (now - beacon.bornAt) / 1000
      const pulse = 0.35 + 0.3 * Math.sin(age * 4)
      const material = beacon.mesh.material as THREE.MeshBasicMaterial
      material.opacity = Math.max(0.06, 0.5 - age * 0.01) * (0.6 + pulse)
      beacon.mesh.scale.setScalar(1 + 0.06 * Math.sin(age * 3))
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  clear(): void {
    for (const beacon of this.beacons) {
      this.group.remove(beacon.mesh)
      beacon.mesh.geometry.dispose()
      ;(beacon.mesh.material as THREE.Material).dispose()
    }
    this.beacons.length = 0
  }
}
