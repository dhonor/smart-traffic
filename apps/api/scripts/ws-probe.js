/**
 * WebSocket 冒烟探针：连上与 API，验证四类事件是否按预期到达。
 *   node scripts/ws-probe.js
 */
const { io } = require('socket.io-client')

const socket = io('http://127.0.0.1:8080/realtime', { transports: ['websocket'] })
const seen = new Set()
const deadline = setTimeout(() => {
  console.log('收到事件:', [...seen].join(', '))
  const ok = seen.has('vehicles') && seen.has('hello')
  console.log(ok ? 'WS 冒烟通过' : 'WS 事件不完整')
  socket.close()
  process.exit(ok ? 0 : 1)
}, 6000)

socket.on('connect', () => console.log('已连接', socket.id))
socket.on('hello', (envelope) => {
  seen.add('hello')
  console.log('hello:', JSON.stringify(envelope.data))
})
socket.on('vehicles', (envelope) => {
  if (seen.has('vehicles')) return
  seen.add('vehicles')
  console.log(`vehicles: ${envelope.data.length} 辆，样例 ${envelope.data[0].plate_no} @ ${envelope.data[0].speed_kph}km/h`)
})
socket.on('road_status', (envelope) => {
  if (seen.has('road_status')) return
  seen.add('road_status')
  console.log(`road_status: ${envelope.data.length} 段，样例 ${envelope.data[0].id}=${envelope.data[0].congestion}`)
})
socket.on('passage', () => seen.add('passage'))
socket.on('alarm', (envelope) => {
  if (seen.has('alarm')) return
  seen.add('alarm')
  console.log(`alarm: ${envelope.data.plate_no} ${envelope.data.kind}`)
})
socket.on('connect_error', (err) => {
  console.error('连接失败:', err.message)
  clearTimeout(deadline)
  process.exit(1)
})
