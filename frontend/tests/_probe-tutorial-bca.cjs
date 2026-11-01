/**
 * 一次性核对：教程页「本平台的上界 vs 后端 BCA 的精确下界」那张表**真的渲染出来了**。
 *
 * 为什么单开一个：verify-pages 只做源码层正则（证明文案在 .vue 里），
 * 证明不了「Vue 渲染时不炸、数字真的出现在 DOM 上」。E2E 主套件不覆盖 /tutorial/。
 *
 *   NODE_PATH=<托管 workspace>/node_modules  <node> frontend/tests/_probe-tutorial-bca.cjs
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

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  console.log('\n【教程页 · BCA 精确下界对照表】')
  await page.goto(`${BASE}/tutorial/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  check('落在教程页（data-page=tutorial）',
    (await page.evaluate(() => document.getElementById('app')?.dataset.page)) === 'tutorial')

  const h2s = await page.locator('h2.section-title').allInnerTexts()
  check('有「上界 vs 精确下界」小节标题',
    h2s.some((t) => t.includes('精确下界')), h2s.join(' | '))

  // 定位到那张表：表头含「束搜索上界」+「SAT 精确下界」
  const table = page.locator('table').filter({ hasText: 'SAT 精确下界' }).first()
  check('对照表存在', await table.count() > 0)

  const rows = await table.locator('tbody tr').allInnerTexts()
  const norm = rows.map((r) => r.replace(/\s+/g, ' ').trim())
  console.log('     表格行：')
  norm.forEach((r) => console.log('       ' + r))

  check('8 行（1~8 轮）', norm.length === 8, String(norm.length))
  check('1~4 轮两列一致（0/0/0/6）',
    norm[0].includes('0.00') && norm[0].includes('0') &&
    norm[3].includes('6.00') && norm[3].includes('6'))
  check('第 5 轮分岔：30.00 vs 12.00',
    norm[4].includes('30.00') && norm[4].includes('12.00'))
  check('第 6 轮分岔：49.00 vs 12.00',
    norm[5].includes('49.00') && norm[5].includes('12.00'))

  const diffCells = await table.locator('td.cmp-diff').count()
  check('不一致的档位确实加了高亮（cmp-diff 类存在）', diffCells > 0, String(diffCells))

  // 留档截图（对照组：整张表 + 头两行说明一起入镜）
  const shot = process.env.CIPHER_BCA_SHOT
  if (shot) {
    const card = page.locator('.card').filter({ hasText: 'SAT 精确下界' }).first()
    await card.screenshot({ path: shot })
    console.log(`  · 截图已存 ${shot}`)
  }

  const bodyText = await page.locator('body').innerText()
  check('全文说明了「束搜索上界」不是全局最小',
    bodyText.includes('束搜索') && bodyText.includes('上界') && bodyText.includes('精确下界'))
  check('不再出现旧基准 687 / 2⁻⁴⁴ 作为当前值',
    !bodyText.includes('687') && !bodyText.includes('2⁻⁴⁴'))
  check('全程零控制台错误', errors.length === 0, errors.slice(0, 2).join(' | '))

  console.log('\n【/bca/ 页 · 精确下界口径】')
  await page.goto(`${BASE}/bca/`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  check('落在后端搜索页（data-page=bca）',
    (await page.evaluate(() => document.getElementById('app')?.dataset.page)) === 'bca')
  const bcaText = await page.locator('body').innerText()
  check('页头写明「精确下界 / 束搜索上界」的口径差',
    bcaText.includes('精确下界') && bcaText.includes('束搜索上界'))
  check('有一键预设「SM4 · 1–6 轮（精确下界对照）」',
    (await page.locator('button', { hasText: 'SM4 · 1–6 轮' }).count()) > 0)
  // 「按轮汇总」卡只在**有结果**时渲染（v-if="perRound.length"），所以首次进页面拿不到。
  // 源码层那条由 verify-pages 守着，这里只在真有结果时补一刀 DOM 验证。
  if ((await page.locator('h2', { hasText: '按轮汇总' }).count()) > 0) {
    check('「按轮汇总」表头标了「全空间精确下界」', bcaText.includes('全空间精确下界'))
  } else {
    console.log('  · 跳过「按轮汇总」表头断言（该卡片要有结果才渲染；源码层由 verify-pages 守）')
  }

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
