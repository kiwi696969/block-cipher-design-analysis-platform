/**
 * 临时探针：对比栏的**渲染**（注入快照，不跑求解）。
 *
 * 为什么要注入：改成「后端 BCA 精确求解」之后，Windows 上的 Django 跑不动
 * SM4/AES 分析（BCA 只能在 Linux 里跑），所以点「运行分析」这条路在本机
 * 验证不了。这里用真的 `snapshotOf()` 造快照塞进 sessionStorage，
 * 专门验渲染层：表格 / 行列 / 口径提示 / 曲线 / 悬停 / 移除。
 */
const path = require('path')
const { chromium } = require('playwright-core')

const BASE = process.env.CIPHER_BASE || 'http://127.0.0.1:8012'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SHOT = process.env.TEMP || '.'
const log = (s) => console.log(s)

;(async () => {
  const { SBoxLibrary } = await import('../src/core/sboxlib.js')
  new SBoxLibrary()
  const { TEMPLATES } = await import('../src/core/graph.js')
  const { snapshotOf } = await import('../src/core/compare.js')

  const mk = (start, end, weight, extra = {}) => {
    const rounds = end - start + 1
    const perRound = []
    for (let r = start; r <= end; r++) {
      perRound.push({
        round: r,
        weight: (weight / rounds) * (r - start + 1),
        roundWeight: weight / rounds,
        activeSboxes: 4,
        cumActive: 4 * (r - start + 1),
      })
    }
    return {
      at: Date.now(),
      mode: 'differential',
      params: {
        mode: 'differential', model: 'weight', beamWidth: 8, branchLimit: 0,
        engine: extra.engine || 'sm4', startRound: start, endRound: end,
      },
      metrics: {
        startRound: start, endRound: end, rounds,
        weight, bitsPerRound: weight / rounds,
        activeSboxes: 4 * rounds, activePerRound: 4, elapsedMs: 12,
      },
      char: { mode: 'differential' },
      perRound,
      backend: extra.backend || null,
    }
  }

  const sm4 = TEMPLATES.sm4.build()
  const aes = TEMPLATES.aes.build()

  const snaps = [
    // #1 旧口径：浏览器束搜索上界
    snapshotOf({ graph: sm4, templateId: 'sm4', result: mk(1, 4, 6) }),
    // #2 后端精确值
    snapshotOf({
      graph: aes, templateId: 'aes',
      result: mk(1, 4, 217, {
        engine: 'aes',
        backend: { complete: true, solvedThrough: 4, pendingRounds: [], task: { cipher: 'AES' } },
      }),
    }),
    // #3 后端部分求解
    snapshotOf({
      graph: sm4, templateId: 'sm4',
      result: mk(1, 2, 12, {
        backend: { complete: false, solvedThrough: 2, pendingRounds: [3, 4], task: { cipher: 'SM4' } },
      }),
    }),
  ]
  log('注入快照: ' + snaps.map((s) => `${s.structureName}/${s.sourceLabel}/${s.weight}`).join(' | '))

  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } })
  const errs = []
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })

  await page.goto(BASE + '/results/', { waitUntil: 'networkidle' })
  await page.evaluate((items) => {
    sessionStorage.setItem('cda_compare', JSON.stringify({ v: 1, items }))
  }, snaps)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)

  log('---- 并对表 ----')
  log(await page.locator('.cmp-table').first().innerText().catch(() => '(无表)'))
  log('---- 口径提示 ----')
  log(((await page.locator('.cmp-notes').first().innerText().catch(() => '')) || '').replace(/\n/g, ' ⏎ '))
  log('---- 结构差异 ----')
  log(await page.locator('.cmp-diffs').first().innerText().catch(() => '(无)'))
  log('曲线条数: ' + await page.locator('.cmp-chart path.c-line').count())
  log('表头列数: ' + await page.locator('.cmp-table thead th').count())
  log('移除按钮: ' + await page.locator('button.cmp-x').count())

  const card = page.locator('.card', { has: page.locator('.cmp-table') }).first()
  await card.scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)

  // 表格是否真的被裁掉了行？（截图被 viewport 切断 ≠ 页面裁掉了内容）
  const box = await card.boundingBox()
  const scroll = await page.locator('.cmp-table').first().evaluate((t) => {
    const wrap = t.parentElement
    return {
      rows: t.querySelectorAll('tbody tr').length,
      wrapScroll: wrap.scrollHeight, wrapClient: wrap.clientHeight,
      tableH: t.getBoundingClientRect().height,
    }
  })
  log(`卡片高 ${Math.round(box.height)}px；表格 ${scroll.rows} 行 / 高 ${Math.round(scroll.tableH)}px；`
    + `滚动容器 ${scroll.wrapClient}px（内容 ${scroll.wrapScroll}px）`)

  const chart = page.locator('.cmp-chart svg').first()
  await chart.scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
  const cbox = await chart.boundingBox()
  if (cbox) {
    await page.mouse.move(cbox.x + cbox.width * 0.55, cbox.y + cbox.height * 0.5)
    await page.waitForTimeout(300)
    log('悬停读数: ' + (await page.locator('.cmp-chart .readout').first().innerText().catch(() => '(无)')).replace(/\n/g, ' '))
  }

  const rect = await card.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }
  })
  await page.screenshot({ path: path.join(SHOT, 'probe_compare_card.png'), fullPage: true, clip: rect })
  log('卡片截图: ' + path.join(SHOT, 'probe_compare_card.png'))

  // 移除一项 → 仍能渲染
  await page.locator('button.cmp-x').first().click()
  await page.waitForTimeout(500)
  log('移除后列数: ' + await page.locator('.cmp-table thead th').count())
  log('移除后提示条数变化见日志')

  log('页面错误: ' + (errs.length ? errs.join(' ;; ') : '无'))
  await browser.close()
  if (errs.length) process.exitCode = 1
})().catch((e) => { console.error('PROBE FAILED', e); process.exit(1) })
