/**
 * 建表 + 灌演示数据（幂等，可反复执行）。
 *
 *   pnpm --filter @traffic/api seed
 *
 * 数据是「一个虚构城市片区」的路网/卡口/布控区，坐标约在东经 113.95–114.05、北纬 22.54–22.62。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { config } from './config'

const LNG0 = 113.95
const LNG1 = 114.05
const LAT0 = 22.54
const LAT1 = 22.62

const H_ROADS = [
  { id: 'R-H1', name: '滨河大道', lat: 22.552, level: 'expressway', limit: 80 },
  { id: 'R-H2', name: '深南大道', lat: 22.567, level: 'expressway', limit: 80 },
  { id: 'R-H3', name: '红荔路', lat: 22.582, level: 'arterial', limit: 60 },
  { id: 'R-H4', name: '北环大道', lat: 22.598, level: 'arterial', limit: 60 },
  { id: 'R-H5', name: '梅林路', lat: 22.611, level: 'branch', limit: 40 },
]

const V_ROADS = [
  { id: 'R-V1', name: '香蜜湖路', lng: 113.962, level: 'arterial', limit: 60 },
  { id: 'R-V2', name: '新洲路', lng: 113.978, level: 'arterial', limit: 60 },
  { id: 'R-V3', name: '彩田路', lng: 113.994, level: 'expressway', limit: 80 },
  { id: 'R-V4', name: '皇岗路', lng: 114.012, level: 'arterial', limit: 60 },
  { id: 'R-V5', name: '文锦路', lng: 114.032, level: 'branch', limit: 40 },
]

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.pgUrl })
  const schema = readFileSync(join(__dirname, 'db/schema.sql'), 'utf8')

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await pool.query('SELECT 1')
      break
    } catch (err) {
      if (attempt === 20) throw err
      console.log(`等待 PostGIS 就绪… (${attempt}/20)`)
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }

  await pool.query(schema)
  console.log('表结构已就绪')

  await pool.query(
    'TRUNCATE road, checkpoint, zone, alarm, trajectory_segment, block RESTART IDENTITY CASCADE',
  )

  // ---- 布控规则（与 surveillance 模块 DEFAULT_RULES 保持一致）
  await pool.query('TRUNCATE surveillance_rule')
  for (const rule of [
    { id: 'RULE-SPEED', name: '快速路超速 20%', kind: 'speeding', threshold: 96, active: true },
    { id: 'RULE-BLACK', name: '重点车辆布控', kind: 'blacklist', pattern: '粤B9', active: true },
    { id: 'RULE-SLOW', name: '异常低速（疑似抛锚）', kind: 'speeding', threshold: 10, active: false },
  ]) {
    await pool.query(
      `INSERT INTO surveillance_rule (id, name, kind, plate_pattern, speed_threshold, zone_id, active)
       VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
      [rule.id, rule.name, rule.kind, (rule as any).pattern ?? null, (rule as any).threshold ?? null, rule.active],
    )
  }
  console.log('默认布控规则已写入')

  // ---- 路网
  for (const road of H_ROADS) {
    await pool.query(
      `INSERT INTO road (id, name, level, speed_limit, speed_kph, geom)
       VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakeLine(ST_MakePoint($6, $7), ST_MakePoint($8, $7)), 4326))`,
      [road.id, road.name, road.level, road.limit, road.limit * 0.82, LNG0, road.lat, LNG1],
    )
  }
  for (const road of V_ROADS) {
    await pool.query(
      `INSERT INTO road (id, name, level, speed_limit, speed_kph, geom)
       VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakeLine(ST_MakePoint($6, $7), ST_MakePoint($6, $8)), 4326))`,
      [road.id, road.name, road.level, road.limit, road.limit * 0.78, road.lng, LAT0, LAT1],
    )
  }
  console.log(`路网 ${H_ROADS.length + V_ROADS.length} 条`)

  // ---- 卡口：每个「横 × 纵」交叉口一个，方向按行列交替
  let index = 0
  for (const v of V_ROADS) {
    for (const h of H_ROADS) {
      index += 1
      const direction = index % 2 === 0 ? 'up' : 'down'
      await pool.query(
        `INSERT INTO checkpoint (id, name, road_id, direction, gb_code, status, lanes, geom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ST_SetSRID(ST_MakePoint($8, $9), 4326))`,
        [
          `CP${String(index).padStart(3, '0')}`,
          `${v.name}·${h.name}口`,
          v.id,
          direction,
          `44030500${String(132000000 + index).padStart(9, '0')}`,
          index % 7 === 0 ? 'fault' : 'online',
          h.level === 'expressway' ? 5 : 3,
          v.lng,
          h.lat,
        ],
      )
    }
  }
  console.log(`卡口 ${V_ROADS.length * H_ROADS.length} 个`)

  // ---- 布控区
  await pool.query(
    `INSERT INTO zone (id, name, kind, geom)
     VALUES ('Z-01', '会展中心核心区', 'surveillance',
             ST_SetSRID(ST_Buffer(ST_MakePoint(114.002, 22.575)::geography, 900)::geometry, 4326))`,
  )
  await pool.query(
    `INSERT INTO zone (id, name, kind, geom)
     VALUES ('Z-02', '北站枢纽圈', 'surveillance',
             ST_SetSRID(ST_Buffer(ST_MakePoint(113.985, 22.605)::geography, 700)::geometry, 4326))`,
  )

  // ---- 城市背景体块：填在路网围合出的街区里，留出退线。
  //      纯示意数据，目的是让路网不至于是"黑底上的几根线"。
  const lngs = V_ROADS.map((r) => r.lng)
  const lats = H_ROADS.map((r) => r.lat)
  let blockIndex = 0
  const blockRows: Array<{ id: string; name: string; height: number; wkt: string }> = []

  for (let i = 0; i < lngs.length - 1; i += 1) {
    for (let j = 0; j < lats.length - 1; j += 1) {
      // 退线留足: 街区占地太满会把道路挤成缝, 反而看不出路网
      const lng0 = lngs[i] + 0.0032
      const lng1 = lngs[i + 1] - 0.0032
      const lat0 = lats[j] + 0.0018
      const lat1 = lats[j + 1] - 0.0018
      const midLng = (lng0 + lng1) / 2
      const midLat = (lat0 + lat1) / 2

      const cells: Array<[number, number, number, number]> = [
        [lng0, lat0, midLng - 0.0008, midLat - 0.0006],
        [midLng + 0.0008, lat0, lng1, midLat - 0.0006],
        [lng0, midLat + 0.0006, midLng - 0.0008, lat1],
        [midLng + 0.0008, midLat + 0.0006, lng1, lat1],
      ]

      for (const [x0, y0, x1, y1] of cells) {
        if (x1 - x0 < 0.003 || y1 - y0 < 0.002) continue
        blockIndex += 1
        const height = 12 + ((blockIndex * 7) % 30)
        blockRows.push({
          id: `BLK${String(blockIndex).padStart(3, '0')}`,
          name: '',
          height,
          wkt: `POLYGON((${x0} ${y0}, ${x1} ${y0}, ${x1} ${y1}, ${x0} ${y1}, ${x0} ${y0}))`,
        })
      }
    }
  }

  for (const block of blockRows) {
    await pool.query(
      `INSERT INTO block (id, name, height, kind, geom)
       VALUES ($1, $2, $3, 'context', ST_SetSRID(ST_GeomFromText($4), 4326))`,
      [block.id, block.name, block.height, block.wkt],
    )
  }
  console.log(`城市背景体块 ${blockRows.length} 个（示意数据）`)

  // ---- 抽稀后的轨迹线段（原始点按设计只进 TDengine）
  const vehicles = [
    { id: 'V-粤B12345', plate: '粤B12345', lat: 22.567 },
    { id: 'V-粤B88888', plate: '粤B88888', lat: 22.582 },
    { id: 'V-粤B30076', plate: '粤B30076', lat: 22.552 },
  ]
  for (const vehicle of vehicles) {
    const points = 24
    const coords: string[] = []
    for (let i = 0; i < points; i += 1) {
      const lng = LNG0 + ((LNG1 - LNG0) * i) / (points - 1)
      const lat = vehicle.lat + Math.sin(i / 3) * 0.0012
      coords.push(`${lng} ${lat}`)
    }
    const now = Date.now()
    await pool.query(
      `INSERT INTO trajectory_segment (vehicle_id, plate_no, started_at, ended_at, points, geom)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), $5,
               ST_SetSRID(ST_GeomFromText($6), 4326))`,
      [vehicle.id, vehicle.plate, now - 15 * 60_000, now, points, `LINESTRING(${coords.join(',')})`],
    )
  }

  // ---- 种子告警
  const alarms = [
    ['ALM-SEED-001', 'CP003', '粤B9F321', 'speeding', 'warning', 96.4],
    ['ALM-SEED-002', 'CP011', '粤B7K882', 'blacklist', 'critical', 61.2],
    ['ALM-SEED-003', 'CP018', '粤B1Q009', 'wrong_way', 'critical', 43.8],
  ] as const
  for (const [id, cp, plate, kind, level, speed] of alarms) {
    await pool.query(
      `INSERT INTO alarm (id, checkpoint_id, plate_no, kind, level, ts, speed_kph)
       VALUES ($1, $2, $3, $4, $5, now() - interval '5 minutes', $6)`,
      [id, cp, plate, kind, level, speed],
    )
  }

  console.log('演示数据写入完成')
  await pool.end()
}

main().catch((err) => {
  console.error('seed 失败:', err)
  process.exit(1)
})
