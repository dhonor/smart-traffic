import * as Cesium from 'cesium'
import type { CheckpointProps, FeatureCollection, RoadProps } from '@traffic/shared-types'
import type { SceneCoordinator } from './coordinator'

export const CONGESTION_COLOR: Record<string, string> = {
  free: '#22c55e',
  slow: '#f59e0b',
  jam: '#ef4444',
}

/**
 * 路网图层（Cesium）。
 *
 * 只有 10 段路时用 Entity 足够；到千级路段时要换成自定义 Primitive +
 * 逐顶点颜色属性（GPU 上色），否则每帧重建几何会拖垮渲染。
 */
export class RoadLayer {
  private readonly entities = new Map<string, Cesium.Entity>()

  constructor(private readonly viewer: Cesium.Viewer) {}

  setRoads(collection: FeatureCollection<RoadProps, any>): void {
    for (const feature of collection.features) {
      const props = feature.properties
      const positions = Cesium.Cartesian3.fromDegreesArray(
        (feature.geometry.coordinates as number[][]).flatMap(([lng, lat]) => [lng, lat]),
      )
      const color = Cesium.Color.fromCssColorString(CONGESTION_COLOR[props.congestion] ?? '#22c55e')
      const existing = this.entities.get(props.id)
      if (existing) {
        existing.polyline!.material = new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.12,
          color,
        })
        continue
      }

      // 先画一条更宽的暗色"路基"，再叠发光路面：
      // 只画一条发光细线时，路是浮在黑色背景上的，加上路基才有"道路"的实体感。
      this.viewer.entities.add({
        id: `road-casing:${props.id}`,
        polyline: {
          positions,
          width: 13,
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.PolylineOutlineMaterialProperty({
            color: Cesium.Color.fromCssColorString('#0a1a2b').withAlpha(0.95),
            outlineWidth: 0,
          }),
        },
      })

      this.entities.set(
        props.id,
        this.viewer.entities.add({
          id: `road:${props.id}`,
          polyline: {
            positions,
            width: 6,
            arcType: Cesium.ArcType.NONE,
            material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.12, color }),
            clampToGround: false,
          },
          properties: { kind: 'road', ...props },
        }),
      )
    }
  }

  /** 路况只改材质颜色，不重建几何 */
  updateStatus(patches: Array<{ id: string; congestion: string }>): void {
    for (const patch of patches) {
      const entity = this.entities.get(patch.id)
      if (!entity?.polyline) continue
      entity.polyline.material = new Cesium.PolylineGlowMaterialProperty({
        glowPower: 0.18,
        color: Cesium.Color.fromCssColorString(CONGESTION_COLOR[patch.congestion] ?? '#22c55e'),
      })
    }
  }

  setVisible(visible: boolean): void {
    for (const entity of this.entities.values()) entity.show = visible
  }
}

/** 卡口点位：25 个实体，带标签与点击 */
export class CheckpointLayer {
  private readonly entities = new Map<string, Cesium.Entity>()

  constructor(private readonly viewer: Cesium.Viewer) {}

  setCheckpoints(collection: FeatureCollection<CheckpointProps, any>): void {
    for (const feature of collection.features) {
      const props = feature.properties
      const [lng, lat] = feature.geometry.coordinates as [number, number]
      const color =
        props.status === 'online' ? '#38bdf8' : props.status === 'fault' ? '#f97316' : '#64748b'

      this.entities.set(
        props.id,
        this.viewer.entities.add({
          id: `cp:${props.id}`,
          position: Cesium.Cartesian3.fromDegrees(lng, lat, 6),
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString(color),
            outlineColor: Cesium.Color.fromCssColorString('#020617').withAlpha(0.9),
            outlineWidth: 1.5,
            disableDepthTestDistance: 2_000_000,
          },
          label: {
            text: props.name,
            // 字号略大 + 深色描边: 字是画进纹理再贴的，纯填充在深色底上边缘会"咬"
            font: '600 13px "Microsoft YaHei", "PingFang SC", sans-serif',
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            fillColor: Cesium.Color.fromCssColorString('#eaf4ff'),
            outlineColor: Cesium.Color.fromCssColorString('#04121f'),
            outlineWidth: 3,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0b1220').withAlpha(0.66),
            backgroundPadding: new Cesium.Cartesian2(7, 4),
            pixelOffset: new Cesium.Cartesian2(0, -11),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8000),
            disableDepthTestDistance: 2_000_000,
          },
        }),
      )
    }
  }

  setVisible(visible: boolean): void {
    for (const entity of this.entities.values()) entity.show = visible
  }
}

/**
 * 城市背景体块（示意数据）。
 *
 * 只有路网的画面会像"黑底上的几根线"，加一层低饱和体块做空间参照，
 * 路网与车流才有承接面。颜色刻意压暗，保证道路仍是视觉主体。
 */
export class BlockLayer {
  private readonly entities: Cesium.Entity[] = []

  constructor(private readonly viewer: Cesium.Viewer) {}

  setBlocks(collection: { features: Array<{ id?: string; geometry: any; properties: any }> }): void {
    for (const feature of collection.features) {
      const rings = (feature.geometry.coordinates as number[][][])[0]
      const height = Number(feature.properties?.height ?? 20)
      const hierarchy = new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(rings.flatMap(([lng, lat]) => [lng, lat])),
      )
      // 高度越高屋顶越亮：没有光照系统时，这是唯一能读出体量差异的手段
      const lift = Math.min(0.06 + height / 500, 0.22)
      const top = Cesium.Color.fromCssColorString('#122a44').brighten(lift, new Cesium.Color())

      this.entities.push(
        this.viewer.entities.add({
          id: `block:${feature.id}`,
          polygon: {
            hierarchy,
            height: 0,
            extrudedHeight: height,
            // 侧面压暗，让顶面（下面那层）成为受光面
            material: Cesium.Color.fromCssColorString('#0d1e31'),
            outline: true,
            outlineColor: Cesium.Color.fromCssColorString('#24486b').withAlpha(0.5),
            outlineWidth: 1,
          },
        }),
        this.viewer.entities.add({
          id: `block-top:${feature.id}`,
          polygon: {
            hierarchy,
            height: height + 0.6,
            material: top,
          },
        }),
      )
    }
  }

  setVisible(visible: boolean): void {
    for (const entity of this.entities) entity.show = visible
  }
}

/** 布控区：半透明面 + 虚线边界，作为空间参照 */
export class ZoneLayer {
  constructor(private readonly viewer: Cesium.Viewer) {}

  setZones(collection: { features: Array<{ id?: string; geometry: any; properties: any }> }): void {
    for (const feature of collection.features) {
      const rings = (feature.geometry.coordinates as number[][][])[0]
      this.viewer.entities.add({
        id: `zone:${feature.id}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(rings.flatMap(([lng, lat]) => [lng, lat])),
          ),
          height: 1,
          // 只留轮廓: 大面积半透明填充会把路网压暗, 布控区只需要"圈出来"
          material: Cesium.Color.TRANSPARENT,
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#c084fc').withAlpha(0.55),
          outlineWidth: 2,
        },
        label: {
          text: feature.properties.name,
          font: '600 13px "Microsoft YaHei", "PingFang SC", sans-serif',
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: Cesium.Color.fromCssColorString('#e9d5ff'),
          outlineColor: Cesium.Color.fromCssColorString('#1a0b2e'),
          outlineWidth: 3,
          showBackground: false,
          pixelOffset: new Cesium.Cartesian2(0, 0),
          disableDepthTestDistance: 2_000_000,
        },
      })
    }
  }
}

/** 轨迹回放：一条折线 + 一个移动点，独立于实时图层 */
export class TrajectoryLayer {
  private entity: Cesium.Entity | null = null

  constructor(private readonly viewer: Cesium.Viewer) {}

  show(coordinates: number[][], plate: string): void {
    this.clear()
    this.entity = this.viewer.entities.add({
      id: 'trajectory:playback',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(coordinates.flatMap(([lng, lat]) => [lng, lat])),
        width: 4,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.25,
          color: Cesium.Color.fromCssColorString('#a855f7'),
        }),
      },
      properties: { kind: 'trajectory', plate },
    })
  }

  clear(): void {
    if (this.entity) {
      this.viewer.entities.remove(this.entity)
      this.entity = null
    }
  }
}

export type { SceneCoordinator }
