/**
 * 端到端冒烟：HTTP + 业务链路 + WebSocket。
 *
 *   node scripts/smoke.mjs            # 需要 API 已在 8080 运行
 *
 * 覆盖：健康检查 → 鉴权 → 路网/卡口 → 过车注入 → 规则命中 → 告警落库 → 分页/筛选 → 空间查询 → 轨迹 → WS 事件
 */
import { io } from 'socket.io-client'

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8080'
let failed = 0

function check(name, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}

async function get(path, token) {
  const response = await fetch(`${BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error(`${path} -> ${response.status}`)
  return response.json()
}

async function post(path, token) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error(`${path} -> ${response.status}`)
  return response.json()
}

async function login(name, password) {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  })
  if (!response.ok) throw new Error(`登录失败 -> ${response.status}`)
  return response.json()
}

async function main() {
  const health = await get('/api/health')
  check('健康检查', health.status === 'ok' || health.status === 'degraded', `ingest=${health.ingest}`)
  check('PostGIS 可用', health.deps.postgis === 'up')

  // 鉴权：无令牌被拒、admin 登录、viewer 只读被 403
  const anonymous = await fetch(`${BASE}/api/devices/checkpoints`)
  check('未带令牌被拒绝（401）', anonymous.status === 401, `${anonymous.status}`)

  const adminLogin = await login('admin', 'admin123')
  const adminToken = adminLogin.token
  check('admin 登录签发 JWT', Boolean(adminToken) && adminLogin.role === 'admin')

  const viewerLogin = await login('viewer', 'viewer123')
  const forbidden = await fetch(`${BASE}/api/surveillance/rules`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${viewerLogin.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x' }),
  })
  check('viewer 写操作被拒（403）', forbidden.status === 403, `${forbidden.status}`)

  const roads = await get('/api/spatial/roads', adminToken)
  check('路网返回 GeoJSON', roads.type === 'FeatureCollection' && roads.features.length > 0, `${roads.features.length} 段`)
  check('路况字段齐全', typeof roads.features[0].properties.speed_kph === 'number')

  const checkpoints = await get('/api/devices/checkpoints', adminToken)
  check('卡口列表', checkpoints.features.length >= 20, `${checkpoints.features.length} 个`)

  const zones = await get('/api/spatial/zones', adminToken)
  check('布控区', zones.features.length >= 1)

  const simulated = await post('/api/checkpoints/simulate?count=20', adminToken)
  check('过车注入', simulated.produced === 20)

  const passages = await get('/api/checkpoints/passages?limit=10', adminToken)
  check('过车可查（TDengine 或内存缓冲）', passages.count > 0, `${passages.count} 条`)

  const alarms = await get('/api/surveillance/alarms?limit=20', adminToken)
  check('规则命中产生告警', alarms.count > 0, `${alarms.count} 条`)

  const paged = await get('/api/surveillance/alarms?limit=1&offset=1', adminToken)
  check('告警分页（total 口径一致）', paged.total >= paged.count && paged.items[0]?.id !== alarms.items[0]?.id, `total=${paged.total}`)

  const filtered = await get(`/api/surveillance/alarms?limit=50&plate=${encodeURIComponent(alarms.items[0].plate_no.slice(0, 3))}`, adminToken)
  check('告警车牌筛选', filtered.count > 0 && filtered.items.every((item) => item.plate_no.startsWith(alarms.items[0].plate_no.slice(0, 3))))

  const alarm = alarms.items[0]
  const ack = await post(`/api/surveillance/alarms/${alarm.id}/ack`, adminToken)
  check('告警可确认', ack.ok === true)

  // 规则落库：创建 → 可查 → 删除 → 不可查（写路径走 PostGIS upsert/delete）
  const createdRule = await fetch(`${BASE}/api/surveillance/rules`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '冒烟临时规则', kind: 'speeding', speed_threshold: 123 }),
  }).then((r) => r.json())
  const rulesAfterCreate = await get('/api/surveillance/rules', adminToken)
  check('规则创建且落库可查', rulesAfterCreate.items.some((item) => item.id === createdRule.id), createdRule.id)
  await fetch(`${BASE}/api/surveillance/rules/${encodeURIComponent(createdRule.id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  const rulesAfterDelete = await get('/api/surveillance/rules', adminToken)
  check('规则删除生效', !rulesAfterDelete.items.some((item) => item.id === createdRule.id))

  const within = await fetch(`${BASE}/api/spatial/within`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      polygon: 'POLYGON((113.955 22.548, 114.02 22.548, 114.02 22.59, 113.955 22.59, 113.955 22.548))',
      layer: 'checkpoint',
    }),
  }).then((r) => r.json())
  check('空间查询（ST_Within）', within.count > 0, `${within.count} 个卡口`)

  const trajectory = await get('/api/trajectory/recent', adminToken)
  check('轨迹线段', trajectory.items.length > 0, `${trajectory.items.length} 段`)

  const wsOk = await new Promise((resolve) => {
    const socket = io(`${BASE}/realtime`, { transports: ['websocket'], auth: { token: adminToken } })
    const seen = new Set()
    const timer = setTimeout(() => {
      socket.close()
      resolve(seen.has('vehicles') && seen.has('hello'))
    }, 6000)
    socket.on('hello', () => seen.add('hello'))
    socket.on('vehicles', (envelope) => {
      seen.add('vehicles')
      clearTimeout(timer)
      socket.close()
      resolve(envelope.data.length > 0)
    })
    socket.on('connect_error', () => {
      clearTimeout(timer)
      socket.close()
      resolve(false)
    })
  })
  check('WebSocket 车辆推送', wsOk)

  console.log(failed === 0 ? '\n冒烟全部通过' : `\n${failed} 项未通过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟失败:', err.message)
  process.exit(1)
})
