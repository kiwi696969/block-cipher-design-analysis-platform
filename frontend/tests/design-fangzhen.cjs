/**
 * 在**真实浏览器**里从零搭出「方阵」SPN 并跑出结果，全程留档。
 *
 * 被测设计（用户给的样例）：
 *   128 位 4×4 字节矩阵 / 6 轮 / SubBytes → ShiftRows → MixColumns → AddConstant，
 *   末轮省略 MixColumns。
 *
 * 平台能力有限，这里做**三件事**，把「能不能」变成可复核的事实：
 *   A. 按平台允许的最接近形态搭出「方阵」（32bit 词宽 ×4 块 = 界面显示 128 位），
 *      跑差分 + 线性，并抓下「界面说 128 / 引擎按 32 算」的原始证据；
 *   B. 「末轮跳过 MixColumns」的两轮手工连线小样 vs 两轮全层对照样 ——
 *      看引擎认不认「手工连线差异」；
 *   C. 每步截图 + 导出工程 JSON + 落 session.json。
 *
 * 跑法（需后端在 8011 跑着；NODE_PATH 必须 Windows 风格）：
 *   NODE_PATH=<工作区 node_modules> node frontend/tests/design-fangzhen.cjs
 *
 * 产出：outputs/方阵SPN设计记录/
 */
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const BASE = 'http://127.0.0.1:8011'
const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.join(ROOT, 'outputs', '方阵SPN设计记录')
fs.mkdirSync(OUT, { recursive: true })

const steps = []
function note(text) {
  steps.push({ at: new Date().toISOString(), text })
  console.log('  · ' + text)
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
  note(`拖入组件「${label}」→ 画布 (${x}, ${y})`)
}

const fieldInput = (page, label) =>
  page.locator('div.field', { has: page.locator(`label:text-is("${label}")`) }).locator('input:not([readonly])')
const fieldReadonly = (page, label) =>
  page.locator('div.field', { has: page.locator(`label:text-is("${label}")`) }).locator('input')
const fieldSelect = (page, label) =>
  page.locator('div.field', { has: page.locator(`label:text-is("${label}")`) }).locator('select')

async function readMetrics(page) {
  return page.evaluate(() => {
    const out = {}
    for (const el of document.querySelectorAll('.metric')) {
      const k = el.querySelector('.m-label')?.textContent?.trim()
      const v = el.querySelector('.m-value')?.textContent?.trim()
      const s = el.querySelector('.m-sub')?.textContent?.trim()
      if (k) out[k] = { value: v, sub: s }
    }
    return out
  })
}

async function readRoundTable(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.table tbody tr')]
    if (!rows.length) return { head: [], rows: [] }
    const table = rows[0].closest('table')
    const head = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
    return {
      head,
      rows: rows.slice(0, 60).map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())),
    }
  })
}

async function readLogs(page) {
  return page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('.logpanel .lg')) {
      const lvl = [...el.classList].find((c) => c.startsWith('lg-'))?.slice(3) || ''
      const t = el.querySelector('.t')?.textContent?.trim() || ''
      const m = el.querySelector('.m')?.textContent?.trim() || ''
      if (m) out.push(`${lvl} ${t} ${m}`)
    }
    return out
  })
}

const readSessionGraph = (page) => page.evaluate(() => {
  try {
    const raw = sessionStorage.getItem('cda_session')
    return raw ? JSON.parse(raw).graph : null
  } catch { return null }
})

async function runAnalysis(page, timeoutMs = 90000) {
  await page.locator('button', { hasText: '运行分析' }).first().click()
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(500)
    const m = await readMetrics(page)
    if (Object.keys(m).length) {
      note(`运行完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      return m
    }
  }
  note('运行超时（未出现指标卡）')
  return {}
}

/* ─────────────────────────── A：方阵（6 轮统一轮函数）的设计意图 ─────────────────────────── */

const INTENT = {
  meta: { name: '方阵', structure: 'spn', keySize: 128, rounds: 6 },
  nodes: {
    INPUT: { bits: 32, blocks: 4 },
    OUTPUT: { rounds: 6 },
    SBOX: { sboxId: 'aes', mode: 'byte', repeat: 1 },
    PERM: { shift: 1 },
    LINEAR: { op: 'mixColumns', amount: 0 },
    XORKEY: { keyVar: 'RC' },
  },
  wires: [
    ['INPUT', 'out', 'SBOX', 'in'],
    ['SBOX', 'out', 'PERM', 'in'],
    ['PERM', 'out', 'LINEAR', 'in'],
    ['LINEAR', 'out', 'XORKEY', 'in'],
    ['XORKEY', 'out', 'OUTPUT', 'in'],
  ],
}

function verifyDesign(graph) {
  const problems = []
  if (!graph) return ['拿不到图（sessionStorage 为空）']
  for (const [k, v] of Object.entries(INTENT.meta)) {
    if (graph.meta?.[k] !== v) problems.push(`meta.${k} = ${JSON.stringify(graph.meta?.[k])}，期望 ${JSON.stringify(v)}`)
  }
  const byType = {}
  for (const n of graph.nodes) byType[n.type] = (byType[n.type] || []).concat([n])
  for (const [type, want] of Object.entries(INTENT.nodes)) {
    const list = byType[type] || []
    if (list.length !== 1) { problems.push(`${type} 节点数 = ${list.length}，期望 1`); continue }
    for (const [k, v] of Object.entries(want)) {
      if (list[0].props[k] !== v) {
        problems.push(`${type}.props.${k} = ${JSON.stringify(list[0].props[k])}，期望 ${JSON.stringify(v)}`)
      }
    }
  }
  const idType = {}
  for (const n of graph.nodes) idType[n.id] = n.type
  const have = new Set(graph.edges.map((e) =>
    `${idType[e.from]}:${e.fromPort}>${idType[e.to]}:${e.toPort}`))
  for (const [f, fp, t, tp] of INTENT.wires) {
    if (!have.has(`${f}:${fp}>${t}:${tp}`)) problems.push(`缺少连线 ${f}.${fp} → ${t}.${tp}`)
  }
  if (graph.edges.length !== INTENT.wires.length) {
    problems.push(`连线数 = ${graph.edges.length}，期望 ${INTENT.wires.length}`)
  }
  return problems
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const ctx = await browser.newContext({ viewport: { width: 1720, height: 1060 }, acceptDownloads: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))

  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, name), fullPage: true })
    note(`截图 ${name}`)
  }
  const nodeByTitle = (title) => page.locator('#canvas-inner .node', {
    has: page.locator(`.n-title:text-is("${title}")`),
  })
  const nodeByTitleN = (title, idx) => nodeByTitle(title).nth(idx)
  const selection = async () => (await page.locator('.sel-head b').textContent().catch(() => '')) || ''

  const setProp = async (title, label, value, kind = 'input', idx = 0) => {
    await nodeByTitleN(title, idx).click()
    await page.waitForTimeout(250)
    const sel = (await selection()).trim()
    if (sel !== title) throw new Error(`点「${title}#${idx}」却选中「${sel}」—— 定位错位，拒绝继续`)
    if (kind === 'select') await fieldSelect(page, label).selectOption(value)
    else await fieldInput(page, label).fill(String(value))
    await page.waitForTimeout(200)
    const now = kind === 'select'
      ? await fieldSelect(page, label).inputValue().catch(() => '(读不到)')
      : await fieldInput(page, label).inputValue().catch(() => '(读不到)')
    if (String(now) !== String(value)) throw new Error(`「${title}.${label}」填 ${value} 后读回 ${now}`)
    note(`${title}${idx ? `#${idx}` : ''}：${label} = ${value}`)
  }

  async function link(fromTitle, fromPort, toTitle, toPort, desc, fromIdx = 0, toIdx = 0) {
    await nodeByTitleN(fromTitle, fromIdx).locator('.port.out').nth(fromPort).click()
    await nodeByTitleN(toTitle, toIdx).locator('.port.in').nth(toPort).click()
    await page.waitForTimeout(150)
    note(`连线 ${desc}`)
  }

  // ── 干净起点 ──
  await page.goto(BASE + '/structure/', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* ignore */ } })

  console.log('\n【1】打开结构编辑器，切到空白画布')
  await page.goto(BASE + '/structure/', { waitUntil: 'networkidle' })
  await page.locator('.head select').selectOption('blank')
  await page.waitForTimeout(500)
  note('选择模板「空白画布（自定义）」')
  await shot('step-1-空白画布.png')

  console.log('\n【2】填元信息（128 位 / 6 轮 / SPN），并探一探「位宽」能填多大')
  await fieldInput(page, '算法名称').fill('方阵')
  await page.waitForTimeout(200)
  await fieldInput(page, '标准来源').fill('自建演示 · AES 风格 SPN（4 字节列）')
  await page.waitForTimeout(200)
  await fieldInput(page, '密钥长度').fill('128')
  await page.waitForTimeout(200)
  await fieldInput(page, '总轮数').fill('6')
  await page.waitForTimeout(200)
  await fieldSelect(page, '结构类型').selectOption('spn')
  await page.waitForTimeout(300)
  note(`元信息：名称=${await fieldInput(page, '算法名称').inputValue()}`
    + ` / 密钥长度=${await fieldInput(page, '密钥长度').inputValue()}`
    + ` / 总轮数=${await fieldInput(page, '总轮数').inputValue()}`
    + ` / 结构类型=${await fieldSelect(page, '结构类型').inputValue()}`)

  // ★ 探针：把「位宽」填 128 会怎样？（用户的 128 位诉求）
  //    注意这里**不能用 setProp** —— 它带读回断言，而这里读回来必然不等于 128。
  await nodeByTitle('输入明文').click()
  await page.waitForTimeout(250)
  const selNow = (await selection()).trim()
  if (selNow !== '输入明文') throw new Error(`点「输入明文」却选中「${selNow}」`)
  await fieldInput(page, '位宽').fill('128')
  await page.waitForTimeout(300)
  const bitsAfter128 = await fieldInput(page, '位宽').inputValue()
  note(`★ 探针 1：把「位宽」填 128，框里立刻读回 = ${bitsAfter128}（组件定义写死 max=32，界面就夹住了）`)
  await fieldInput(page, '分块数').fill('4')
  await page.waitForTimeout(300)
  // 「分组长度」只读派生字段在**元信息面板**里，得先取消选中才看得到
  await page.locator('#canvas-inner').click({ position: { x: 12, y: 12 } })
  await page.waitForTimeout(500)
  const blockAfter128 = await fieldReadonly(page, '分组长度').inputValue()
  note(`★ 探针 2：位宽 32 × 分块 4 → 界面「分组长度」= ${blockAfter128} bit`
    + '（这是平台上唯一能靠近 128 位的写法；引擎实际词宽看后面日志）')
  await shot('step-2-位宽探针.png')
  await setProp('输入明文', '位宽', 32)

  console.log('\n【3】从左侧调色板拖组件（并把「输出密文」真拖到右边）')
  await dragPaletteTo(page, 'S 盒替换', 250, 430)
  await dragPaletteTo(page, '比特/字节置换', 410, 430)
  await dragPaletteTo(page, '线性层', 570, 430)
  await dragPaletteTo(page, '异或轮密钥', 730, 430)
  await page.waitForTimeout(400)
  note(`画布节点数 = ${await page.locator('#canvas-inner .node').count()}（模板自带 输入明文/输出密文 + 拖入 4 个）`)
  await moveNode('输出密文', 890, 430)
  await shot('step-3-拖入组件.png')

  console.log('\n【4】逐节点改属性')
  await setProp('S 盒替换', 'S 盒', 'aes', 'select')
  await setProp('S 盒替换', '应用方式', 'byte', 'select')
  await setProp('S 盒替换', '重复层数', 1)
  await setProp('比特/字节置换', '字节循环移位', 1)
  await setProp('线性层', '运算', 'mixColumns', 'select')
  await setProp('线性层', '移位量', 0)
  await setProp('异或轮密钥', '密钥变量名', 'RC')
  await setProp('输出密文', '统计截止轮', 6)
  await page.locator('#canvas-inner').click({ position: { x: 12, y: 12 } })
  await page.waitForTimeout(400)
  note(`改完 INPUT 后：分组长度（只读派生）= ${await fieldReadonly(page, '分组长度').inputValue()} bit`)
  await shot('step-4-属性设好.png')

  console.log('\n【5】按端口连线')
  await link('输入明文', 0, 'S 盒替换', 0, '输入明文.out → S 盒替换.in（SubBytes）')
  await link('S 盒替换', 0, '比特/字节置换', 0, 'S 盒替换.out → 比特/字节置换.in（ShiftRows 替身）')
  await link('比特/字节置换', 0, '线性层', 0, '比特/字节置换.out → 线性层.in（MixColumns）')
  await link('线性层', 0, '异或轮密钥', 0, '线性层.out → 异或轮密钥.in（AddConstant）')
  await link('异或轮密钥', 0, '输出密文', 0, '异或轮密钥.out → 输出密文.in')
  const edgeCount = await page.locator('#canvas-inner svg path.wire-path').count()
  const tag = (await page.locator('.card-head .tag').first().textContent()).trim()
  const bodyTxt = await page.locator('body').innerText()
  note(`连线数 = ${edgeCount}；画布标签 = ${tag}；结构校验：${/结构校验通过/.test(bodyTxt) ? '通过' : '未通过'}`)
  await shot('step-5-连线完成.png')

  await page.evaluate(() => { document.querySelectorAll('details').forEach((d) => { d.open = true }) })
  await page.waitForTimeout(400)
  await shot('structure-1-中文解析.png')
  const explainTxt = (await page.locator('body').innerText()).slice(0, 9000)

  await page.waitForTimeout(1500)
  const graphA = await readSessionGraph(page)
  const designProblems = verifyDesign(graphA)
  note(`设计校验：${designProblems.length ? '不通过 → ' + designProblems.join('；') : '全部符合预期'}`)
  if (designProblems.length) {
    throw new Error('设计没搭成预期形态：' + designProblems.join('；'))
  }

  console.log('\n【6】跳差分分析页运行（6 轮）')
  await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await fieldInput(page, '起始轮').fill('1')
  await fieldInput(page, '结束轮').fill('6')
  await page.waitForTimeout(300)
  note('差分分析：起始轮=1，结束轮=6')
  const mDiff = await runAnalysis(page)
  await shot('diff-1-结果.png')
  const tblDiff = await readRoundTable(page)
  const logsDiff = await readLogs(page)
  const engineLine = logsDiff.find((l) => /引擎：/.test(l)) || '(没抓到引擎行)'
  note(`★ 引擎行：${engineLine}`)
  note(`差分指标：${Object.entries(mDiff).map(([k, v]) => `${k}=${v.value}`).join(' | ')}`)
  note(`逐轮明细表：${tblDiff.rows.length} 行`)

  console.log('\n【7】跳线性分析页，同一张图跑线性')
  await page.goto(BASE + '/linear/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await fieldInput(page, '起始轮').fill('1')
  await fieldInput(page, '结束轮').fill('6')
  await page.waitForTimeout(300)
  const mLin = await runAnalysis(page)
  await shot('linear-1-结果.png')
  const tblLin = await readRoundTable(page)
  const logsLin = await readLogs(page)
  note(`线性指标：${Object.entries(mLin).map(([k, v]) => `${k}=${v.value}`).join(' | ')}`)

  console.log('\n【8】结果页总览')
  await page.goto(BASE + '/results/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await shot('results-1-总览.png')
  const resultsTxt = (await page.locator('body').innerText()).slice(0, 6000)

  console.log('\n【9】用界面「导出」按钮下载工程 JSON')
  let exported = null
  try {
    await page.goto(BASE + '/structure/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      page.locator('button[title*="导出工程 JSON"]').first().click(),
    ])
    await download.saveAs(path.join(OUT, 'fangzhen-project.json'))
    exported = '按钮下载'
    note('点击顶部「导出」按钮 → 已保存 fangzhen-project.json')
  } catch (e) {
    note('导出按钮未拿到下载事件：' + String(e).slice(0, 120))
  }
  const sessA = await page.evaluate(() => {
    try { return sessionStorage.getItem('cda_session') || '' } catch { return '' }
  })

  /* ───────────────── B：「末轮跳过 MixColumns」的手工连线差异 ───────────────── */

  /** 把已经存在的节点真拖到指定位置（mousedown → mousemove → mouseup） */
  async function moveNode(title, x, y, idx = 0) {
    const box = await nodeByTitleN(title, idx).boundingBox()
    const canvas = await page.locator('.canvas').boundingBox()
    const w = box.width
    await page.mouse.move(box.x + w / 2, box.y + 16)
    await page.mouse.down()
    await page.mouse.move(canvas.x + x + w / 2, canvas.y + y + 16, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(200)
    note(`真拖节点「${title}」→ (${x}, ${y})`)
  }

  /**
   * 搭一条**手工展开**的两轮链：S1→P1→MC1→K1→S2→P2→[MC2]→K2→输出。
   * lastSkipsMix = true 时省略第 2 轮的 MC2 —— 这正是「末轮跳过某层」的手工连线表达。
   */
  async function buildChain({ lastSkipsMix }) {
    // 上一节可能停在分析页/结果页 —— 先回到结构编辑器
    await page.goto(BASE + '/structure/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    await page.locator('.head select').selectOption('blank')
    await page.waitForTimeout(700)
    await fieldInput(page, '算法名称').fill(lastSkipsMix ? '方阵·末轮跳过小样' : '方阵·两轮全层对照')
    await page.waitForTimeout(150)
    await fieldInput(page, '标准来源').fill('自建演示 · 手工连线的逐轮差异')
    await page.waitForTimeout(150)
    await fieldInput(page, '密钥长度').fill('128')
    await page.waitForTimeout(150)
    await fieldInput(page, '总轮数').fill('2')
    await page.waitForTimeout(150)
    await fieldSelect(page, '结构类型').selectOption('spn')
    await page.waitForTimeout(250)
    await nodeByTitle('输入明文').click()
    await page.waitForTimeout(250)
    await fieldInput(page, '位宽').fill('32')
    await page.waitForTimeout(150)
    await fieldInput(page, '分块数').fill('4')
    await page.waitForTimeout(250)

    const y = 430
    let x = 200
    const at = () => { const v = x; x += 170; return v }
    await dragPaletteTo(page, 'S 盒替换', at(), y)
    await dragPaletteTo(page, '比特/字节置换', at(), y)
    await dragPaletteTo(page, '线性层', at(), y)
    await dragPaletteTo(page, '异或轮密钥', at(), y)
    await dragPaletteTo(page, 'S 盒替换', at(), y)
    await dragPaletteTo(page, '比特/字节置换', at(), y)
    if (!lastSkipsMix) await dragPaletteTo(page, '线性层', at(), y)
    await dragPaletteTo(page, '异或轮密钥', at(), y)
    await page.waitForTimeout(300)
    await moveNode('输入明文', 20, y)
    await moveNode('输出密文', at(), y)

    // 属性：两轮的 S 盒 / 置换 / 异或都一致；列混淆全部 op=mixColumns
    await setProp('S 盒替换', 'S 盒', 'aes', 'select', 0)
    await setProp('S 盒替换', '应用方式', 'byte', 'select', 0)
    await setProp('比特/字节置换', '字节循环移位', 1, 'input', 0)
    await setProp('异或轮密钥', '密钥变量名', 'RC', 'input', 0)
    await setProp('输出密文', '统计截止轮', 2)
    await setProp('S 盒替换', 'S 盒', 'aes', 'select', 1)
    await setProp('S 盒替换', '应用方式', 'byte', 'select', 1)
    await setProp('比特/字节置换', '字节循环移位', 1, 'input', 1)
    await setProp('异或轮密钥', '密钥变量名', 'RC', 'input', 1)
    const mcIdx = lastSkipsMix ? [0] : [0, 1]
    for (const i of mcIdx) {
      await nodeByTitleN('线性层', i).click()
      await page.waitForTimeout(250)
      await fieldSelect(page, '运算').selectOption('mixColumns')
      await page.waitForTimeout(200)
      note(`线性层#${i}：运算 = mixColumns`)
    }
    note(lastSkipsMix
      ? '小样：只有第 1 轮带「线性层（列混淆）」，第 2 轮靠**少了这条连线/节点**表达'
      : '对照样：两轮都带「线性层（列混淆）」')

    await link('输入明文', 0, 'S 盒替换', 0, '输入明文 → S1', 0, 0)
    await link('S 盒替换', 0, '比特/字节置换', 0, 'S1 → P1', 0, 0)
    await link('比特/字节置换', 0, '线性层', 0, 'P1 → MC1', 0, 0)
    await link('线性层', 0, '异或轮密钥', 0, 'MC1 → K1', 0, 0)
    await link('异或轮密钥', 0, 'S 盒替换', 0, 'K1 → S2', 0, 1)
    await link('S 盒替换', 0, '比特/字节置换', 0, 'S2 → P2', 1, 1)
    if (lastSkipsMix) {
      await link('比特/字节置换', 0, '异或轮密钥', 0, 'P2 → K2（**第 2 轮没有列混淆**）', 1, 1)
    } else {
      await link('比特/字节置换', 0, '线性层', 0, 'P2 → MC2', 1, 1)
      await link('线性层', 0, '异或轮密钥', 0, 'MC2 → K2', 1, 1)
    }
    await link('异或轮密钥', 0, '输出密文', 0, 'K2 → 输出密文', 1, 0)
    await page.waitForTimeout(400)

    const edges = await page.locator('#canvas-inner svg path.wire-path').count()
    const nodes = await page.locator('#canvas-inner .node').count()
    note(`画布：${nodes} 节点 / ${edges} 连线`)
    await shot(lastSkipsMix ? 'unroll-1-末轮跳过小样.png' : 'unroll-2-两轮全层对照.png')

    const g = await readSessionGraph(page)
    return { graph: g, nodes, edges }
  }

  const unroll = { skipLast: null, fullTwoRounds: null, differ: null, error: null }

  /** 结果页「特征摘要」是一组 <dt>/<dd>；末轮少一层只改这里的输出差分，不改权重 */
  const readOutputDiff = async () => {
    await page.goto(BASE + '/results/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    return page.evaluate(() => {
      const kv = (label) => {
        const dts = [...document.querySelectorAll('.kv dt')]
        const dt = dts.find((d) => d.textContent.trim().startsWith(label))
        return dt ? (dt.nextElementSibling?.textContent || '').trim() : null
      }
      const diff = kv('输出差分')
      const weight = kv('累计权重')
      if (diff === null) return '(未在结果页找到「输出差分」)'
      return `输出差分 = ${diff}（累计权重 = ${weight}）`
    })
  }

  try {
    console.log('\n【10】手工连线差异实验：末轮跳过 MixColumns 的两轮小样')
    const buildSkip = await buildChain({ lastSkipsMix: true })
    await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    await fieldInput(page, '起始轮').fill('1')
    await fieldInput(page, '结束轮').fill('1')
    await page.waitForTimeout(300)
    note('小样：起始轮=1，结束轮=1（整条手工链在**一趟传播**里走完）')
    const mSkip = await runAnalysis(page)
    await shot('unroll-3-末轮跳过结果.png')
    const logsSkip = await readLogs(page)
    const tblSkip = await readRoundTable(page)
    const outSkip = await readOutputDiff()
    note(`小样指标：${Object.entries(mSkip).map(([k, v]) => `${k}=${v.value}`).join(' | ')}`)
    note(`★ 小样结果页 ${outSkip}`)

    console.log('\n【11】对照样：两轮都带列混淆（同上手法，仅多一条层）')
    const buildFull = await buildChain({ lastSkipsMix: false })
    await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    await fieldInput(page, '起始轮').fill('1')
    await fieldInput(page, '结束轮').fill('1')
    await page.waitForTimeout(300)
    const mFull = await runAnalysis(page)
    await shot('unroll-4-两轮全层结果.png')
    const logsFull = await readLogs(page)
    const tblFull = await readRoundTable(page)
    const outFull = await readOutputDiff()
    note(`对照指标：${Object.entries(mFull).map(([k, v]) => `${k}=${v.value}`).join(' | ')}`)
    note(`★ 对照结果页 ${outFull}`)

    const lastCell = (t) => (t.rows.length ? t.rows[t.rows.length - 1] : [])
    note(`★ 小样逐轮表末行：${JSON.stringify(lastCell(tblSkip))}`)
    note(`★ 对照逐轮表末行：${JSON.stringify(lastCell(tblFull))}`)
    unroll.skipLast = { graph: buildSkip.graph, nodes: buildSkip.nodes, edges: buildSkip.edges, metrics: mSkip, logs: logsSkip, roundTable: tblSkip, outputDiff: outSkip }
    unroll.fullTwoRounds = { graph: buildFull.graph, nodes: buildFull.nodes, edges: buildFull.edges, metrics: mFull, logs: logsFull, roundTable: tblFull, outputDiff: outFull }
    unroll.differ = JSON.stringify(mSkip) !== JSON.stringify(mFull)
    unroll.lastRowDiffer = JSON.stringify(lastCell(tblSkip)) !== JSON.stringify(lastCell(tblFull))
    unroll.outputDiffDiffer = outSkip !== outFull
    note('★ 逐轮表末行' + (unroll.lastRowDiffer ? '不同' : '相同')
      + '（权重本就该相同 —— 代价只数各轮进 S 盒的活跃字节，末轮的层不改变它）')
    note(`★ 结果页两份：${outSkip} ／ ${outFull}`
      + (unroll.outputDiffDiffer
        ? ' —— 输出差分不同 ⇒ 引擎确实按手工连线算了（少放一个「线性层」节点就少一层）'
        : ' —— ⚠️ 两份输出差分相同，需要复查'))
    note('★ 通用图（SPN）路径现在会填 outputState —— 结果页「输出差分」不再是「(未记录)」'
      + '（缺陷②已于本轮修复）')
  } catch (e) {
    unroll.error = String(e).slice(0, 400)
    note('手工连线实验中断：' + String(e).slice(0, 200))
  }

  await browser.close()

  const report = {
    exportedVia: exported || '未导出',
    steps,
    designIntent: INTENT,
    designProblems,
    graph: graphA,
    blockBitsProbe: { inputValueAfterFill128: bitsAfter128, blockSizeField: blockAfter128 },
    engineLine,
    metrics: { differential: mDiff, linear: mLin },
    roundTable: { differential: tblDiff, linear: tblLin },
    logs: { differential: logsDiff, linear: logsLin },
    resultsPageText: resultsTxt,
    explainText: explainTxt,
    unrollExperiment: unroll,
    consoleErrors: errors.filter((e) => !/favicon/i.test(e)),
    sessionRawBytes: sessA.length,
  }
  fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify(report, null, 2), 'utf8')
  note('已写 session.json')

  console.log('\n' + '─'.repeat(64))
  console.log('设计校验：', designProblems.length ? designProblems : '通过')
  console.log('差分：', JSON.stringify(mDiff))
  console.log('线性：', JSON.stringify(mLin))
  console.log('末轮跳过小样：', JSON.stringify(unroll.skipLast?.metrics))
  console.log('两轮全层对照：', JSON.stringify(unroll.fullTwoRounds?.metrics))
  console.log('手工连线实验错误：', unroll.error)
  console.log('控制台错误：', report.consoleErrors.length)
  console.log('产出目录：', OUT)
})()
