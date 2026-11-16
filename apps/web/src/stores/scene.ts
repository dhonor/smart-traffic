import * as Cesium from 'cesium'
import { defineStore } from 'pinia'
import { markRaw, ref, shallowRef } from 'vue'
import { SceneCoordinator } from '../engine/coordinator'

const CENTER: [number, number] = [114.0, 22.575]

/**
 * 场景 Store：**只存放引擎实例的引用**。
 *
 * 纪律（见架构文档 2.2）：
 *   Cesium 的 Viewer/Entity 内部有大量循环引用，放进 ref()/reactive() 会被 Vue 深度代理，
 *   导致不可排查的性能塌陷。这里一律 shallowRef + markRaw。
 *   业务状态（图层显隐、选中 id、告警列表）才进 Pinia 的 ref，并且只能通过命令式调用作用于引擎。
 */
export const useSceneStore = defineStore('scene', () => {
  const viewer = shallowRef<Cesium.Viewer | null>(null)
  const coordinator = shallowRef<SceneCoordinator | null>(null)
  const ready = ref(false)
  const mode = ref<'shared' | 'overlay'>('shared')

  async function mount(container: HTMLElement): Promise<void> {
    if (viewer.value) return

    const instance = new Cesium.Viewer(container, {
      baseLayer: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      baseLayerPicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: false,
      // 离线环境：不申请 ion token、不加载任何在线影像
      baseLayerPickerOptions: undefined,
    } as never)

    // 文字清晰度的关键：
    //   Cesium 默认 useBrowserRecommendedResolution=true，在 HiDPI 屏上按 CSS 像素渲染，
    //   标签是"画进纹理再拉伸"，1x 渲染再被系统放大 = 锯齿/发虚。
    //   关掉它并按 devicePixelRatio 提升分辨率，标签纹理与几何边缘一起变清晰。
    instance.useBrowserRecommendedResolution = false
    instance.resolutionScale = Math.min(window.devicePixelRatio || 1, 2)

    const scene = instance.scene
    scene.backgroundColor = Cesium.Color.fromCssColorString('#050a14')
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a1524')
    scene.globe.showGroundAtmosphere = false
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
    if (scene.skyBox) scene.skyBox.show = false
    scene.fog.enabled = false

    // 不开 bloom：
    //   实测多趟全屏后处理在集显/软件渲染下帧率断崖（无头截图直接超时），
    //   而路网与车辆本身就是加性发光材质，已足够出"夜景"观感。
    scene.postProcessStages.bloom.enabled = false

    // 关掉 FXAA：启用后处理时 Cesium 会先渲染到离屏 FBO 再 blit 到画布，
    // 共享上下文里 Three 拿到的默认帧缓冲深度信息就不完整了（实测锥体不可见）
    scene.postProcessStages.fxaa.enabled = false
    instance.cesiumWidget.creditContainer.parentElement?.removeChild(
      instance.cesiumWidget.creditContainer,
    )

    focusPark(instance)

    const params = new URLSearchParams(location.search)
    const requested =
      (params.get('render') as 'shared' | 'overlay' | null) ??
      (import.meta.env.VITE_RENDER_MODE as 'shared' | 'overlay' | undefined) ??
      'shared'

    const coordinatorInstance = new SceneCoordinator(instance, { mode: requested, center: CENTER })

    viewer.value = markRaw(instance)
    coordinator.value = markRaw(coordinatorInstance)
    mode.value = coordinatorInstance.mode
    ready.value = true
  }

  /**
   * 调试/演示深链：`?cam=lng,lat,range[,heading[,pitch]]`
   * 便于把镜头固定到某个路口做近景检查（车辆光条、卡口、路况配色）。
   */
  function camOverride(): { lng: number; lat: number; range: number; heading: number; pitch: number } | null {
    const raw = new URLSearchParams(location.search).get('cam')
    if (!raw) return null
    const parts = raw.split(',').map(Number)
    if (parts.length < 3 || parts.slice(0, 3).some((v) => !Number.isFinite(v))) return null
    return {
      lng: parts[0],
      lat: parts[1],
      range: parts[2],
      heading: Number.isFinite(parts[3]) ? parts[3] : 18,
      pitch: Number.isFinite(parts[4]) ? parts[4] : -50,
    }
  }

  function focusPark(instance: Cesium.Viewer): void {
    const cam = camOverride()
    const target = Cesium.Cartesian3.fromDegrees(cam?.lng ?? CENTER[0], cam?.lat ?? CENTER[1], 0)
    // 10km 见方的路网：3.4km 视距 + 52° 俯角，既能看清车辆（约 8px），又能覆盖主要路口
    const range = cam?.range ?? 4000
    const pitch = Cesium.Math.toRadians(cam?.pitch ?? -50)
    const heading = Cesium.Math.toRadians(cam?.heading ?? 18)
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(target)
    // pitch 为负（向下俯视）时，高度分量必须是 -range*sin(pitch) 才为正；
    // 写成 +range*sin(pitch) 会把相机压到地面以下（表现为 camHeight≈1、场景全黑）
    const offset = new Cesium.Cartesian3(
      -range * Math.cos(pitch) * Math.sin(heading),
      -range * Math.cos(pitch) * Math.cos(heading),
      -range * Math.sin(pitch),
    )
    const destination = Cesium.Matrix4.multiplyByPoint(enu, offset, new Cesium.Cartesian3())
    instance.camera.setView({ destination, orientation: { heading, pitch, roll: 0 } })
  }

  function dispose(): void {
    coordinator.value?.dispose()
    viewer.value?.destroy()
    coordinator.value = null
    viewer.value = null
    ready.value = false
  }

  return { viewer, coordinator, ready, mode, mount, dispose }
})
