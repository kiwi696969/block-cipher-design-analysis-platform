/**
 * 临时探针：对比栏在真实浏览器里的完整路径。
 * 用法（项目根目录）：
 *   NODE_PATH=<managed workspace>/node_modules node frontend/tests/_probe-compare.cjs
 * 需要后端跑在 CIPHER_BASE（默认 8012）。
 */
const path = require('path')
const { chromium } = require('playwright-core')

const BASE = process.env.CIPHER_BASE || 'http://127.0.0.1:8012'
const CHROME = process.env.CIPHER_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SHOT = process.env.CIPHER_SHOT_DIR || process.env.TEMP || 'C:\\Users\\huawei\\AppData\\Local\\Temp'

const out = []
const log = (s) => { out.push(s); console.log(s) }

async function waitResult(page, ms = 120000) {
  await page.waitForFunction(() => {
    try {
      const d = JSON.parse(sessionStorage.getItem('cda_session') || 'null')
      return !!(d && d.result && d.result.metrics)
    } catch { return false }
  }, { timeout: ms })
}

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errs = []
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })

  // ---- 1. SM4 4 轮 ----
  await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })
  await page.fill('input[type=number] >> nth=1', '4')
  await page.waitForTimeout(300)
  await page.locator('button:has-text("运行分析")').first().click()
  await waitResult(page, 60000)
  log('SM4 4 轮完成')

  await page.goto(BASE + '/results/', { waitUntil: 'networkidle' })
  await page.locator('button:has-text("加入对比栏")').first().click()
  await page.waitForTimeout(500)
  let t = await page.locator('.cmp-table').first().innerText().catch(() => '')
  log('加入 #1 后表格首列: ' + t.split('\n').slice(0, 4).join(' | '))

  // ---- 2. 换 AES 模板，4 轮 ----
  await page.goto(BASE + '/ciphers/', { waitUntil: 'networkidle' })
  await page.locator('.tpl', { hasText: 'AES-128' }).first().click()
  await page.waitForURL('**/structure/', { timeout: 30000 }).catch(() => {})
  await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })
  await page.fill('input[type=number] >> nth=1', '4')
  await page.waitForTimeout(300)
  await page.locator('button:has-text("运行分析")').first().click()
  await waitResult(page, 60000)
  log('AES 4 轮完成')

  await page.goto(BASE + '/results/', { waitUntil: 'networkidle' })
  await page.locator('button:has-text("加入对比栏")').first().click()
  await page.waitForTimeout(800)

  t = await page.locator('.cmp-table').first().innerText().catch(() => '')
  log('---- 对比表 ----')
  log(t)
  log('---- 口径提示 ----')
  log((await page.locator('.cmp-notes').first().innerText().catch(() => '')).replace(/\n/g, ' ⏎ '))
  log('---- 结构差异 ----')
  log(await page.locator('.cmp-diffs').first().innerText().catch(() => '(无)'))
  const paths = await page.locator('.cmp-chart path.c-line').count()
  log('曲线条数: ' + paths)
  const dots = await page.locator('button.cmp-x').count()
  log('移除按钮数: ' + dots)

  // 悬停读数
  const chart = page.locator('.cmp-chart svg').first()
  const box = await chart.boundingBox()
  if (box) {
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5)
    await page.waitForTimeout(300)
    log('悬停读数: ' + (await page.locator('.cmp-chart .readout').first().innerText().catch(() => '(无)')).replace(/\n/g, ' '))
  }

  const card = page.locator('.card', { has: page.locator('.cmp-table') }).first()
  await card.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await card.screenshot({ path: path.join(SHOT, 'probe_compare_card.png') })
  log('卡片截图: ' + path.join(SHOT, 'probe_compare_card.png'))
  await page.screenshot({ path: path.join(SHOT, 'probe_compare.png'), fullPage: false })

  // ---- 3. 刷新后仍在？ ----
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const after = await page.locator('.cmp-table').count()
  log('刷新后对比表还在: ' + (after > 0))

  // ---- 4. 移除一项 ----
  if (dots > 0) {
    await page.locator('button.cmp-x').first().click()
    await page.waitForTimeout(500)
    log('移除一项后列数: ' + (await page.locator('.cmp-table thead th').count()))
  }

  log('页面错误: ' + (errs.length ? errs.join(' ;; ') : '无'))
  await browser.close()
  if (errs.length) process.exitCode = 1
})().catch((e) => { console.error('PROBE FAILED', e); process.exit(1) })
