/**
 * 在**真实浏览器**里从零搭出「双鱼 Feistel」并跑出结果，全程留档。
 *
 * 跑法（需后端在 8011 跑着）：
 *   NODE_PATH=<工作区 node_modules> node frontend/tests/design-shuangyu.cjs
 *   （NODE_PATH 必须写 Windows 风格路径，MSYS 的 /c/... Node 认不出）
 *
 * 与 accept-four-defects.cjs 的分工：那边是**断言**（复验缺陷），
 * 这边是**演示与留档**（真拖、真连、真改、真跑，每步截图 + 数据落盘）。
 *
 * ⚠️ 节点一律**按标题定位**，不按 DOM 索引 —— 索引一旦错位就会静默改错节点。
 *    每次改属性前先断言「属性面板选中的就是目标节点」，错位就抛错。
 *
 * 产出：outputs/双鱼Feistel设计记录/
 *   step-*.png / diff-*.png / linear-*.png / results-*.png / structure-*.png
 *   shuangyu-project.json   界面「导出」按钮下载的工程 JSON
 *   session.json            抓到的指标 / 逐轮表 / 日志 / 解析 / 设计校验
 */
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const BASE = 'http://127.0.0.1:8011'
const ROOT = path.resolve(__dirname, '..', '..')
const OUT = path.join(ROOT, 'outputs', '双鱼Feistel设计记录')
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
/** 只读派生字段（如「分组长度」）读取用 —— 它刻意带 readonly，别被上面那条排除掉 */
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

/** 设计的预期形态 —— 落档时逐条核对，避免"看起来搭对了" */
const INTENT = {
  meta: { name: '双鱼', structure: 'feistel', keySize: 64, rounds: 8 },
  nodes: {
    INPUT: { bits: 32, blocks: 2 },
    OUTPUT: { rounds: 8 },
    SPLIT: { splitBits: 32 },
    SBOX: { sboxId: 'aes', mode: 'byte' },
    PERM: { shift: 1 },
    XORKEY: { keyVar: 'C', independent: 'yes' },
    MERGE: { op: 'xor' },
  },
  wires: [
    ['INPUT', 'out', 'SPLIT', 'in'],
    ['SPLIT', 'b', 'SBOX', 'in'],   // 右半 R 进 F
    ['SBOX', 'out', 'PERM', 'in'],
    ['PERM', 'out', 'XORKEY', 'in'],
    ['XORKEY', 'out', 'MERGE', 'a'],
    ['SPLIT', 'a', 'MERGE', 'b'],   // 左半 L 直连合并
    ['MERGE', 'out', 'OUTPUT', 'in'],
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
  // 边上：按 type 映射回节点
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
  const selection = async () => (await page.locator('.sel-head b').textContent().catch(() => '')) || ''

  // ── 干净起点 ──
  await page.goto(BASE + '/structure/', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* ignore */ } })

  console.log('\n【1】打开结构编辑器，切到空白画布')
  await page.goto(BASE + '/structure/', { waitUntil: 'networkidle' })
  await page.locator('.head select').selectOption('blank')
  await page.waitForTimeout(500)
  note('选择模板「空白画布（自定义）」')
  await shot('step-1-空白画布.png')

  console.log('\n【2】填算法元信息，并把结构类型改成 Feistel')
  await fieldInput(page, '算法名称').fill('双鱼')
  await page.waitForTimeout(200)
  await fieldInput(page, '标准来源').fill('自建演示 · 双鱼 Feistel 结构')
  await page.waitForTimeout(200)
  await fieldInput(page, '密钥长度').fill('64')
  await page.waitForTimeout(200)
  await fieldInput(page, '总轮数').fill('8')
  await page.waitForTimeout(200)
  await fieldSelect(page, '结构类型').selectOption('feistel')
  await page.waitForTimeout(300)
  note(`元信息：名称=${await fieldInput(page, '算法名称').inputValue()}`
    + ` / 密钥长度=${await fieldInput(page, '密钥长度').inputValue()}`
    + ` / 总轮数=${await fieldInput(page, '总轮数').inputValue()}`
    + ` / 结构类型=${await fieldSelect(page, '结构类型').inputValue()}`)
  note(`分组长度（只读派生）= ${await fieldReadonly(page, '分组长度').inputValue()} bit`)

  console.log('\n【3】从左侧调色板拖组件搭轮函数')
  await dragPaletteTo(page, '分支/分块', 330, 260)
  await dragPaletteTo(page, 'S 盒替换', 490, 410)
  await dragPaletteTo(page, '比特/字节置换', 650, 410)
  await dragPaletteTo(page, '异或轮密钥', 810, 410)
  await dragPaletteTo(page, '合并 (XOR)', 900, 200)
  await page.waitForTimeout(400)
  note(`画布节点数 = ${await page.locator('#canvas-inner .node').count()}（模板自带 输入明文/输出密文 + 拖入 5 个）`)
  await shot('step-2-拖入组件.png')

  console.log('\n【4】逐节点改属性（按标题定位；改前先断言选中正确）')
  const setProp = async (title, label, value, kind = 'input') => {
    await nodeByTitle(title).click()
    await page.waitForTimeout(250)
    const sel = (await selection()).trim()
    if (sel !== title) throw new Error(`点「${title}」却选中「${sel}」—— 索引/定位错位，拒绝继续`)
    if (kind === 'select') await fieldSelect(page, label).selectOption(value)
    else await fieldInput(page, label).fill(String(value))
    await page.waitForTimeout(200)
    // 读回校验：下拉读 select 的 value，数值/文本读 input 的 value
    const now = kind === 'select'
      ? await fieldSelect(page, label).inputValue().catch(() => '(读不到)')
      : await fieldInput(page, label).inputValue().catch(() => '(读不到)')
    if (String(now) !== String(value)) throw new Error(`「${title}.${label}」填 ${value} 后读回 ${now}`)
    note(`${title}：${label} = ${value}`)
  }
  await setProp('输入明文', '位宽', 32)
  await setProp('输入明文', '分块数', 2)
  await setProp('分支/分块', 'A 部分位宽', 32)
  await setProp('S 盒替换', 'S 盒', 'aes', 'select')
  await setProp('S 盒替换', '应用方式', 'byte', 'select')
  await setProp('S 盒替换', '重复层数', 1)
  await setProp('比特/字节置换', '字节循环移位', 1)
  await setProp('异或轮密钥', '密钥变量名', 'C')
  await setProp('合并 (XOR)', '合并运算', 'xor', 'select')
  await setProp('输出密文', '统计截止轮', 8)

  await page.locator('#canvas-inner').click({ position: { x: 12, y: 12 } })
  await page.waitForTimeout(400)
  note(`改完 INPUT 后：分组长度自动 = ${await fieldReadonly(page, '分组长度').inputValue()} bit`
    + '（32bit × 2 块 —— 派生值跟着 INPUT 走）')
  await shot('step-3-属性设好.png')

  console.log('\n【5】按端口连线（点输出端口 → 点输入端口）')
  async function link(fromTitle, fromPort, toTitle, toPort, desc) {
    await nodeByTitle(fromTitle).locator('.port.out').nth(fromPort).click()
    await nodeByTitle(toTitle).locator('.port.in').nth(toPort).click()
    await page.waitForTimeout(150)
    note(`连线 ${desc}`)
  }
  await link('输入明文', 0, '分支/分块', 0, '输入明文.out → 分支/分块.in')
  await link('分支/分块', 1, 'S 盒替换', 0, '分支/分块.B（右半 R）→ S 盒替换.in   ← 轮函数 F 的入口')
  await link('S 盒替换', 0, '比特/字节置换', 0, 'S 盒替换.out → 比特/字节置换.in')
  await link('比特/字节置换', 0, '异或轮密钥', 0, '比特/字节置换.out → 异或轮密钥.in')
  await link('异或轮密钥', 0, '合并 (XOR)', 0, '异或轮密钥.out → 合并.A（= F(R)）')
  await link('分支/分块', 0, '合并 (XOR)', 1, '分支/分块.A（左半 L）→ 合并.B')
  await link('合并 (XOR)', 0, '输出密文', 0, '合并.out → 输出密文.in')
  const edgeCount = await page.locator('#canvas-inner svg path.wire-path').count()
  const tag = (await page.locator('.card-head .tag').first().textContent()).trim()
  const bodyTxt = await page.locator('body').innerText()
  note(`连线数 = ${edgeCount}；画布标签 = ${tag}；结构校验：${/结构校验通过/.test(bodyTxt) ? '通过' : '未通过'}`)
  await shot('step-4-连线完成.png')

  // 结构解析（中文）也留一份
  await page.evaluate(() => { document.querySelectorAll('details').forEach((d) => { d.open = true }) })
  await page.waitForTimeout(400)
  await shot('structure-1-中文解析.png')
  const explainTxt = (await page.locator('body').innerText()).slice(0, 9000)

  // 地面真相：落盘的图
  await page.waitForTimeout(1500)
  const graph = await readSessionGraph(page)
  const designProblems = verifyDesign(graph)
  note(`设计校验：${designProblems.length ? '不通过 → ' + designProblems.join('；') : '全部符合预期'}`)
  if (designProblems.length) {
    throw new Error('设计没搭成预期形态，先修好再跑分析：' + designProblems.join('；'))
  }

  console.log('\n【6】跳差分分析页运行（Feistel 图迭代）')
  await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await fieldInput(page, '起始轮').fill('1')
  await fieldInput(page, '结束轮').fill('8')
  await page.waitForTimeout(300)
  note('差分分析：起始轮=1，结束轮=8')
  const mDiff = await runAnalysis(page)
  await shot('diff-1-结果.png')
  const tblDiff = await readRoundTable(page)
  const logsDiff = await readLogs(page)
  note(`差分指标：${Object.entries(mDiff).map(([k, v]) => `${k}=${v.value}`).join(' | ')}`)
  note(`逐轮明细表：${tblDiff.rows.length} 行`)

  console.log('\n【7】跳线性分析页，同一张图跑线性')
  await page.goto(BASE + '/linear/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  await fieldInput(page, '起始轮').fill('1')
  await fieldInput(page, '结束轮').fill('8')
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
    await download.saveAs(path.join(OUT, 'shuangyu-project.json'))
    exported = '按钮下载'
    note('点击顶部「导出」按钮 → 已保存 shuangyu-project.json')
  } catch (e) {
    note('导出按钮未拿到下载事件：' + String(e).slice(0, 120))
  }
  const sess = await page.evaluate(() => {
    try { return sessionStorage.getItem('cda_session') || '' } catch { return '' }
  })

  const report = {
    exportedVia: exported || '未导出',
    steps,
    designIntent: INTENT,
    designProblems,
    graph,
    metrics: { differential: mDiff, linear: mLin },
    roundTable: { differential: tblDiff, linear: tblLin },
    logs: { differential: logsDiff, linear: logsLin },
    resultsPageText: resultsTxt,
    explainText: explainTxt,
    consoleErrors: errors.filter((e) => !/favicon/i.test(e)),
    sessionRawBytes: sess.length,
  }
  fs.writeFileSync(path.join(OUT, 'session.json'), JSON.stringify(report, null, 2), 'utf8')
  note('已写 session.json')

  await browser.close()

  console.log('\n' + '─'.repeat(64))
  console.log('设计校验：', designProblems.length ? designProblems : '通过')
  console.log('差分：', JSON.stringify(mDiff))
  console.log('线性：', JSON.stringify(mLin))
  console.log('控制台错误：', report.consoleErrors.length)
  console.log('产出目录：', OUT)
})()
