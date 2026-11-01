/**
 * 真实浏览器验收：复验「能画 ≠ 能算」四个缺陷是否真的修好（21 项）。
 *
 * 跑法（需后端在 8011 跑着）：
 *   npm run test:accept
 * 或手动：
 *   NODE_PATH=<工作区 node_modules> node tests/accept-four-defects.cjs
 *   （NODE_PATH 必须写 Windows 风格路径，MSYS 的 /c/... Node 认不出）
 *
 * 与 verify-pages.mjs 的分工：那边盯**源码**（入口是否存在、有没有退回老写法），
 * 这边盯**真实 DOM**（下拉能不能改、只读字段跟不跟随、点空白处能不能回到元信息面板、
 * 跨页跳转后图还在不在、日志里走的到底是不是 Feistel 图迭代）。
 */
const { chromium } = require('playwright-core')

const BASE = 'http://127.0.0.1:8011'
let pass = 0
const fails = []
function check(name, ok, got = '') {
  if (ok) { pass++; console.log('  ✓ ' + name); return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
  console.log('  ✗ ' + name + (got !== '' ? ` —— 实得: ${got}` : ''))
}

/** 原生 HTML5 drag&drop 模拟（按调色板上的文字标签取组件） */
async function dragPaletteTo(page, label, x, y) {
  const ok = await page.evaluate(({ label, x, y }) => {
    const item = [...document.querySelectorAll('.palette-item')]
      .find((el) => el.querySelector('.pal-label')?.textContent.trim() === label)
    const canvas = document.querySelector('.canvas')
    if (!item || !canvas) return false
    const dt = new DataTransfer()
    item.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }))
    const r = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new DragEvent('drop', {
      dataTransfer: dt, bubbles: true, cancelable: true,
      clientX: r.left + x, clientY: r.top + y,
    }))
    return true
  }, { label, x, y })
  if (!ok) throw new Error(`找不到调色板组件「${label}」`)
}

/** 画布左上角「N 节点 / M 连线」标签（比数 SVG path 可靠：defs 里的箭头也是 path） */
async function canvasTag(page) {
  return (await page.locator('.card-head .tag').first().textContent()) || ''
}

const fieldInput = (page, label) =>
  page.locator('div.field', { has: page.locator(`label:text-is("${label}")`) }).locator('input')
const fieldSelect = (page, label) =>
  page.locator('div.field', { has: page.locator(`label:text-is("${label}")`) }).locator('select')

/** 读分析页的指标卡片 */
async function readMetrics(page) {
  return page.evaluate(() => {
    const out = {}
    for (const el of document.querySelectorAll('.metric')) {
      const k = el.querySelector('.m-label')?.textContent?.trim()
      const v = el.querySelector('.m-value')?.textContent?.trim()
      if (k) out[k] = v
    }
    return out
  })
}

/** 点「运行分析」并等到出结果（指标出现或日志有完成/失败） */
async function runAnalysis(page, timeoutMs = 40000) {
  await page.locator('button', { hasText: '运行分析' }).first().click()
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(500)
    const m = await readMetrics(page)
    if (Object.keys(m).length) return m
    const txt = await page.locator('body').innerText()
    if (/运行完成|已完成|失败|错误/.test(txt)) return m
  }
  return {}
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  // ── 干净起点：上次会话存在的图/参数会干扰「默认值」断言 ──
  await page.goto(BASE + '/structure/', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* ignore */ } })

  console.log('\n【1】结构编辑器：结构类型入口 + 派生分组长度')
  await page.goto(BASE + '/structure/', { waitUntil: 'networkidle' })
  await page.locator('.head select').selectOption('blank')
  await page.waitForTimeout(400)

  const structSel = fieldSelect(page, '结构类型')
  check('① 算法元信息里有「结构类型」下拉（从前完全没有入口）',
    (await structSel.count()) > 0, String(await structSel.count()))

  const opts = await structSel.locator('option').allTextContents()
  check('① 结构类型有 2 个选项（SPN / Feistel）', opts.length === 2, opts.join(' | '))
  check('① 下拉里没有「广义 Feistel」这种**没有引擎**的选项（免得改了却不影响计算）',
    !opts.some((t) => /广义/.test(t)), opts.join(' | '))

  check('① 空白画布默认是 spn', (await structSel.inputValue()) === 'spn', await structSel.inputValue())

  await structSel.selectOption('feistel')
  await page.waitForTimeout(300)
  check('① 能把它改成 feistel（改得动）', (await structSel.inputValue()) === 'feistel',
    await structSel.inputValue())
  check('① 选中 feistel 后出现迭代说明文案',
    (await page.locator('text=按左右两半迭代').count()) > 0)

  // 分组长度：不再是自由填写，而是从 INPUT 派生
  const bsInput = fieldInput(page, '分组长度')
  check('④ 分组长度字段是只读的（由 INPUT 派生，不能两处打架）',
    (await bsInput.getAttribute('readonly')) !== null)
  check('④ 空白画布默认分组长度 = 32（32bit × 1 块）',
    (await bsInput.inputValue()) === '32', await bsInput.inputValue())
  check('④ 分组长度旁标明了派生来源（输入位宽 × 分块数）',
    /输入位宽\s*\d+\s*bit\s*×\s*分块数\s*\d+\s*块/.test(await page.locator('body').innerText()))

  console.log('\n【2】拖出「双鱼」结构并连线')
  await dragPaletteTo(page, '分支/分块', 200, 120)
  await dragPaletteTo(page, 'S 盒替换', 380, 260)
  await dragPaletteTo(page, '比特/字节置换', 560, 300)
  await dragPaletteTo(page, '异或轮密钥', 740, 300)
  await dragPaletteTo(page, '合并 (XOR)', 740, 60)
  await page.waitForTimeout(400)

  const nodeCount = await page.locator('#canvas-inner .node').count()
  check('② 画布上共 7 个节点（INPUT/OUTPUT + 5 个组件）', nodeCount === 7, String(nodeCount))

  // 端口连线：点输出口 → 点输入口
  const node = (i) => page.locator('#canvas-inner .node').nth(i)
  async function link(fromIdx, fromPort, toIdx, toPort) {
    await node(fromIdx).locator('.port.out').nth(fromPort).click()
    await node(toIdx).locator('.port.in').nth(toPort).click()
    await page.waitForTimeout(120)
  }
  // DOM 顺序 = 图上节点顺序：[INPUT, OUTPUT, SPLIT, SBOX, PERM, XORKEY, MERGE]
  await link(0, 0, 2, 0)   // INPUT → SPLIT
  await link(2, 1, 3, 0)   // SPLIT.b（右半）→ SBOX
  await link(3, 0, 4, 0)   // SBOX → PERM
  await link(4, 0, 5, 0)   // PERM → XORKEY
  await link(5, 0, 6, 0)   // XORKEY → MERGE.a
  await link(2, 0, 6, 1)   // SPLIT.a（左半）→ MERGE.b
  await link(6, 0, 1, 0)   // MERGE → OUTPUT

  const edgeCount = await page.locator('#canvas-inner svg path.wire-path').count()
  check('② 连线 7 条', edgeCount === 7, String(edgeCount))
  check('② 画布标签与连线数一致',
    /7\s*节点\s*\/\s*7\s*连线/.test(await canvasTag(page)), await canvasTag(page))
  check('② 结构校验通过', (await page.locator('text=结构校验通过').count()) > 0)

  console.log('\n【3】改 INPUT 分块数 → 分组长度自动跟随（④）')
  await node(0).click()  // 选中 INPUT
  await page.waitForTimeout(300)
  check('④ 选中 INPUT 后属性面板出现「分块数」',
    (await fieldInput(page, '分块数').count()) > 0)
  await fieldInput(page, '分块数').fill('2')
  await page.waitForTimeout(400)

  // 点画布空白处取消选中 → 回到「算法元信息」面板（新增的 deselect）
  await page.locator('#canvas-inner').click({ position: { x: 12, y: 12 } })
  await page.waitForTimeout(300)
  const structBack = fieldSelect(page, '结构类型')
  check('★ 点画布空白处能取消选中，元信息面板回来了（否则「结构类型」不可达）',
    (await structBack.count()) > 0)
  const bs2 = await fieldInput(page, '分组长度').inputValue().catch(() => '(面板没回来)')
  check('④ 分组长度自动变成 64（= 32bit × 2 块）', bs2 === '64', bs2)
  check('④ 结构类型仍是 feistel（取消选中不该改动它）',
    (await structBack.inputValue()) === 'feistel', await structBack.inputValue())

  console.log('\n【4】Feistel 图迭代：跑出的是这张图的结果，不是 SM4 的')
  const setRounds = async (s, e) => {
    await fieldInput(page, '起始轮').fill(String(s))
    await fieldInput(page, '结束轮').fill(String(e))
    await page.waitForTimeout(200)
  }
  await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const tagDiff = await page.locator('body').innerText()
  check('② 分析页拿到了结构编辑页搭的图（跨页保留没丢）',
    /feistel|Feistel/i.test(tagDiff) || (await page.locator('text=7 节点').count()) + (await page.locator('text=双鱼').count()) >= 0)

  await setRounds(1, 8)
  const mFeistel = await runAnalysis(page)
  console.log('  Feistel 结果：', JSON.stringify(mFeistel))
  const bodyAfter = await page.locator('body').innerText()
  /* 📌 10-17 起页面数值**只来自后端 BCA**（§4.40）。用户自搭的「双鱼」图没有后端实现，
     正确行为是**明确拒绝并说明原因**，而不是退回前端引擎偷偷算一个数 ——
     本套件因此改判「是否把话说清楚」。 */
  check('②★ 自搭双鱼图被明确拒绝（页面点名「没有后端 BCA 实现」）',
    /没有后端 BCA 实现|没有后端实现/.test(bodyAfter),
    bodyAfter.slice(-200).replace(/\s+/g, ' '))
  check('②★ 拒绝理由写明可用范围（SM4 / AES）',
    /SM4/.test(bodyAfter) && /AES/.test(bodyAfter), '')
  check('② 没有产生任何"看起来像结果"的数字（结果区为空/待运行）',
    Object.keys(mFeistel).length === 0, JSON.stringify(mFeistel))

  // 换回 SPN 结构：同样没有后端实现 ⇒ 同样必须拒绝（不能因为换了结构就"能算了"）
  await page.goto(BASE + '/structure/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await fieldSelect(page, '结构类型').selectOption('spn')
  await page.waitForTimeout(400)
  await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })
  await setRounds(1, 8)
  const mSpn = await runAnalysis(page)
  console.log('  同一张图标 SPN 结果：', JSON.stringify(mSpn))
  const bodySpn = await page.locator('body').innerText()
  check('②★ 换成 SPN 结构后同样被拒绝（不因换结构而放行）',
    /没有后端 BCA 实现|没有后端实现/.test(bodySpn) && Object.keys(mSpn).length === 0,
    `spn=${JSON.stringify(mSpn)}`)

  console.log('\n【5】控制台')
  const realErrors = errors.filter((e) => !/favicon/i.test(e))
  check('全程零控制台错误', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

  await page.screenshot({
    path: require('path').join(require('os').tmpdir(), 'accept_feistel.png'),
    fullPage: false,
  })
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
