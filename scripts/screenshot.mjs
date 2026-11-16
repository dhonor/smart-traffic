/**
 * 无头 Chrome 截图（CDP），用于验收渲染结果：
 *
 *   node scripts/screenshot.mjs                 # 默认页（园区轴测视图）
 *   node scripts/screenshot.mjs --twin          # 数字孪生视图（?render=twin）
 *   node scripts/screenshot.mjs --junction      # 路口近景（验收车辆模型细节）
 *   node scripts/screenshot.mjs --spacing       # 连续采样同车道跟驰净距（要求 violations=0）
 *   node scripts/screenshot.mjs --signals       # 模拟 24s / 2 周期，验收路口冲突（要求 maxConflicts=0）
 *   node scripts/screenshot.mjs --motion        # 采样坐标变化，确认车流在动
 *   node scripts/screenshot.mjs --diag          # 输出滚动容器 / 视图状态诊断
 *   node scripts/screenshot.mjs --out shot.png
 *
 * 前置：API 8080 与 Vite 5174 在跑。脚本会：
 *   1. 调 /api/auth/login 拿 JWT；
 *   2. 起 headless Chrome（软件渲染 WebGL，需 --enable-unsafe-swiftshader）；
 *   3. 注入 localStorage 登录态 → 打开深链 → 等场景稳定 → 截图。
 * 控制台异常会打印出来，避免"截图黑屏但不知道哪一步崩了"。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const API = process.env.API_BASE ?? 'http://127.0.0.1:8080'
const WEB = process.env.WEB_BASE ?? 'http://localhost:5174'
const args = process.argv.slice(2)
const twin = args.includes('--twin')
const junction = args.includes('--junction')
const sizeArg = args.find((arg) => arg.startsWith('--size='))
const [width, height] = (sizeArg ? sizeArg.slice(7) : '1920x1080').split('x').map(Number)
const out = (() => {
  const index = args.indexOf('--out')
  return index >= 0 ? args[index + 1] : twin ? 'twin.png' : 'planning.png'
})()
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = Number(process.env.CDP_PORT ?? 9223)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function login() {
  const response = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'admin', password: 'admin123' }),
  })
  if (!response.ok) throw new Error(`登录失败 ${response.status}`)
  return response.json()
}

async function openPage() {
  // Chrome 111+ 的 /json/new 需要 PUT；把 about:blank 换成目标页后返回 page WS
  const response = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  const target = await response.json()
  return target.webSocketDebuggerUrl
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const pending = new Map()
    const events = []
    let id = 0

    socket.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const messageId = ++id
            pending.set(messageId, { res, rej })
            socket.send(JSON.stringify({ id: messageId, method, params }))
          })
        },
        events,
        close: () => socket.close(),
      })
    socket.onerror = (err) => reject(new Error(`CDP 连接失败: ${String(err?.message ?? err)}`))
    socket.onmessage = (message) => {
      const payload = JSON.parse(message.data)
      if (payload.id && pending.has(payload.id)) {
        const { res, rej } = pending.get(payload.id)
        pending.delete(payload.id)
        if (payload.error) rej(new Error(payload.error.message))
        else res(payload.result)
      } else if (payload.method) {
        events.push(payload)
      }
    }
  })
}

async function main() {
  const auth = await login()
  const profile = mkdtempSync(join(tmpdir(), 'traffic-shot-'))

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1920,1080',
      '--hide-scrollbars',
      // 无 GPU 环境用 SwiftShader 跑 WebGL；不开这个 Chrome 会直接禁 WebGL 上下文
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    // 等调试端口就绪
    for (let i = 0; i < 40; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/json/version`)
        break
      } catch {
        await sleep(250)
      }
    }

    const cdp = await connect(await openPage())
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    })

    const url = `${WEB}/`
    await cdp.send('Page.navigate', { url })
    await sleep(1500)

    await cdp.send('Runtime.evaluate', {
      expression: `localStorage.setItem('traffic.auth', ${JSON.stringify(
        JSON.stringify({ name: auth.name, role: auth.role, token: auth.token }),
      )})`,
    })
    const target = `${WEB}/${twin ? '?render=twin' : ''}`
    await cdp.send('Page.navigate', { url: target })
    // Cesium 首帧 + 规划视图几何构建 + 一次 Bloom 合成，软件渲染下要给足时间
    await sleep(Number(process.env.SHOT_WAIT ?? 12_000))

    if (junction) {
      // 等默认规划视图初始化完成再点：初始化未完成时点击会落到孪生视图状态
      for (let i = 0; i < 30; i += 1) {
        const ready = await cdp.send('Runtime.evaluate', {
          expression: `!!document.querySelector('.planning-canvas') &&
            document.querySelectorAll('.mode-toggle')[0]?.textContent.includes('切回孪生')`,
          returnByValue: true,
        })
        if (ready.result.value) break
        await sleep(500)
      }
      await cdp.send('Runtime.evaluate', {
        expression: `document.querySelectorAll('.mode-toggle')[1]?.click()`,
      })
      await sleep(2500)
    }

    if (args.includes('--signals')) {
      // 等 WS 车流到位再模拟：空场景上跑 24s 会得到"零冲突"的假通过
      for (let i = 0; i < 40; i += 1) {
        const ready = await cdp.send('Runtime.evaluate', {
          expression: `(window.__planningSpacing || {}).total || 0`,
          returnByValue: true,
        })
        if (ready.result.value > 0) break
        await sleep(500)
      }
      // 无头软件渲染帧率太低，实时等待覆盖不到相位切换：用模拟时钟一次跑完 24s
      // （2 个完整信号周期），每 2s 取一次冲突/相位快照
      const response = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          if (!window.__planningStep) return 'missing';
          const out = [];
          let busySteps = 0, maxConflicts = 0, ewGreen = 0, nsGreen = 0;
          for (let i = 0; i < 96; i += 1) {
            const item = window.__planningStep(0.25);
            if (item.busy.length) busySteps += 1;
            maxConflicts = Math.max(maxConflicts, item.conflicts);
            if (item.green === 'ew') ewGreen += 1;
            if (item.green === 'ns') nsGreen += 1;
            if (i % 8 === 0) out.push(item);
          }
          return JSON.stringify({ maxConflicts, busySteps, ewGreen, nsGreen, snapshots: out });
        })()`,
        returnByValue: true,
      })
      console.log('路口信号（模拟 24s / 2 周期）:', response.result.value)
    }

    if (args.includes('--spacing')) {
      // 连续采样车距：净距 >= 0 且 violations=0 才说明没有任何后车压过前车
      const samples = []
      for (let i = 0; i < 5; i += 1) {
        const response = await cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify(window.__planningSpacing || null)`,
          returnByValue: true,
        })
        samples.push(response.result.value)
        await sleep(700)
      }
      console.log('跟驰车距采样:', samples.join(' | '))
    }

    if (args.includes('--motion')) {
      const sample = async () => {
        const response = await cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify(window.__planningFlow || [])`,
          returnByValue: true,
        })
        return response.result.value
      }
      const before = await sample()
      await sleep(1800)
      const after = await sample()
      console.log('车流位移采样:', before, '→', after, before !== after ? '车辆在移动' : '车辆静止')
    }

    if (args.includes('--diag')) {
      const result = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          toggles: [...document.querySelectorAll('.mode-toggle')].map(el => el.textContent.trim()),
          planningLayer: (() => {
            const el = document.querySelector('.planning-layer');
            if (!el) return 'missing';
            return getComputedStyle(el).display + ' ' + el.clientWidth + 'x' + el.clientHeight;
          })(),
          planningCanvas: !!document.querySelector('.planning-canvas'),
          scrolls: ['.panel-left','.alarm-list','.rule-list'].map(sel => {
            const el = document.querySelector(sel);
            if (!el) return { sel, missing: true };
            const cs = getComputedStyle(el);
            return { sel, overflowX: cs.overflowX, overflowY: cs.overflowY,
                     scrollW: el.scrollWidth, clientW: el.clientWidth,
                     scrollH: el.scrollHeight, clientH: el.clientHeight };
          })
        })`,
        returnByValue: true,
      })
      console.log('滚动容器诊断:', result.result.value)
    }

    const failures = cdp.events.filter(
      (event) =>
        event.method === 'Runtime.exceptionThrown' ||
        (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'),
    )
    for (const event of failures) {
      const detail =
        event.params?.exceptionDetails?.exception?.description ??
        event.params?.args?.map((arg) => arg.value ?? arg.description).join(' ')
      console.error('[页面异常]', String(detail).slice(0, 400))
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log(`已截图 -> ${out}${failures.length ? `（页面异常 ${failures.length} 条，见上）` : ''}`)
    cdp.close()
  } finally {
    chrome.kill()
  }
}

main().catch((err) => {
  console.error('截图失败:', err.message)
  process.exit(1)
})
