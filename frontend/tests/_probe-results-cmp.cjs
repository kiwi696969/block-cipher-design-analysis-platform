/**
 * 一次性核对：结果页「精度对照」卡**真的渲染出来了**，且复核链接落到 /bca/ 时表单被预填。
 *
 * 为什么单开一个：verify-pages 只做源码层正则（证明文案与常量在 .vue 里），
 * 证明不了「Vue 渲染时不炸、数字真的出现在 DOM 上」；E2E 主套件不覆盖这条链路。
 *
 * 覆盖三种档位：
 *   1–5 轮  → 分岔档（前端上界 > BCA 精确下界），要看到 ≥ 与两边数字
 *   1–4 轮  → 一致档（两侧相等），要看到「已打到最优」
 *   1–16 轮 → 超范围档，不许摆没核对过的对照数字，只给复核入口
 *
 *   NODE_PATH=<托管 workspace>/node_modules  <node> frontend/tests/_probe-results-cmp.cjs
 *   可选：CIPHER_CMP_SHOT=<路径.png> 留档截图
 */
const { chromium } = require('playwright-core')

const CHROME = process.env.CIPHER_CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.CIPHER_BASE || 'http://127.0.0.1:8011'

let pass = 0
const fails = []
function check(name, ok, got = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); return }
  fails.push(`${name}${got ? ` —— 实得: ${got}` : ''}`)
  console.log(`  ✗ ${name}${got ? ` —— 实得: ${got}` : ''}`)
}

async function waitText(page, src, timeout = 45000) {
  try {
    await page.waitForFunction(
      (s) => new RegExp(s).test(document.body.innerText), src, { timeout })
    return true
  } catch { return false }
}

/** 在差分页设轮数区间 → 跑一次 → 去结果页 */
async function runRounds(page, end) {
  await page.goto(`${BASE}/differential/`, { waitUntil: 'networkidle' })
  const input = page.locator('.field')
    .filter({ has: page.locator('label', { hasText: '结束轮' }) })
    .first().locator('input')
  await input.fill(String(end))
  await input.press('Tab')
  await page.waitForTimeout(250)
  await page.locator('button:has-text("运行分析")').first().click()
  await page.waitForTimeout(end <= 8 ? 1500 : 3000)
  await page.goto(`${BASE}/results/`, { waitUntil: 'networkidle' })
  return waitText(page, '累计权重')
}

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  /* ---------------------------------------------------------- 1–5 轮：分岔档 */
  console.log('\n【结果页 · 精度对照（1–5 轮：分岔档）】')
  const ran5 = await runRounds(page, 5)
  check('跑完并落到结果页（data-page=results）',
    (await page.evaluate(() => document.getElementById('app')?.dataset.page)) === 'results')
  check('结果页渲染出累计权重', ran5)

  const badge = await page.locator('.metric .m-badge').first().innerText().catch(() => '')
  check('权重数字旁挂「上界」徽标', badge.trim() === '上界', badge)

  const card = page.locator('.card-check').first()
  check('「精度对照」卡存在', await card.count() > 0)
  const cardText = await card.innerText().catch(() => '')
  const cardFlat = cardText.replace(/\s+/g, ' ').trim()
  console.log('     卡片文本：' + cardFlat.slice(0, 200))

  check('左列 = 本次实跑权重 30.00', cardFlat.includes('30.00'), cardFlat.slice(0, 80))
  check('右列 = BCA 精确下界 12.00', cardFlat.includes('12.00'))
  const op5 = (await card.locator('.cmp-op').innerText().catch(() => '')).trim()
  // ⚠️ 读运算符元素本身，不要在整卡文本里搜「≥」——
  //    说明文字里那句「第 4 轮必然 ≥1 活跃盒」会把断言带偏（踩过一次）。
  check('用 ≥ 连接（不是 =）', op5 === '≥', op5)
  check('标签点明「上界 ≠ 精确下界」', cardFlat.includes('上界 ≠ 精确下界'))
  check('说明文字点明「不是谁算错了」+ 根源在起点集合',
    cardFlat.includes('不是谁算错了') && cardFlat.includes('起点集合'))
  check('标注了默认参数下的记录值 30.00（口径可追溯）',
    cardFlat.includes('默认参数下本平台这一档为'))

  const href = await card.locator('a').first().getAttribute('href')
  check('复核链接带 SM4 / MAP / start=1 / end=5',
    /cipher=SM4/.test(href || '') && /model=MAP/.test(href || '')
    && /start=1/.test(href || '') && /end=5/.test(href || ''), href || '')
  const link2 = await card.locator('a').nth(1).getAttribute('href')
  check('第二个链接指向教程页完整对照表', /tutorial/.test(link2 || ''), link2 || '')

  const shot = process.env.CIPHER_CMP_SHOT
  if (shot) {
    await card.screenshot({ path: shot })
    console.log(`  · 截图已存 ${shot}`)
  }
  check('本段零控制台错误', errors.length === 0, errors.slice(0, 2).join(' | '))

  /* ---------------------------------------------------------- 链接落地：/bca/ 预填 */
  console.log('\n【复核链接落地 /bca/】')
  errors.length = 0
  await card.locator('a').first().click()
  await page.waitForURL('**/bca/**', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(900)
  check('落在后端搜索页（data-page=bca）',
    (await page.evaluate(() => document.getElementById('app')?.dataset.page)) === 'bca')
  check('URL 带着复核参数', /end=5/.test(page.url()), page.url())
  const bcaText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check('页头提示「参数已从链接带入」', bcaText.includes('参数已从链接带入'))
  const endVal = await page.locator('.field')
    .filter({ has: page.locator('label', { hasText: '结束轮' }) })
    .first().locator('input').inputValue().catch(() => '')
  console.log(`     结束轮输入框 = ${endVal || '(未渲染)'}`)
  if (endVal) check('结束轮被预填成 5', endVal === '5', endVal)
  else console.log('  · 跳过「结束轮预填」断言（参数面板未渲染 —— 后端不可用时属预期）')

  /* ---------------------------------------------------------- 1–4 轮：一致档 */
  console.log('\n【结果页 · 精度对照（1–4 轮：一致档）】')
  errors.length = 0
  await runRounds(page, 4)
  const card4Text = (await page.locator('.card-check').first().innerText().catch(() => ''))
    .replace(/\s+/g, ' ')
  console.log('     卡片文本：' + card4Text.slice(0, 160))
  check('1–4 轮标记为「已打到最优」', card4Text.includes('已打到最优'))
  const op4 = (await page.locator('.cmp-op').first().innerText().catch(() => '')).trim()
  check('用 = 连接（两侧相等）', op4 === '=', op4)
  check('两侧都是 6.00', (card4Text.match(/6\.00/g) || []).length >= 2)

  /* ---------------------------------------------------------- 1–16 轮：超范围档 */
  console.log('\n【结果页 · 超范围（1–16 轮）】')
  errors.length = 0
  await runRounds(page, 16)
  check('超范围时不渲染对照卡（不摆没核过的数字）',
    await page.locator('.card-check').count() === 0)
  const body16 = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  check('改为提示「超出已实测核对」并说明上界口径',
    body16.includes('超出已实测核对') && body16.includes('上界')
    && body16.includes('精确下界'), body16.slice(0, 160))

  check('全程零控制台错误', errors.length === 0, errors.slice(0, 3).join(' | '))

  await browser.close()

  console.log('\n' + '─'.repeat(60))
  if (fails.length) {
    console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`)
    for (const f of fails) console.log('   ✗ ' + f)
    process.exitCode = 1
  } else {
    console.log(`✓ 全部通过：${pass}/${pass} 项`)
  }
})()
