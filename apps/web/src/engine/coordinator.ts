import * as Cesium from 'cesium'
import * as THREE from 'three'

export type RenderMode = 'shared' | 'overlay'

export interface CoordinatorOptions {
  /** shared: 与 Cesium 共享 WebGL 上下文（首选）；overlay: 独立画布兜底 */
  mode?: RenderMode
  center: [number, number]
}

/**
 * Cesium + Three.js 渲染协调器。
 *
 * 为什么必须集中在一个类里：
 *   双引擎的坑全在「上下文 / 深度 / 相机矩阵」三处，散落到业务组件里必然失控。
 *   业务层只允许通过 `addLayer / removeLayer` 注册 Three 对象，不直接碰 renderer。
 *
 * 共享上下文的三个必要动作（缺一即黑屏或闪烁）：
 *   1. 从 Cesium 的 `scene.context._gl` 取原生上下文交给 Three；
 *   2. 关闭 Three 的 autoClear / autoClearDepth / autoClearColor（否则会擦掉地球）；
 *   3. 相机矩阵每帧从 Cesium 同步，且**必须取同一帧**（在 postRender 里读）。
 */
export class SceneCoordinator {
  readonly viewer: Cesium.Viewer
  readonly threeScene = new THREE.Scene()
  readonly threeCamera = new THREE.PerspectiveCamera()
  readonly mode: RenderMode
  private renderer: THREE.WebGLRenderer
  private overlayCanvas: HTMLCanvasElement | null = null
  private readonly originEcef: Cesium.Cartesian3
  private readonly beforeRender: Array<() => void> = []

  constructor(viewer: Cesium.Viewer, options: CoordinatorOptions) {
    this.viewer = viewer
    this.originEcef = Cesium.Cartesian3.fromDegrees(options.center[0], options.center[1], 0)

    const scene = viewer.scene
    const gl = (scene as any).context?._gl as WebGL2RenderingContext | WebGLRenderingContext | undefined

    if (options.mode !== 'overlay' && gl) {
      this.mode = 'shared'
      this.renderer = new THREE.WebGLRenderer({
        canvas: viewer.canvas,
        context: gl,
        antialias: true,
        alpha: true,
      })
    } else {
      this.mode = 'overlay'
      const canvas = document.createElement('canvas')
      canvas.className = 'three-overlay'
      canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:2'
      viewer.canvas.parentElement?.appendChild(canvas)
      this.overlayCanvas = canvas
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    }

    // 关键：绝不能擦除 Cesium 已经画好的地球
    this.renderer.autoClear = false
    this.renderer.autoClearColor = false
    this.renderer.autoClearDepth = false
    this.renderer.autoClearStencil = false
    this.renderer.setPixelRatio(1)

    this.threeCamera.matrixAutoUpdate = false
    this.syncSize()

    scene.postRender.addEventListener(this.onPostRender)
    window.addEventListener('resize', this.syncSize)
  }

  /** 相机离地高度（米）：图层用它把世界尺寸换算成"屏幕上大致恒定的大小" */
  get cameraHeight(): number {
    return this.viewer.camera.positionCartographic.height
  }

  /** 把局部 ECEF 点投影到 NDC（诊断用：-1..1 之内才是可见范围） */
  projectToNdc(point: THREE.Vector3): { x: number; y: number; z: number } {
    const ndc = point.clone().applyMatrix4(this.threeCamera.matrixWorldInverse)
    ndc.applyMatrix4(this.threeCamera.projectionMatrix)
    return {
      x: Math.round(ndc.x * 1000) / 1000,
      y: Math.round(ndc.y * 1000) / 1000,
      z: Math.round(ndc.z * 1000) / 1000,
    }
  }

  /** 诊断用：Three 这一帧到底画了多少东西 */
  debugStats(): Record<string, unknown> {
    const gl = this.renderer.getContext()
    const cameraWorld = new THREE.Vector3()
    this.threeCamera.getWorldPosition(cameraWorld)
    return {
      mode: this.mode,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      contextLost: gl.isContextLost(),
      children: this.threeScene.children.length,
      cameraLocal: [
        Math.round(cameraWorld.x),
        Math.round(cameraWorld.y),
        Math.round(cameraWorld.z),
      ],
    }
  }

  get canvasSize(): { width: number; height: number } {
    const source = this.mode === 'shared' ? this.viewer.canvas : this.overlayCanvas!
    return { width: source.width, height: source.height }
  }

  /** 注册「每帧渲染前」的回调：图层在这里更新实例矩阵，不参与 Vue 响应式 */
  onBeforeRender(callback: () => void): () => void {
    this.beforeRender.push(callback)
    return () => {
      const index = this.beforeRender.indexOf(callback)
      if (index >= 0) this.beforeRender.splice(index, 1)
    }
  }

  private syncSize = (): void => {
    const { width, height } = this.canvasSize
    if (width === 0 || height === 0) return
    this.renderer.setSize(width, height, false)
    if (this.overlayCanvas) {
      this.overlayCanvas.width = width
      this.overlayCanvas.height = height
      this.overlayCanvas.style.width = `${width / (window.devicePixelRatio || 1)}px`
      this.overlayCanvas.style.height = `${height / (window.devicePixelRatio || 1)}px`
      this.renderer.setSize(width, height, false)
    }
  }

  private onPostRender = (): void => {
    for (const callback of this.beforeRender) callback()
    this.syncCamera()

    if (this.mode === 'overlay') {
      this.renderer.clear(true, true, true)
    } else {
      // Three 会改写 GL 状态；渲染前重置，渲染后交给 Cesium 自己重新设置
      this.renderer.resetState()
      // 关键：Cesium 在 postRender 时可能还绑着离屏 FBO（后处理/拾取）。
      // 不显式切回默认帧缓冲，Three 的绘制会落在离屏 target 上，屏幕永远看不到。
      this.renderer.setRenderTarget(null)
      const { width, height } = this.canvasSize
      this.renderer.setViewport(0, 0, width, height)
      this.renderer.setScissorTest(false)
    }
    this.renderer.render(this.threeScene, this.threeCamera)
    if (this.mode === 'shared') this.renderer.resetState()
  }

  /**
   * 相机矩阵同步。
   *
   * 精度处理：ECEF 坐标量级 6.4e6，直接塞进 float32 会丢厘米级精度（物体抖动）。
   * 因此把「视图矩阵 × 平移到局部原点」在 JS 双精度里先乘好，再上传。
   */
  private syncCamera(): void {
    const camera = this.viewer.camera
    const view = camera.viewMatrix
    const projection = camera.frustum.projectionMatrix

    const viewThree = new THREE.Matrix4().fromArray(Cesium.Matrix4.toArray(view) as number[])
    // 局部坐标系 = 世界坐标减去原点：V' = V ∘ T(+origin)。
    // 写成 T(-origin) 会让相机落到 2×origin 的位置（实测 cameraLocal ≈ 1e7），
    // 表现就是「Three 有 drawCall 但画面什么都没有」。
    const toLocal = new THREE.Matrix4().makeTranslation(
      this.originEcef.x,
      this.originEcef.y,
      this.originEcef.z,
    )
    const viewLocal = viewThree.multiply(toLocal)

    this.threeCamera.projectionMatrix.fromArray(Cesium.Matrix4.toArray(projection) as number[])
    this.threeCamera.projectionMatrixInverse.copy(this.threeCamera.projectionMatrix).invert()
    this.threeCamera.matrixWorldInverse.copy(viewLocal)
    this.threeCamera.matrixWorld.copy(viewLocal).invert()
    this.threeCamera.matrixWorldAutoUpdate = false
  }

  /** 经纬度 → 局部 ECEF（减去原点，保证 float32 精度） */
  toLocalEcef(lng: number, lat: number, height = 0): THREE.Vector3 {
    const ecef = Cesium.Cartesian3.fromDegrees(lng, lat, height)
    return new THREE.Vector3(
      ecef.x - this.originEcef.x,
      ecef.y - this.originEcef.y,
      ecef.z - this.originEcef.z,
    )
  }

  /** 该点的 ENU 基向量（ECEF 下表示），用于给实例定姿态 */
  enuBasis(lng: number, lat: number): { east: THREE.Vector3; north: THREE.Vector3; up: THREE.Vector3 } {
    const lon = Cesium.Math.toRadians(lng)
    const phi = Cesium.Math.toRadians(lat)
    const sinLon = Math.sin(lon)
    const cosLon = Math.cos(lon)
    const sinPhi = Math.sin(phi)
    const cosPhi = Math.cos(phi)
    return {
      east: new THREE.Vector3(-sinLon, cosLon, 0),
      north: new THREE.Vector3(-sinPhi * cosLon, -sinPhi * sinLon, cosPhi),
      up: new THREE.Vector3(cosPhi * cosLon, cosPhi * sinLon, sinPhi),
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.syncSize)
    this.viewer.scene.postRender.removeEventListener(this.onPostRender)
    this.renderer.dispose()
    this.overlayCanvas?.remove()
  }
}
