<template>
  <div class="app">
    <div ref="containerRef" class="viewport"></div>
    <div ref="planningRef" v-show="planningActive" class="planning-layer"></div>

    <header class="topbar">
      <div class="brand">
        <span class="brand-mark"></span>
        <div>
          <strong>智慧交通检测平台</strong>
          <small>SMART TRAFFIC INSPECTION · DIGITAL TWIN</small>
        </div>
      </div>

      <div class="topbar-center">
        <span class="badge" :class="ingestClass"><i></i>{{ ingestText }}</span>
        <span class="badge" :class="wsClass"><i></i>{{ wsText }}</span>
        <span class="badge"><i></i>渲染 {{ planningActive ? '园区轴测' : scene.mode }}</span>
        <span v-if="depWarn" class="badge is-off" :title="depWarn"><i></i>{{ depWarn }}</span>
        <span class="badge">{{ clock }}</span>
      </div>

      <button class="mode-toggle" :class="{ 'is-on': planningActive }" @click="togglePlanning">
        {{ planningActive ? '切回孪生' : '园区视图' }}
      </button>
      <button class="mode-toggle" @click="togglePreset">
        {{ planningPreset === 'overview' ? '路口近景' : '返回全景' }}
      </button>
      <span class="badge">卡口 {{ traffic.checkpointCount }} · 车辆 {{ traffic.vehicleCount }}</span>
      <span class="badge" :class="{ 'is-warn': !isAdmin }" :title="isAdmin ? '管理员：可写操作' : '只读账号：不可执行写操作'">
        {{ authUser?.name }} · {{ isAdmin ? '管理员' : '只读' }}
      </span>
      <button class="btn-logout" @click="logout">退出</button>
    </header>

    <aside class="panel panel-left">
      <div class="panel-title"><b>图层</b><span>LAYERS</span></div>
      <div class="section">
        <div v-for="item in layerItems" :key="item.key" class="row">
          <span>{{ item.label }}</span>
          <button
            class="switch"
            :class="{ 'is-on': traffic.layers[item.key] }"
            :aria-pressed="traffic.layers[item.key]"
            @click="toggleLayer(item.key)"
          ></button>
        </div>
      </div>

      <div class="panel-title"><b>演示</b><span>DEMO</span></div>
      <div class="section">
        <button class="btn" @click="simulate">模拟 20 辆过车</button>
        <button class="btn is-ghost" @click="playback">最近轨迹回放</button>
      </div>

      <div class="panel-title">
        <b>布控规则</b>
        <span>{{ traffic.rules.filter((r) => r.active).length }}/{{ traffic.rules.length }} 生效</span>
      </div>
      <div class="section rule-list">
        <div v-for="rule in traffic.rules" :key="rule.id" class="rule-row">
          <div class="rule-info">
            <span :title="rule.name">{{ rule.name }}</span>
            <small>{{ ruleDesc(rule) }}</small>
          </div>
          <div class="rule-actions">
            <template v-if="isAdmin">
              <button
                class="switch"
                :class="{ 'is-on': rule.active }"
                :aria-pressed="rule.active"
                :title="rule.active ? '停用' : '启用'"
                @click="toggleRule(rule)"
              ></button>
              <button class="btn-del" title="删除规则" @click="removeRule(rule)">✕</button>
            </template>
            <span v-else class="hint">只读</span>
          </div>
        </div>
        <p v-if="!traffic.rules.length" class="hint">暂无规则</p>
      </div>
      <form v-if="isAdmin" class="section rule-form" @submit.prevent="addRule">
        <input v-model="ruleForm.name" placeholder="规则名称" required />
        <div class="rule-form-grid">
          <select v-model="ruleForm.kind">
            <option value="speeding">超速/低速</option>
            <option value="blacklist">车牌布控</option>
          </select>
          <input
            v-if="ruleForm.kind === 'speeding'"
            v-model.number="ruleForm.speed_threshold"
            type="number"
            min="0"
            placeholder="阈值 km/h"
            required
          />
          <input v-else v-model="ruleForm.plate_pattern" placeholder="车牌前缀，如 粤B9" required />
        </div>
        <button class="btn" type="submit" :disabled="ruleBusy">{{ ruleBusy ? '保存中…' : '新增规则' }}</button>
      </form>

      <p class="hint">
        车辆 {{ traffic.vehicleCount }} 个实例 · 1 次 DrawCall<br />
        路况由 Kafka 落库通道聚合后回推
      </p>
    </aside>

    <aside class="panel panel-right">
      <div class="panel-title">
        <b>实时告警</b>
        <span>{{ countsText }}</span>
      </div>

      <div class="alarm-toolbar">
        <select v-model="alarmQuery.range" @change="refreshAlarms()">
          <option value="all">全部时间</option>
          <option value="today">今天</option>
          <option value="24h">近 24 小时</option>
          <option value="7d">近 7 天</option>
        </select>
        <select v-model="alarmQuery.kind" @change="refreshAlarms()">
          <option value="">全部类型</option>
          <option value="speeding">超速</option>
          <option value="blacklist">布控命中</option>
          <option value="wrong_way">逆行</option>
          <option value="surveillance_hit">区域布控</option>
        </select>
        <button class="btn-export" :disabled="alarmLoading" @click="exportCsv">导出 CSV</button>
      </div>
      <input
        v-model="alarmQuery.plate"
        class="alarm-search"
        placeholder="按车牌筛选，回车查询"
        @keyup.enter="refreshAlarms()"
      />

      <div class="alarm-list">
        <article
          v-for="alarm in traffic.alarms"
          :key="alarm.id"
          class="alarm-item"
          :class="[levelClass(alarm.level), { 'is-acked': alarm.acked_at }]"
          @click="selectAlarm(alarm)"
        >
          <header>
            <span>{{ alarm.plate_no }}</span>
            <time>{{ formatTime(alarm.ts) }}</time>
          </header>
          <p>
            {{ alarm.checkpoint_name }} · {{ kindText(alarm.kind) }}
            <template v-if="alarm.speed_kph"> · {{ alarm.speed_kph }} km/h</template>
          </p>
          <footer>
            <span class="ack-tag" :class="{ 'is-open': !alarm.acked_at }">
              {{ alarm.acked_at ? `已确认 ${formatTime(alarm.acked_at)}` : '未确认' }}
            </span>
            <button
              v-if="!alarm.acked_at && isAdmin"
              class="btn-ack"
              @click.stop="ackAlarm(alarm)"
            >
              确认
            </button>
          </footer>
        </article>
        <p v-if="!traffic.alarms.length" class="hint">
          {{ alarmQuery.range !== 'all' || alarmQuery.kind || alarmQuery.plate ? '当前筛选条件下无告警' : '暂无告警，点左侧「模拟过车」触发布控规则' }}
        </p>
        <button
          v-if="traffic.alarms.length < alarmTotal"
          class="btn is-ghost load-more"
          :disabled="alarmLoading"
          @click="refreshAlarms(false)"
        >
          {{ alarmLoading ? '加载中…' : `加载更多（${traffic.alarms.length}/${alarmTotal}）` }}
        </button>
      </div>

      <div v-if="traffic.selected?.kind === 'alarm'" class="detail">
        <header>
          <b>告警详情 · {{ traffic.selected.data.plate_no }}</b>
          <button class="btn is-ghost" style="width: auto; padding: 3px 8px" @click="traffic.selected = null">
            关闭
          </button>
        </header>
        <dl>
          <dt>告警编号</dt>
          <dd>{{ traffic.selected.data.id }}</dd>
          <dt>告警类型</dt>
          <dd>{{ kindText(traffic.selected.data.kind) }}</dd>
          <dt>级别</dt>
          <dd>{{ levelText(traffic.selected.data.level) }}</dd>
          <dt>卡口</dt>
          <dd>{{ traffic.selected.data.checkpoint_name }}</dd>
          <dt>时间</dt>
          <dd>{{ formatDateTime(traffic.selected.data.ts) }}</dd>
          <dt>瞬时速度</dt>
          <dd>{{ traffic.selected.data.speed_kph != null ? `${traffic.selected.data.speed_kph} km/h` : '—' }}</dd>
          <dt>处置状态</dt>
          <dd>{{ traffic.selected.data.acked_at ? `已确认 ${formatDateTime(traffic.selected.data.acked_at)}` : '未确认' }}</dd>
        </dl>
        <div v-if="traffic.selected.data.snapshot_url" class="snapshot-slot">
          <img :src="traffic.selected.data.snapshot_url" alt="抓拍图" loading="lazy" />
        </div>
        <div v-else class="video-slot">
          <strong>抓拍图（MinIO）</strong>
          <span>未接入对象存储，接入后此处展示抓拍原图</span>
        </div>
        <button
          v-if="!traffic.selected.data.acked_at && isAdmin"
          class="btn"
          :disabled="ackBusy"
          @click="ackAlarm(traffic.selected.data)"
        >
          {{ ackBusy ? '确认中…' : '确认此告警' }}
        </button>
      </div>

      <div v-else-if="traffic.selected" class="detail">
        <header>
          <b>{{ traffic.selected.data.name }}</b>
          <button class="btn is-ghost" style="width: auto; padding: 3px 8px" @click="traffic.selected = null">
            关闭
          </button>
        </header>
        <dl>
          <dt>卡口编号</dt>
          <dd>{{ traffic.selected.data.id }}</dd>
          <dt>所属路段</dt>
          <dd>{{ traffic.selected.data.road_name ?? '—' }}</dd>
          <dt>国标编码</dt>
          <dd>{{ traffic.selected.data.gb_code ?? '—' }}</dd>
          <dt>状态</dt>
          <dd>{{ traffic.selected.data.status ?? '—' }}</dd>
          <dt>车道数</dt>
          <dd>{{ traffic.selected.data.lanes ?? '—' }}</dd>
        </dl>
        <div class="video-slot">
          <strong>视频预览（GB28181）</strong>
          <span>{{ gbText }}</span>
        </div>
      </div>
    </aside>

    <section class="kpi-strip">
      <header class="kpi-strip__head">
        <span class="kpi-strip__title">运行态势</span>
        <span class="kpi-strip__meta">LIVE METRICS · {{ clock }}</span>
      </header>
      <div class="kpi-strip__grid">
        <article
          v-for="(item, index) in traffic.kpi"
          :key="item.key"
          class="kpi"
          :class="toneClass(item.key)"
        >
          <span class="kpi__accent"></span>
          <span class="kpi__index">{{ String(index + 1).padStart(2, '0') }}</span>
          <div class="kpi__body">
            <span class="kpi-label">{{ item.label }}</span>
            <div class="kpi-value">
              <strong>{{ item.value }}</strong>
              <em>{{ item.unit }}</em>
            </div>
            <span v-if="item.sub" class="kpi-sub">{{ item.sub }}</span>
          </div>
          <span class="kpi__ghost" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="kpi__pulse"></span>
          <span class="kpi__bar"></span>
        </article>
      </div>
    </section>

    <footer class="statusbar">
      <span class="dot"></span>
      <span>数据源 PostGIS</span>
      <span>接入 {{ traffic.ingestMode }}</span>
      <span>WebSocket {{ traffic.wsState }}</span>
      <span>Cesium + Three {{ scene.mode === 'shared' ? '（共享上下文）' : '（叠加画布）' }}</span>
      <span style="margin-left: auto">{{ traffic.roadCount }} 段路网 · {{ traffic.checkpointCount }} 个卡口</span>
    </footer>

    <div v-if="toast" class="toast">{{ toast }}</div>

    <div v-if="!authUser" class="login-mask">
      <form class="login-card" @submit.prevent="login">
        <div class="brand">
          <span class="brand-mark"></span>
          <div>
            <strong>智慧交通检测平台</strong>
            <small>SMART TRAFFIC INSPECTION · DIGITAL TWIN</small>
          </div>
        </div>
        <input
          v-model="loginForm.name"
          placeholder="用户名"
          autocomplete="username"
          required
        />
        <input
          v-model="loginForm.password"
          type="password"
          placeholder="密码"
          autocomplete="current-password"
          required
        />
        <p v-if="loginError" class="login-error">{{ loginError }}</p>
        <button class="btn" type="submit" :disabled="loginBusy">
          {{ loginBusy ? '登录中…' : '登 录' }}
        </button>
        <p class="hint">演示账号：admin / admin123（管理）· viewer / viewer123（只读）</p>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Cesium from 'cesium'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { api } from './api/http'
import { AUTH_REQUIRED_EVENT, clearAuth, loadAuth, saveAuth, type AuthUser } from './api/auth'
import { connectRealtime } from './api/ws'
import { BeaconLayer } from './engine/beacons'
import { BlockLayer, CheckpointLayer, RoadLayer, TrajectoryLayer, ZoneLayer } from './engine/layers'
import { VehicleLayer } from './engine/vehicles'
import { useSceneStore } from './stores/scene'
import { useTrafficStore } from './stores/traffic'
import { PlanningScene, type PlanningStaticData } from './engine/planning/scene'
import type {
  AlarmEvent,
  CheckpointProps,
  RoadStatusPatch,
  SurveillanceRule,
  VehicleTarget,
} from '@traffic/shared-types'

const containerRef = ref<HTMLDivElement>()
const planningRef = ref<HTMLDivElement>()
const scene = useSceneStore()
const traffic = useTrafficStore()

/** 规划视图：懒创建独立 WebGL 上下文，避免拖慢首屏 */
const planningActive = ref(false)
const planningPreset = ref<'overview' | 'junction'>('overview')
let planningScene: PlanningScene | null = null
let planningData: PlanningStaticData = { roads: null, blocks: null, checkpoints: null, zones: null }
let latestVehicles: VehicleTarget[] = []

const clock = ref('')
const toast = ref<string | null>(null)
const gbText = ref('未接入国标网关（配置 GB28181_GATEWAY 后可预览）')

/** 布控规则表单：最小可用字段集，zone 布控待区域选择器就绪后开放 */
const ruleForm = reactive({ name: '', kind: 'speeding' as 'speeding' | 'blacklist', speed_threshold: 80 as number | undefined, plate_pattern: '' })
const ruleBusy = ref(false)
const ackBusy = ref(false)

/** 告警历史查询：筛选条件 + 游标分页（offset），实时推送照旧插到最前 */
const PAGE_SIZE = 30
const alarmQuery = reactive({ range: 'all' as 'all' | 'today' | '24h' | '7d', kind: '', plate: '' })
const alarmTotal = ref(0)
const alarmLoading = ref(false)

/** 登录态：null = 未登录，遮罩接管整个界面；登录/登出都走整页刷新，避免重连残留状态 */
const authUser = ref<AuthUser | null>(loadAuth())
const isAdmin = computed(() => authUser.value?.role === 'admin')
const loginForm = reactive({ name: 'admin', password: '' })
const loginError = ref<string | null>(null)
const loginBusy = ref(false)

function onAuthRequired(): void {
  authUser.value = null
}

async function login(): Promise<void> {
  if (loginBusy.value) return
  loginBusy.value = true
  loginError.value = null
  try {
    const result = await api.login(loginForm.name.trim(), loginForm.password)
    saveAuth({ name: result.name, role: result.role }, result.token)
    window.location.reload()
  } catch (err) {
    loginError.value = (err as Error).message.includes('401')
      ? '用户名或密码错误'
      : `登录失败：${String((err as Error).message ?? err)}`
  } finally {
    loginBusy.value = false
  }
}

function logout(): void {
  clearAuth()
  window.location.reload()
}

/**
 * 渲染图层是非响应式的普通对象：
 * 它们持有 Three/Cesium 的大对象，绝不能进 Vue 的响应式系统。
 */
let roadLayer: RoadLayer | null = null
let blockLayer: BlockLayer | null = null
let zoneLayer: ZoneLayer | null = null
let checkpointLayer: CheckpointLayer | null = null
let vehicleLayer: VehicleLayer | null = null
let beaconLayer: BeaconLayer | null = null
let trajectoryLayer: TrajectoryLayer | null = null
let disposeWs: (() => void) | null = null
let clockTimer: number | undefined
let clickHandler: Cesium.ScreenSpaceEventHandler | null = null

const checkpointPositions = new Map<string, [number, number]>()

const layerItems = [
  { key: 'blocks', label: '城市背景' },
  { key: 'vehicles', label: '车辆目标' },
  { key: 'roads', label: '路网路况' },
  { key: 'checkpoints', label: '卡口设备' },
  { key: 'alarms', label: '告警光柱' },
] as const

const ingestText = computed(() =>
  traffic.ingestMode === 'kafka-dual-group' ? 'Kafka 双通道' : '直连模式',
)
const ingestClass = computed(() => (traffic.ingestMode === 'kafka-dual-group' ? '' : 'is-warn'))
const wsText = computed(() =>
  traffic.wsState === 'online' ? '实时在线' : traffic.wsState === 'connecting' ? '连接中' : '已断开',
)
const wsClass = computed(() => (traffic.wsState === 'online' ? '' : 'is-off'))
const countsText = computed(
  () => `严重 ${traffic.alarmCounts.critical ?? 0} · 预警 ${traffic.alarmCounts.warning ?? 0}`,
)
/** 依赖异常显性化：health.deps 里任何 down 都要在顶栏露出来，不能只藏在接口返回里 */
const depWarn = computed(() => {
  const down = Object.entries(traffic.deps).filter(([, v]) => v === 'down')
  return down.length ? `${down.map(([k]) => k).join('/')} 异常` : ''
})

function toggleLayer(key: (typeof layerItems)[number]['key']): void {
  traffic.layers[key] = !traffic.layers[key]
  if (key === 'blocks') blockLayer?.setVisible(traffic.layers.blocks)
  if (key === 'vehicles') vehicleLayer?.setVisible(traffic.layers.vehicles)
  if (key === 'roads') roadLayer?.setVisible(traffic.layers.roads)
  if (key === 'checkpoints') checkpointLayer?.setVisible(traffic.layers.checkpoints)
  if (key === 'alarms') beaconLayer?.setVisible(traffic.layers.alarms)
  // 园区轴测是默认视图：同一组开关必须同时作用于岛上的对应对象
  planningScene?.setLayerVisibility(traffic.layers)
}

function levelClass(level: string): string {
  return level === 'critical' ? 'is-critical' : level === 'info' ? 'is-info' : ''
}

function toneClass(key: string): string {
  return (
    { checkpoints: 'is-cyan', speed: 'is-green', alarms: 'is-amber', critical: 'is-red' }[key] ??
    'is-cyan'
  )
}

function kindText(kind: string): string {
  return (
    { speeding: '超速', blacklist: '布控命中', wrong_way: '逆行', surveillance_hit: '区域布控' }[
      kind
    ] ?? kind
  )
}

function levelText(level: string): string {
  return { critical: '严重', warning: '预警', info: '提示' }[level] ?? level
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

function ruleDesc(rule: SurveillanceRule): string {
  if (rule.kind === 'blacklist') return `车牌前缀 ${rule.plate_pattern ?? '—'}`
  if (rule.kind === 'speeding') return `阈值 ${rule.speed_threshold ?? '—'} km/h`
  if (rule.kind === 'zone') return `区域 ${rule.zone_id ?? '—'}`
  return rule.kind
}

function alarmQueryParams(offset: number) {
  let from: string | undefined
  if (alarmQuery.range === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    from = d.toISOString()
  } else if (alarmQuery.range === '24h') {
    from = new Date(Date.now() - 86_400_000).toISOString()
  } else if (alarmQuery.range === '7d') {
    from = new Date(Date.now() - 7 * 86_400_000).toISOString()
  }
  return {
    limit: PAGE_SIZE,
    offset,
    from,
    kind: alarmQuery.kind || undefined,
    plate: alarmQuery.plate.trim() || undefined,
  }
}

async function refreshAlarms(reset = true): Promise<void> {
  alarmLoading.value = true
  try {
    const offset = reset ? 0 : traffic.alarms.length
    const data = await api.alarms(alarmQueryParams(offset))
    const items = reset ? data.items : [...traffic.alarms, ...data.items]
    traffic.replaceAlarms(items, data.counts)
    alarmTotal.value = data.total
    syncAlarmBeacons()
    planningScene?.setLabels(energyLabels())
  } catch (err) {
    notify(`告警加载失败：${String((err as Error).message ?? err)}`)
  } finally {
    alarmLoading.value = false
  }
}

/** CSV 里的时间转成本地 `YYYY-MM-DD HH:mm:ss`（不要 ISO 的 T/Z，Excel 里也不当文本处理） */
function formatCsvTime(iso?: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return String(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** 导出当前筛选结果（上限 1000 条），带 BOM 保证 Excel 打开中文不乱码 */
async function exportCsv(): Promise<void> {
  try {
    const data = await api.alarms({ ...alarmQueryParams(0), limit: 1000 })
    const header = ['告警编号', '车牌号', '告警类型', '级别', '卡口', '告警时间', '速度(km/h)', '确认时间']
    const escape = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`
    const csv = [
      header.join(','),
      ...data.items.map((item) =>
        [
          item.id,
          item.plate_no,
          kindText(item.kind),
          levelText(item.level),
          item.checkpoint_name,
          formatCsvTime(item.ts),
          item.speed_kph ?? '',
          formatCsvTime(item.acked_at),
        ]
          .map(escape)
          .join(','),
      ),
    ].join('\n')
    const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `alarms-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
    notify(`已导出 ${data.items.length} 条告警`)
  } catch (err) {
    notify(`导出失败：${String((err as Error).message ?? err)}`)
  }
}

function notify(message: string): void {
  toast.value = message
  window.setTimeout(() => (toast.value = null), 2600)
}

/** 园区岛指标卡：全部取自真实业务指标（未确认告警按服务端聚合口径求和） */
function energyLabels() {
  const openAlarms = Object.values(traffic.alarmCounts).reduce((sum, value) => sum + (value ?? 0), 0)
  return {
    gate: { title: '在线卡口', value: String(traffic.checkpointCount), unit: '个' },
    center: { title: '布控路段', value: String(traffic.roadCount), unit: '条' },
    junction: { title: '未确认告警', value: String(openAlarms), unit: '条' },
  }
}

/** 告警光柱：按告警所属卡口定位，实时推送与历史刷新都同步 */
function syncAlarmBeacons(): void {
  planningScene?.setAlarms(
    traffic.alarms.map((item) => ({ checkpoint_id: item.checkpoint_id, level: item.level })),
    checkpointPositions,
  )
}

/** 全景 ↔ 路口近景：近景下车长约 30px，能看清车漆、车窗、轮毂与前后灯 */
async function togglePreset(): Promise<void> {
  if (!planningActive.value) await togglePlanning()
  const next = planningPreset.value === 'overview' ? 'junction' : 'overview'
  planningPreset.value = next
  planningScene?.setPreset(next)
}

/**
 * 第二渲染模式：规划视图（正交相机 + 辉光）。
 * 两个画布互斥显示，切换时暂停/恢复 Cesium 的渲染循环，避免看不见的整帧开销。
 */
async function togglePlanning(): Promise<void> {
  if (!scene.viewer) return
  const next = !planningActive.value
  planningActive.value = next
  // v-show 是异步更新的：等 DOM 有尺寸后再初始化，否则测得 clientWidth = 0
  await nextTick()

  if (next) {
    if (!planningScene && planningRef.value) {
      planningScene = new PlanningScene(planningRef.value)
      planningScene.setStatic(planningData)
      planningScene.updateVehicles(latestVehicles)
    }
    planningScene?.setLabels(energyLabels())
    planningScene?.setLayerVisibility(traffic.layers)
    syncAlarmBeacons()
    scene.viewer.useDefaultRenderLoop = false
    planningScene?.setVisible(true)
  } else {
    planningScene?.setVisible(false)
    scene.viewer.useDefaultRenderLoop = true
  }
}

onMounted(async () => {
  window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)

  if (!containerRef.value) return
  await scene.mount(containerRef.value)

  const viewer = scene.viewer!
  const coordinator = scene.coordinator!

  blockLayer = new BlockLayer(viewer)
  roadLayer = new RoadLayer(viewer)
  zoneLayer = new ZoneLayer(viewer)
  checkpointLayer = new CheckpointLayer(viewer)
  vehicleLayer = new VehicleLayer(coordinator)
  beaconLayer = new BeaconLayer(coordinator)
  trajectoryLayer = new TrajectoryLayer(viewer)

  clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  clickHandler.setInputAction(async (movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
    const picked = viewer.scene.pick(movement.position) as { id?: { id?: string } } | undefined
    const entityId = picked?.id?.id
    if (entityId?.startsWith('cp:')) await selectCheckpoint(entityId.slice(3))
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK)

  // 未登录时不拉数据/不连 WS：登录层接管，登录成功整页刷新后走正常初始化
  if (authUser.value) {
    await loadStatic()
    connectWs()
  }

  // 园区轴测视图是默认业务视图；?render=twin 才回到 Cesium 数字孪生（保留排障入口）
  if (authUser.value && new URLSearchParams(location.search).get('render') !== 'twin') {
    await togglePlanning()
  }

  clockTimer = window.setInterval(() => {
    clock.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  }, 1000)
  clock.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })

  if (new URLSearchParams(location.search).has('diag')) {
    window.setTimeout(() => {
      const camera = viewer.camera
      const carto = camera.positionCartographic
      document.title = JSON.stringify({
        mode: scene.mode,
        gl: Boolean((viewer.scene as any).context?._gl),
        canvas: `${viewer.canvas.width}x${viewer.canvas.height}`,
        entities: viewer.entities.values.length,
        threeChildren: coordinator.threeScene.children.length,
        threeVisible: vehicleLayer ? (vehicleLayer as any).mesh.count : -1,
        three: coordinator.debugStats(),
        // 第 0 个实例投影到 NDC：判断「画了但不在视野里」还是「根本没画」
        probe: vehicleLayer?.sampleNdc() ?? null,
        camHeight: Math.round(carto.height),
        camLng: Cesium.Math.toDegrees(carto.longitude).toFixed(3),
        camLat: Cesium.Math.toDegrees(carto.latitude).toFixed(3),
        sceneMode: viewer.scene.mode,
        tileQueue: viewer.scene.globe.tilesLoaded,
      })
    }, 4000)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  window.clearInterval(clockTimer)
  planningScene?.dispose()
  planningScene = null
  disposeWs?.()
  clickHandler?.destroy()
  vehicleLayer?.dispose()
  beaconLayer?.clear()
  trajectoryLayer?.clear()
  scene.dispose()
})

async function loadStatic(): Promise<void> {
  try {
    const [health, roads, zones, blocks, checkpoints, overview, rules] = await Promise.all([
      api.health(),
      api.roads(),
      api.zones(),
      api.blocks(),
      api.checkpoints(),
      api.overview(),
      api.rules(),
    ])

    traffic.ingestMode = health.ingest
    traffic.deps = health.deps
    traffic.roadCount = roads.features.length
    traffic.checkpointCount = checkpoints.features.length
    traffic.roads = roads
    traffic.kpi = overview.kpi
    traffic.rules = rules.items

    blockLayer?.setBlocks(blocks)
    roadLayer?.setRoads(roads)
    zoneLayer?.setZones(zones)
    checkpointLayer?.setCheckpoints(checkpoints)

    // 规划视图复用同一份路网/体块数据：不另造数据，避免两个视图说两种话
    planningData = { roads, blocks, checkpoints, zones }
    planningScene?.setStatic(planningData)
    planningScene?.setLabels(energyLabels())
    for (const feature of checkpoints.features) {
      const [lng, lat] = feature.geometry.coordinates as [number, number]
      checkpointPositions.set((feature.properties as CheckpointProps).id, [lng, lat])
    }

    const gb = await api.gbStatus().catch(() => null)
    if (gb?.configured && gb.state === 'up') gbText.value = '网关在线，点击获取播放地址'

    await refreshAlarms()
  } catch (err) {
    traffic.error = String(err)
    notify(`数据加载失败：${String((err as Error).message ?? err)}`)
  }
}

function connectWs(): void {
  disposeWs = connectRealtime({
    onState: (state) => (traffic.wsState = state),
    onVehicles: (vehicles: VehicleTarget[]) => {
      traffic.vehicleCount = vehicles.length
      latestVehicles = vehicles
      vehicleLayer?.update(vehicles)
      planningScene?.updateVehicles(vehicles)
      if (planningActive.value) planningScene?.setLabels(energyLabels())
    },
    onRoadStatus: (patches: RoadStatusPatch[]) => {
      roadLayer?.updateStatus(patches)
    },
    onAlarm: (alarm: AlarmEvent) => {
      traffic.pushAlarm(alarm)
      const position = checkpointPositions.get(alarm.checkpoint_id)
      if (position) beaconLayer?.add(position[0], position[1], alarm.level)
      syncAlarmBeacons()
      planningScene?.setLabels(energyLabels())
    },
    onRuleChanged: () => {
      loadRules()
    },
  })
}

async function selectCheckpoint(id: string): Promise<void> {
  try {
    const detail = await api.checkpointDetail(id)
    traffic.selected = { kind: 'checkpoint', id, data: detail }
  } catch (err) {
    notify(`详情加载失败：${String((err as Error).message ?? err)}`)
  }
}

async function selectAlarm(alarm: AlarmEvent): Promise<void> {
  // 点告警 = 看告警详情 + 相机飞到事发卡口；卡口档案仍由地图点击进入
  traffic.selected = { kind: 'alarm', id: alarm.id, data: { ...alarm } }
  const position = checkpointPositions.get(alarm.checkpoint_id)
  if (position && scene.viewer) {
    scene.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(position[0], position[1], 700),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
      duration: 1.2,
    })
  }
}

async function simulate(): Promise<void> {
  try {
    const result = await api.simulate(20)
    notify(`已注入 ${result.produced} 条过车事件`)
    await refreshAlarms()
  } catch (err) {
    notify(`模拟失败：${String((err as Error).message ?? err)}`)
  }
}

async function playback(): Promise<void> {
  try {
    const data = await api.trajectoryRecent()
    const first = data.items[0]
    if (!first) {
      notify('没有可回放的轨迹（先执行 pnpm db:seed）')
      return
    }
    trajectoryLayer?.show(first.geometry.coordinates as number[][], first.plate_no)
    traffic.playbackPlate = first.plate_no
    const coordinates = first.geometry.coordinates as number[][]
    const mid = coordinates[Math.floor(coordinates.length / 2)]
    scene.viewer?.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(mid[0], mid[1], 2400),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
      duration: 1.2,
    })
    notify(`回放 ${first.plate_no} 的 ${coordinates.length} 个抽稀点`)
  } catch (err) {
    notify(`回放失败：${String((err as Error).message ?? err)}`)
  }
}

async function loadRules(): Promise<void> {
  try {
    const data = await api.rules()
    traffic.rules = data.items
  } catch (err) {
    notify(`规则加载失败：${String((err as Error).message ?? err)}`)
  }
}

async function toggleRule(rule: SurveillanceRule): Promise<void> {
  try {
    const saved = await api.saveRule({ ...rule, active: !rule.active })
    const index = traffic.rules.findIndex((item) => item.id === rule.id)
    if (index >= 0) traffic.rules[index] = saved
    notify(`${saved.name} 已${saved.active ? '启用' : '停用'}`)
  } catch (err) {
    notify(`规则更新失败：${String((err as Error).message ?? err)}`)
  }
}

async function removeRule(rule: SurveillanceRule): Promise<void> {
  try {
    await api.deleteRule(rule.id)
    traffic.rules = traffic.rules.filter((item) => item.id !== rule.id)
    notify(`已删除 ${rule.name}`)
  } catch (err) {
    notify(`规则删除失败：${String((err as Error).message ?? err)}`)
  }
}

async function addRule(): Promise<void> {
  if (ruleBusy.value) return
  ruleBusy.value = true
  try {
    const input: Partial<SurveillanceRule> = {
      name: ruleForm.name.trim(),
      kind: ruleForm.kind,
      active: true,
    }
    if (ruleForm.kind === 'speeding') input.speed_threshold = ruleForm.speed_threshold
    else input.plate_pattern = ruleForm.plate_pattern.trim()

    const saved = await api.saveRule(input)
    traffic.rules = [...traffic.rules, saved]
    ruleForm.name = ''
    ruleForm.speed_threshold = 80
    ruleForm.plate_pattern = ''
    notify(`已新增 ${saved.name}，规则副本已广播刷新`)
  } catch (err) {
    notify(`新增失败：${String((err as Error).message ?? err)}`)
  } finally {
    ruleBusy.value = false
  }
}

async function ackAlarm(alarm: AlarmEvent): Promise<void> {
  if (ackBusy.value || alarm.acked_at) return
  ackBusy.value = true
  try {
    await api.ackAlarm(alarm.id)
    const ackedAt = new Date().toISOString()
    traffic.markAcked(alarm.id, ackedAt)
    if (traffic.selected?.kind === 'alarm' && traffic.selected.id === alarm.id) {
      traffic.selected = { ...traffic.selected, data: { ...traffic.selected.data, acked_at: ackedAt } }
    }
    // 计数与列表都以服务端口径为准，确认后按当前筛选刷新一次
    await refreshAlarms(true)
    notify(`告警 ${alarm.id.slice(0, 8)} 已确认`)
  } catch (err) {
    notify(`确认失败：${String((err as Error).message ?? err)}`)
  } finally {
    ackBusy.value = false
  }
}
</script>
