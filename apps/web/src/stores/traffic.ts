import { defineStore } from 'pinia'
import { reactive, ref, shallowRef } from 'vue'
import type {
  AlarmEvent,
  OverviewKpi,
  RoadProps,
  SurveillanceRule,
  FeatureCollection,
} from '@traffic/shared-types'
import type { WsState } from '../api/ws'

export interface SelectedTarget {
  kind: 'checkpoint' | 'alarm'
  id: string
  data: any
}

export const useTrafficStore = defineStore('traffic', () => {
  /** 路网是"海量渲染数据"：shallowRef 存，更新时整体替换，不做深响应 */
  const roads = shallowRef<FeatureCollection<RoadProps, any> | null>(null)
  const roadCount = ref(0)
  const vehicleCount = ref(0)
  const checkpointCount = ref(0)

  const alarms = ref<AlarmEvent[]>([])
  const alarmCounts = ref<Record<string, number>>({ critical: 0, warning: 0, info: 0 })
  const kpi = ref<OverviewKpi[]>([])
  /** 布控规则（内存副本，与后端 Redis 副本经 Pub/Sub 同步） */
  const rules = ref<SurveillanceRule[]>([])

  const wsState = ref<WsState>('connecting')
  const ingestMode = ref<'kafka-dual-group' | 'direct'>('direct')
  const deps = ref<Record<string, string>>({})

  const layers = reactive({
    blocks: true,
    vehicles: true,
    roads: true,
    checkpoints: true,
    alarms: true,
  })

  const selected = ref<SelectedTarget | null>(null)
  const playbackPlate = ref<string | null>(null)
  const error = ref<string | null>(null)

  function pushAlarm(alarm: AlarmEvent): void {
    // WS 实时事件没有 acked 字段：新告警一律未确认
    alarms.value = [{ ...alarm, acked_at: alarm.acked_at ?? null }, ...alarms.value].slice(0, 60)
    alarmCounts.value = {
      ...alarmCounts.value,
      [alarm.level]: (alarmCounts.value[alarm.level] ?? 0) + 1,
    }
  }

  /** 告警确认后同步本地状态：打标记 + 重算未确认计数 */
  function markAcked(id: string, ackedAt: string): void {
    alarms.value = alarms.value.map((item) =>
      item.id === id ? { ...item, acked_at: ackedAt } : item,
    )
  }

  function replaceAlarms(items: AlarmEvent[], counts: Record<string, number>): void {
    alarms.value = items
    alarmCounts.value = { ...{ critical: 0, warning: 0, info: 0 }, ...counts }
  }

  return {
    roads,
    roadCount,
    vehicleCount,
    checkpointCount,
    alarms,
    alarmCounts,
    kpi,
    rules,
    wsState,
    ingestMode,
    deps,
    layers,
    selected,
    playbackPlate,
    error,
    pushAlarm,
    markAcked,
    replaceAlarms,
  }
})
