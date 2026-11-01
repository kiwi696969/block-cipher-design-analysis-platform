/**
 * 真实浏览器端到端测试（Playwright 驱动本机已装的 Chrome）。
 *
 * 补的是一处测不到的空白：前面的验证只能证明「页面能渲染」，
 * 证明不了「点运行 → 出结果 → 指标卡和图表真的画出来」。
 * 后者是纯白盒测不出的一类问题 —— 模板里写错一个字段名
 * （比如 modelGrade.text 这种），静态检查全过，只有真的点一下才炸。
 *
 * 它已经真的抓到过四个 bug：
 *   1. 界面传字符串 initDiffs 给引擎，导致 `inputState.join is not a function`（见 AGENTS.md 4.11）
 *   2. 结果只存内存，硬刷新后全丢（见 AGENTS.md 4.14）
 *   3. 动态路由的 URL 参数没被视图接收，/sbox/1/ 直接 500（多页改造时抓到）
 *   4. 视图模板里写 `window.location.assign(...)` —— Vue 模板作用域里没有 window，
 *      编译成 `_ctx.window` 后是 undefined，一点按钮就抛 "t.href is not a function"
 *      （改成 pages.js 的 `go()`；这条只在点击路径上才会触发，静态检查看不出来）
 * 这四条现在都是本文件的常驻断言。
 *
 * ⚠️ 本站是**多页站点（MPA）**，不是单页应用：站内跳转 = 整页加载。
 *    所以下面所有"点导航"的操作都会真的重新加载页面，
 *    跨页的状态只能靠 sessionStorage / localStorage —— 本文件第 5、7 节
 *    正是靠这一点，顺带把「状态真的落盘了吗」也验了。
 *    第 11 节专门盯着「不许退回单页应用」。
 *
 * 注意：没用 agent-browser / playwright 自带的 Chromium（要下几百 MB），
 * 而是用 playwright-core 驱动本机 Chrome；驱动装在项目外的托管工作区，
 * 项目本身的依赖保持干净。
 *
 * 前置：后端必须在 8011 上跑着（`start-django.bat` 或 `runserver`）。
 *
 * 运行（必须在项目根执行，路径按需调整）：
 *
 *   cd "C:/Users/huawei/WorkBuddy/密码算法分析系统"
 *   "C:/Users/huawei/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" frontend/tests/e2e-browser.cjs
 *
 * ⚠️ 全程约 2~5 分钟（含 32 轮分析）。Agent 的 Bash 前台会被 SIGTERM 掐断，
 *    用 run_in_background 并重定向到日志文件。
 *
 * 截图落在 %TEMP% 下（e2e_*.png），可用 CIPHER_SHOT_DIR 覆盖。
 * CHROME 路径可用 CIPHER_CHROME 覆盖。
 */
const path = require('path')

const { chromium } = require('playwright-core')

const CHROME = process.env.CIPHER_CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.CIPHER_BASE || 'http://127.0.0.1:8011'
const SHOT_DIR = process.env.CIPHER_SHOT_DIR
  || process.env.TEMP
  || 'C:\\Users\\huawei\\AppData\\Local\\Temp'

let pass = 0
const fails = []

function check(name, ok, got = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
    console.log(`  ✗ ${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
  }
}

/** 点击顶部导航并等整页跳转完成（MPA：这里一定会重建文档） */
async function navTo(page, text, expectPath) {
  await page.locator('nav.nav a', { hasText: text }).first().click()
  await page.waitForURL(`**${expectPath}`, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(500)
}

const pageKey = (page) => page.evaluate(
  () => document.getElementById('app')?.dataset.page || '',
)

;(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-first-run', '--no-default-browser-check'],
  })
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  const page = await ctx.newPage()

  // 控制台错误只分两类："故意制造的"和"真 bug"。
  // 第 11 节会主动访问一个不存在的地址来验证真 404，浏览器必然为此记一条
  // "Failed to load resource: ... 404" —— 那是预期内的，用窗口标记单独收走，
  // 免得把断言写成"过滤掉所有 404"这种连真 bug 一起放过的方式。
  const consoleErrors = []
  const expected404 = []
  let inExpected404 = false
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (inExpected404 && /status of 404/.test(text)) {
      expected404.push(text)
      return
    }
    consoleErrors.push(text)
  })
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

  /* ============================================================ 1. 差分分析：读后端 1~8 轮 */
  console.log('\n【1】差分分析页：点「运行分析」读后端 SM4 1~8 轮精确解')
  await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })

  check('差分分析页有自己的根文件（data-page=differential）',
    (await pageKey(page)) === 'differential', await pageKey(page))
  check('运行按钮存在', await page.locator('button:has-text("运行分析")').count() > 0)

  /* ⚠️ 页面数值现在**只来自后端**（`web` 任务预热过 1~8 轮，`auto` 命中记录 ⇒ 秒出）。
     别再等 647.00 —— 那是旧的前端束搜索上界，页面已经不再产出这个数了。
     8 轮的精确值是 38.00（§4.37 / §4.40）。 */
  await page.fill('input[type=number] >> nth=1', '8')
  await page.locator('button:has-text("运行分析")').click()

  let ok = true
  try {
    await page.waitForFunction(
      () => /\b38\.00\b/.test(document.body.innerText),
      { timeout: 90000 },
    )
  } catch {
    ok = false
  }
  check('★ 结果渲染出 38.00（后端 8 轮全空间精确解）', ok,
    ok ? '' : (await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '))

  const solvedText = await page.locator('body').innerText()
  check('8 轮全部求解：已解轮数副标题是「第 1 ~ 8 轮」',
    /第\s*1\s*~\s*8\s*轮/.test(solvedText), solvedText.match(/第\s*\d+\s*~\s*\d+\s*轮/g)?.join(' ') || '')

  // 指标卡
  const metricLabels = await page.locator('.metric .m-label').allInnerTexts()
  const metricValues = await page.locator('.metric .m-value').allInnerTexts()
  const joinedLabels = metricLabels.join(' ')
  for (const want of ['时间复杂度', '运行时间', '运行轮数', '命中率', '变量数', '子句数', '活跃 S 盒', '数据复杂度']) {
    check(`指标卡含「${want}」`, joinedLabels.includes(want), joinedLabels.slice(0, 160))
  }
  check('指标卡数量 >= 8', metricValues.length >= 8, String(metricValues.length))
  check('指标卡里没有 "undefined" / "NaN" 这类渲染事故',
    !metricValues.some((v) => /undefined|NaN|\bnull\b/.test(v)),
    metricValues.filter((v) => /undefined|NaN|\bnull\b/.test(v)).join(' | '))

  // 逐轮表
  const rows = await page.locator('.table tbody tr').count()
  check('逐轮明细表有 8 行（请求 1~8 轮，不是 32）', rows >= 8 && rows <= 9, String(rows))

  // 收敛曲线
  const curves = await page.locator('svg.chart path.c-main').count()
  check('收敛曲线已绘制（折线 path 存在）', curves > 0, String(curves))

  // 逐轮活跃 S 盒条带
  const cells = await page.locator('.strip .cell').count()
  check('逐轮活跃 S 盒条带有 8 格（跟请求轮数走）', cells === 8, String(cells))

  // 中文解析
  const text = await page.locator('body').innerText()
  check('出现了中文解析区', text.includes('中文解析'), '')
  check('解析里提到权重含义', text.includes('−log₂p') || text.includes('-log₂p'), '')
  check('日志面板记录了后端求解过程', text.includes('后端 BCA') || text.includes('搜索完成'), '')

  await page.screenshot({ path: path.join(SHOT_DIR, 'e2e_analysis_result.png'), fullPage: false })

  /* ============================================================ 2. 全轮扫描 */
  console.log('【2】全轮扫描（步长 8，缩短耗时）')
  await page.locator('input[type=number]').nth(-1).fill('8')  // 步长输入框
  await page.locator('button:has-text("全轮扫描")').click()
  let scanOk = true
  try {
    await page.waitForFunction(() => document.body.innerText.includes('全轮扫描曲线'), { timeout: 60000 })
  } catch { scanOk = false }
  check('全轮扫描曲线卡片出现', scanOk)
  if (scanOk) {
    const scanRows = await page.locator('.table tbody tr').count()
    check('扫描表格有数据行', scanRows > 0, String(scanRows))
  }

  /* ============================================================ 3. 抽样验证 */
  console.log('【3】抽样验证（切到 1~4 轮：前 3 轮是免费轮，4 轮才有 2⁻⁶ 可验）')
  await page.fill('input[type=number] >> nth=1', '4')   // 结束轮
  await page.locator('button:has-text("运行分析")').click()
  await page.waitForFunction(() => document.body.innerText.includes('6.00'), { timeout: 90000 })
  await page.locator('button:has-text("抽样验证命中率")').click()
  let empOk = true
  try {
    await page.waitForFunction(() => document.body.innerText.includes('抽样验证（真实加密）'), { timeout: 90000 })
  } catch { empOk = false }
  check('★ 抽样验证卡片出现（真实加密跑通）', empOk)
  if (empOk) {
    const t = await page.locator('body').innerText()
    check('抽样给出实测命中率', /实测命中率|实测 \/ 理论/.test(t), '')
    check('抽样判定为已验证/量级一致', /特征得到验证|量级一致|理论期望/.test(t), '')
  }

  /* ============================================================ 4. 起始差分：现在应当被明确拒绝 */
  console.log('【4】★ 起始差分输入（前端不再求解 ⇒ 必须明确拒绝，而不是拿全空间的数冒充）')
  const initInput = page.locator('input[placeholder*="0x2"]')
  check('起始差分输入框存在', await initInput.count() > 0)
  await initInput.fill('0,0,0,1')
  await initInput.blur()
  const afterFill = await page.locator('body').innerText()
  check('★ 填了起始差分后页面没有崩溃（无红框报错）', afterFill.includes('1 个起点'), '')
  check('★ 解析回执显示了规范化结果 00000000 00000000 00000000 00000001',
    afterFill.includes('00000000 00000000 00000000 00000001'),
    afterFill.match(/个起点：[^\n]{0,80}/)?.[0] || '')

  await page.locator('button:has-text("运行分析")').click()
  let refuseOk = true
  try {
    /* 后端 BCA 是全空间搜索、不接受起点：放行就等于「界面写着 0,0,0,1、
       数字却是全空间最小权重」—— 两个不同的问题共用一个数（§4.37）。 */
    await page.waitForFunction(
      () => /全空间搜索|不接受指定起点/.test(document.body.innerText),
      { timeout: 30000 },
    )
  } catch { refuseOk = false }
  check('★ 指定起点被明确拒绝（页面给出理由，不是给一个别的数）', refuseOk,
    refuseOk ? '' : (await page.locator('body').innerText()).slice(0, 240).replace(/\n/g, ' | '))

  // 清空起点 → 回到全空间精确解
  await initInput.fill('')
  await initInput.blur()
  await page.waitForTimeout(300)
  await page.locator('button:has-text("运行分析")').click()
  let diffOk = true
  try {
    await page.waitForFunction(() => /\b6\.00\b/.test(document.body.innerText), { timeout: 90000 })
  } catch { diffOk = false }
  check('★ 清空起点后 4 轮结果回到 6.00（全空间精确值）', diffOk,
    diffOk ? '' : (await page.locator('body').innerText()).slice(0, 240).replace(/\n/g, ' | '))

  /* ============================================================ 5. 结果页 */
  console.log('【5】结果页：整页跳转后结果不丢（sessionStorage 真的落盘了）')
  // 多页站点下这里走的是**整页跳转**（点导航 = 重新加载一个文档），
  // 结果还能读到，唯一解释就是它确实被持久化了 —— 这比 SPA 时代的同一条断言更有说服力。
  await navTo(page, '结果', '/results/')

  check('到达结果页自己的根文件', (await pageKey(page)) === 'results', await pageKey(page))
  const resText = await page.locator('body').innerText()
  check('★ 整页跳转到结果页后仍读到同一份结果（含 6.00）', resText.includes('6.00'),
    resText.slice(0, 200).replace(/\n/g, ' | '))
  const resMetrics = await page.locator('.metric').count()
  check('结果页指标卡 >= 8', resMetrics >= 8, String(resMetrics))
  check('结果页有建模规模分解', resText.includes('建模规模分解'), '')
  /* 求解来源卡在**结果页**（不在分析页）：这里才验得到「数值来自后端 kissat」 */
  check('★ 求解来源标成「全空间精确解」（不是"上界"）',
    resText.includes('全空间精确解') && !resText.includes('束搜索上界'),
    resText.slice(0, 120).replace(/\n/g, ' | '))
  check('求解来源卡点名 kissat 与任务名 web',
    resText.includes('kissat') && resText.includes('web'), '')

  // 再硬刷新一次：同样应当从 sessionStorage 恢复
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const afterReload = await page.locator('body').innerText()
  check('★ 硬刷新后结果不丢（sessionStorage 恢复）', afterReload.includes('6.00'),
    afterReload.slice(0, 200).replace(/\n/g, ' | '))
  check('★ 刷新后指标卡仍在', (await page.locator('.metric').count()) >= 8,
    String(await page.locator('.metric').count()))

  /* 三种搜索模型对比：前端引擎不再参与求解 ⇒ 这张卡已停用。
     断言它**如实写着已停用**，而不是还挂着一个点了没反应的按钮（哑按钮比没按钮更糟）。 */
  const cmpText = await page.locator('body').innerText()
  check('★ 三种搜索模型对比卡标「已停用」并说明原因', cmpText.includes('已停用'), '')
  check('★ 停用的卡片不再提供「跑三种模型」按钮（不留哑按钮）',
    await page.locator('button:has-text("用当前参数跑三种模型")').count() === 0,
    String(await page.locator('button:has-text("用当前参数跑三种模型")').count()))
  await page.screenshot({ path: path.join(SHOT_DIR, 'e2e_results.png') })

  /* ============================================================ 6. 教程一键执行 */
  console.log('【6】教程页：一键执行示例')
  await page.goto(BASE + '/tutorial/', { waitUntil: 'networkidle' })
  check('教程页有自己的根文件', (await pageKey(page)) === 'tutorial', await pageKey(page))
  check('教程页有示例卡片', await page.locator('.ex').count() >= 10,
    String(await page.locator('.ex').count()))
  check('教程页含启动按钮', await page.locator('button:has-text("先跑最快的一个")').count() > 0)

  await page.locator('button:has-text("先跑最快的一个")').click()
  await page.waitForURL('**/results/', { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(600)
  let tutOk = true
  try {
    await page.waitForFunction(() => /\b6\.00\b/.test(document.body.innerText), { timeout: 60000 })
  } catch { tutOk = false }
  check('★ 一键执行跳转结果页并跑出 6.00（4 轮）', tutOk,
    tutOk ? '' : (await page.locator('body').innerText()).slice(0, 240).replace(/\n/g, ' | '))

  /* ============================================================ 7. 教学开关跨页保持 */
  console.log('【7】结构编辑器：教学开关 → 跨页保持 → 分析结果联动')
  await navTo(page, '教程', '/tutorial/')
  await navTo(page, '结构编辑', '/structure/')

  check('结构编辑器画布渲染出节点', await page.locator('.node').count() > 0,
    String(await page.locator('.node').count()))
  const nodeCount = await page.locator('.node').count()
  check('SM4 模板节点数 >= 5', nodeCount >= 5, String(nodeCount))

  // 选中 T 变换节点，勾「仅 τ」
  await page.locator('.node', { hasText: 'T 变换' }).first().click()
  await page.waitForTimeout(400)
  const attrText = await page.locator('body').innerText()
  check('属性面板出现「仅 τ」开关', attrText.includes('仅 τ'), '')
  const tauCheckbox = page.locator('.card:has-text("属性") input[type=checkbox]').first()
  check('找到仅 τ 复选框', await tauCheckbox.count() > 0, String(await tauCheckbox.count()))
  if (await tauCheckbox.count() > 0) {
    await tauCheckbox.check()
    await page.waitForTimeout(500)
  }

  // ★ 多页站点下这一步是「整页跳走再整页回来」：
  //   图必须从 sessionStorage 恢复，否则开关白勾 —— 这条断言现在真的在验持久化
  await navTo(page, '差分分析', '/differential/')

  const warnText = await page.locator('body').innerText()
  check('★ 教学对照开关已打开（整页跳转后图仍带该属性 → 跨页持久化生效）',
    warnText.includes('教学对照开关已打开'),
    warnText.slice(0, 160).replace(/\n/g, ' | '))
  // ⚠️ 只勾「仅 τ」会改掉 T 节点的结构 ⇒ 图不再是标准 SM4 ⇒ 后端按标准算法算的数不能拿来用。
  //    这条曾经验「14.00 vs 92.00」的引擎联动；前端不再求解后，正确的行为是**明确拒绝**。
  await page.fill('input[type=number] >> nth=1', '8')
  await page.locator('button:has-text("运行分析")').click()
  let tauOk = true
  try {
    await page.waitForFunction(
      () => /已被修改过|不会按你改过的结构算/.test(document.body.innerText),
      { timeout: 30000 },
    )
  } catch { tauOk = false }
  check('★ 仅 τ 后拒绝走后端（图被改过，不许拿标准 SM4 的数冒充）', tauOk,
    tauOk ? '' : (await page.locator('body').innerText()).slice(0, 240).replace(/\n/g, ' | '))
  await page.screenshot({ path: path.join(SHOT_DIR, 'e2e_tau.png') })

  /* ============================================================ 8. 主题切换 */
  console.log('【8】深色 / 浅色模式')
  const themeAttr = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  const bgOf = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)

  check('初始为浅色', (await themeAttr()) === 'light', await themeAttr())
  const lightBg = await bgOf()
  await page.locator('button:has-text("深色")').click()
  await page.waitForTimeout(400)
  check('★ 点击后切到深色', (await themeAttr()) === 'dark', await themeAttr())
  const darkBg = await bgOf()
  check('★ 深色下背景色确实变深',
    (() => {
      const m = darkBg.match(/\d+/g)
      return m && Number(m[0]) < 80
    })(), `light=${lightBg} dark=${darkBg}`)
  const darkText = await page.evaluate(() => getComputedStyle(document.body).color)
  check('★ 深色下文字颜色变亮（不是白底白字）', (() => {
    const m = darkText.match(/\d+/g)
    return m && Number(m[0]) > 180
  })(), darkText)
  await page.screenshot({ path: path.join(SHOT_DIR, 'e2e_dark.png') })

  await page.locator('button:has-text("浅色")').click()
  await page.waitForTimeout(400)
  check('切回浅色', (await themeAttr()) === 'light', await themeAttr())

  // 整页刷新后主题保持（localStorage 跨页沿用）
  await page.reload({ waitUntil: 'networkidle' })
  check('刷新后主题不丢（localStorage 生效）', (await themeAttr()) === 'light', await themeAttr())

  /* ============================================================ 9. 内置 S 盒种子 */
  console.log('【9】S 盒库开箱可用（内置种子数据）')

  // 通过接口取库里的真实数据。详情页的 id **不能写死** ——
  // 主键由数据库分配，测试里建过又删过记录后就不是从 1 开始了，
  // 写死会出现"本地能过、换台机器就 404"的假失败。
  const libResp = await fetch(BASE + '/api/sboxes/')
  const lib = await libResp.json()
  const names = (lib.results || []).map((s) => s.name)
  check('★ 库里预置了 3 个内置 S 盒（SM4 / AES / PRESENT）',
    lib.count >= 3
    && names.includes('SM4 S-Box')
    && names.includes('AES S-Box')
    && names.includes('PRESENT S-Box'),
    `count=${lib.count} names=${names.join(',')}`)
  // 只对种子那三条断言 is_builtin —— 用户从「S 盒库」页导入的记录本来就该是
  // false。早期写成 `every(... === true)` 会在"库里存在任何一条自定义盒"时
  // 假失败（哪怕种子全都在），是个过严的断言。
  const seeded = (lib.results || [])
    .filter((s) => ['SM4 S-Box', 'AES S-Box', 'PRESENT S-Box'].includes(s.name))
  check('内置种子都带 is_builtin 标记',
    seeded.length === 3 && seeded.every((s) => s.is_builtin === true),
    JSON.stringify(seeded.map((s) => `${s.name}:${s.is_builtin}`)))
  check('内置项的表数据长度与位宽自洽（512 / 32 个 hex 字符）',
    (lib.results || []).every((s) => s.table_hex_len === s.size * 2),
    JSON.stringify((lib.results || []).map((s) => `${s.name}:${s.table_hex_len}/${s.size * 2}`)))

  const realId = (lib.results || [])[0]?.id
  check('★ 库里至少有一条记录可看（详情页不会是空壳）', typeof realId === 'number', String(realId))

  /* ========================================== 10. ★ S 盒库 ⇄ 画布 通路 */
  console.log('【10】★ 在「S 盒库」导入的 S 盒，要能在结构编辑器里选到')
  //
  // 背景：S 盒在这套系统里有两处存法 —— `/sbox/` 页写的是 Django 数据库，
  // 画布的 S 盒下拉读的却是前端 S 盒库（`sboxLib`）。两套存储过去互不相通，
  // 用户导入的 S 盒在画布里**根本选不到**（下拉只有 7 个内置项）。
  // 这一节盯的就是这条通路：
  //   导入 → 列表标「画布可选」→ 算法选择页出现 chip
  //        → 画布下拉出现该项 → 选中后显示与数值都真的跟着变 → 删除后同步消失
  // 同时回归一个已修的真实 bug：换盒后右侧下拉框会**弹回旧值**
  // （图是就地改的，Vue 认为"同一个对象没变"，不往下传失效），
  // 修法是显式读 `rev` / `sboxRev`。

  const SBOX_NAME = 'E2E 联调盒'
  // 8bit 仿射 i ^ 0x5A：确定性、仍是置换、DU=256（单盒差分权重为 0），
  // 于是类 AES 的结果从 222.00 掉到 0.00 —— 变化醒目，不会跟"没生效"混淆。
  const affineHex = Array.from(
    { length: 256 }, (_, i) => (i ^ 0x5A).toString(16).padStart(2, '0'),
  ).join('')

  await page.goto(BASE + '/sbox/', { waitUntil: 'networkidle' })

  // 先清掉上次跑留下的同名记录 —— 用界面删，省得自己在 Node 侧管 CSRF
  const staleRow = page.locator('tr', { hasText: SBOX_NAME }).first()
  if (await staleRow.count() > 0) {
    page.once('dialog', (d) => d.accept())
    await staleRow.locator('button:has-text("删除")').click()
    await page.waitForTimeout(1500)
  }

  await page.locator('button:has-text("导入 S 盒")').click()
  await page.fill('#f-name', SBOX_NAME)
  await page.fill('#f-table', affineHex)
  await page.waitForTimeout(400)
  const preTip = await page.locator('#f-table ~ .tip').innerText().catch(() => '')
  check('导入表单在浏览器端就校验出「构成置换」', preTip.includes('构成置换'), preTip.slice(0, 60))
  await page.locator('button:has-text("保存")').click()
  await page.waitForTimeout(2500)

  const afterSave = await page.locator('body').innerText()
  check('★ 保存后有成功回执（文案没被 resetForm 顺手抹掉）',
    afterSave.includes('已保存'), '')
  check('表头多了「画布」这一列',
    (await page.locator('table thead th').allInnerTexts()).includes('画布'), '')
  const newRowText = await page.locator('tr', { hasText: SBOX_NAME }).first().innerText()
  check('★ 新记录在列表里，且「画布」列标为可选', newRowText.includes('画布可选'),
    newRowText.replace(/\n/g, ' | '))

  // 算法选择页的 chip 也要有它（证明服务端镜像真的建立了）
  await page.goto(BASE + '/ciphers/', { waitUntil: 'networkidle' })
  const chips = await page.locator('.sbox-chip').allInnerTexts()
  check('★ 算法选择页的 S 盒 chip 里出现这条（服务端镜像已建立）',
    chips.some((c) => c.includes(SBOX_NAME)), chips.join(' / ').slice(0, 200))

  // 进画布：类 AES 模板 → 选中 S 盒节点 → 下拉里应能找到它
  await page.locator('.tpl', { hasText: '类 AES' }).first().click()
  await page.waitForURL('**/structure/', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(900)
  check('进入结构编辑器（类 AES 模板）', (await pageKey(page)) === 'structure', await pageKey(page))

  await page.locator('.node', { hasText: 'S 盒替换' }).first().click()
  await page.waitForTimeout(400)
  const sboxOpts = await page.locator('.card:has-text("属性") select option').allInnerTexts()
  check('★ 画布 S 盒下拉里出现了导入的盒子（过去这里只有 7 个内置项）',
    sboxOpts.some((o) => o.includes(SBOX_NAME)), sboxOpts.join(' / ').slice(0, 220))

  // 它的 option value 形如 srv_<主键>（服务端镜像的命名约定）
  const srvValue = await page.evaluate((n) => {
    for (const sel of document.querySelectorAll('select')) {
      const o = [...sel.options].find((x) => x.textContent.includes(n))
      if (o) return o.value
    }
    return null
  }, SBOX_NAME)
  check('导入的盒子以 srv_<主键> 挂进服务端镜像',
    /^srv_\d+$/.test(String(srvValue)), String(srvValue))

  if (/^srv_\d+$/.test(String(srvValue))) {
    const sboxSelect = page.locator('select', {
      has: page.locator(`option[value="${srvValue}"]`),
    }).first()
    await sboxSelect.selectOption(srvValue)
    await page.waitForTimeout(700)

    const nodeLine = (await page.locator('.node', { hasText: 'S 盒替换' })
      .first().innerText()).replace(/\n/g, ' / ')
    check('★ 选中后画布节点上就是新盒（不是弹回旧值 —— 已修的就地改图陈旧 bug）',
      nodeLine.includes(srvValue), nodeLine)
    const persisted = await page.evaluate(() => sessionStorage.getItem('cda_session') || '')
    check('★ 换盒后的图能持久化（sessionStorage 里含 srv_）',
      persisted.includes('srv_'), persisted.slice(0, 80).replace(/\n/g, ' '))

    // 去分析页跑一次：类 AES **没有后端实现** ⇒ 必须明确报错，
    // 不能悄悄退回前端引擎（否则页面上是"改过的图"，数字却不知道从哪来）
    await page.goto(BASE + '/differential/', { waitUntil: 'networkidle' })
    await page.locator('button:has-text("运行分析")').click()
    let refused = true
    try {
      await page.waitForFunction(
        () => /没有后端 BCA 实现|没有后端实现/.test(document.body.innerText),
        { timeout: 30000 },
      )
    } catch { refused = false }
    const w = await page.locator('body').innerText()
    check('★ 类 AES 模板（无后端实现）被明确拒绝，且理由点名可用算法',
      refused && /SM4/.test(w), w.slice(0, 160).replace(/\n/g, ' | '))
  }

  // 收尾：删掉自己建的记录，保持库干净（顺带验一下删除路径与同步移除）
  await page.goto(BASE + '/sbox/', { waitUntil: 'networkidle' })
  page.once('dialog', (d) => d.accept())
  await page.locator('tr', { hasText: SBOX_NAME }).first()
    .locator('button:has-text("删除")').click()
  await page.waitForTimeout(1800)
  check('★ 删除后列表里不再有它（重复跑不会留脏数据）',
    await page.locator('tr', { hasText: SBOX_NAME }).count() === 0, '')

  /* ============================================================ 11. 多页结构 */
  console.log('【11】★ 多页站点：每个页面一个根文件，站内跳转是整页导航')

  const PAGES = [
    ['/', 'home'],
    ['/ciphers/', 'ciphers'],
    ['/structure/', 'structure'],
    ['/differential/', 'differential'],
    ['/linear/', 'linear'],
    ['/bca/', 'bca'],
    ['/results/', 'results'],
    ['/logs/', 'logs'],
    ['/sbox/', 'sbox'],
    ['/tutorial/', 'tutorial'],
    ['/check/', 'check'],
  ]

  let served = 0
  const servedDetail = []
  for (const [url, key] of PAGES) {
    const resp = await page.goto(BASE + url, { waitUntil: 'domcontentloaded' })
    const dp = await pageKey(page)
    const title = await page.title()
    if (resp && resp.status() === 200 && dp === key && title) served++
    else servedDetail.push(`${url} → status=${resp && resp.status()} data-page=${dp}`)
  }
  check(`★ ${PAGES.length} 个页面各自返回独立根文件（HTTP 200 + 自己的 data-page + 自己的标题）`,
    served === PAGES.length, servedDetail.join(' | '))

  // 详情页：一条路由接住任意 id，根文件仍是它自己的
  const detailUrl = `/sbox/${realId}/`
  const detailResp = await page.goto(BASE + detailUrl, { waitUntil: 'networkidle' })
  check(`★ S 盒详情页 ${detailUrl} 有自己的根文件（data-page=sbox-detail）`,
    detailResp.status() === 200 && (await pageKey(page)) === 'sbox-detail',
    `${detailResp.status()} / ${await pageKey(page)}`)
  check('★ 详情页真的把这条记录渲染出来了（不是"加载失败"占位）',
    (await page.locator('body').innerText()).includes('S-Box'),
    (await page.locator('body').innerText()).slice(0, 80))

  /* ================================ 11.1 ★ S 盒详情页：安全指标 + DDT/LAT 热力图 */
  //
  // 详情页从「只有一张真值表」升级成了「指标卡 + DDT/LAT 热力图 + 导出代码」。
  // 这些数字是纯计算的，引擎侧 verify-core.mjs 已经盯过一遍；这里盯的是
  // **另一件事**：这些值有没有真的走到页面上 —— 指标名的字段名写错、
  // canvas 没画出来、导出下拉不联动，静态检查和引擎测试都发现不了。
  //
  // 用 name 反查 id，不用 results[0]：列表默认排序不保证谁在前，
  // 拿错盒子的指标就是假失败。
  console.log('【11.1】★ S 盒详情页：安全指标 / DDT·LAT 热力图 / 导出代码')

  const byName = (n) => (lib.results || []).find((s) => s.name === n)?.id
  // ⚠️ 「线性度」是「非线性度」的子串 —— 用 hasText 子串匹配会命中错的那张卡。
  //    必须拿 .m-label 的**前缀**比对（标签可能带一个说明性后缀）。
  const metricValue = async (label) => {
    const cards = await page.$$eval('.metrics-grid .metric', (els) => els.map((el) => ({
      label: el.querySelector('.m-label')?.innerText.trim() || '',
      value: el.querySelector('.m-value')?.innerText.trim() || '',
    })))
    return cards.find((c) => c.label.startsWith(label))?.value ?? null
  }

  const sm4Id = byName('SM4 S-Box')
  if (typeof sm4Id !== 'number') {
    check('★ 能按名字找到 SM4 S 盒（热力图用例的前置）', false, 'SM4 S-Box 不在库里')
  } else {
    await page.goto(`${BASE}/sbox/${sm4Id}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.metrics-grid', { timeout: 15000 })

    // 权威基准（见 AGENTS.md §7）：SM4 DU=4、NL=112、线性度=16（不是 32）、分支数=2
    check('★ SM4 详情页 差分均匀度 DU = 4', (await metricValue('差分均匀度')) === '4',
      String(await metricValue('差分均匀度')))
    check('★ SM4 详情页 非线性度 NL = 112', (await metricValue('非线性度')) === '112',
      String(await metricValue('非线性度')))
    check('★ SM4 详情页 线性度 = 16（不是 32）', (await metricValue('线性度')) === '16',
      String(await metricValue('线性度')))

    // 两张 canvas，且真的画了东西 —— 拿不到 CSS 变量的画布最容易"渲染成功但全白"
    const canvases = await page.$$eval('canvas.heat-canvas', (els) => els.map((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const colors = new Set()
      let colored = 0
      for (let i = 0; i < d.length; i += 4) {
        colors.add(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`)
        if (d[i + 3] > 60) colored++
      }
      return { w: c.width, h: c.height, colors: colors.size, colored }
    }))
    check('★ 详情页有 DDT 与 LAT 两张热力图 canvas', canvases.length === 2,
      `canvas=${canvases.length}`)
    check('★ 两张热力图都是 256×256 的位图（8bit 盒）',
      canvases.every((c) => c.w === 256 && c.h === 256),
      JSON.stringify(canvases.map((c) => `${c.w}x${c.h}`)))
    check('★ 热力图真的着了色（不是一片空白，也不是只有单色）',
      canvases.every((c) => c.colored > 0 && c.colors >= 3),
      JSON.stringify(canvases.map((c) => `${c.colors}色/${c.colored}格`)))

    // 极值标记：DDT 与 LAT 各一个，标的是"最不均匀/相关性最强"的那格
    check('★ DDT 与 LAT 各有一个极值标记',
      (await page.locator('.heat-mark').count()) === 2,
      String(await page.locator('.heat-mark').count()))

    // 导出为代码：切语言要真的换出对应语法，而不是只换了个下拉框
    const codeArea = page.locator('textarea.mono').first()
    const cCode = await codeArea.inputValue()
    const langSelect = page.locator('select.select').first()
    await langSelect.selectOption('python')
    await page.waitForTimeout(200)
    const pyCode = await codeArea.inputValue()
    check('★ 导出代码能切到 Python（内容确实变了）',
      cCode !== pyCode && /^\s*(static const uint8_t|sm4_s_box)/.test(cCode)
        && /^\s*sm4_s_box\s*=/.test(pyCode),
      `C=${JSON.stringify(cCode.slice(0, 26))} Py=${JSON.stringify(pyCode.slice(0, 26))}`)
  }

  // 4bit 盒走另一条分支（坐标 1 位 hex、canvas 16×16）—— 顺手验一下没写死 256
  const presentId = byName('PRESENT S-Box')
  if (typeof presentId === 'number') {
    await page.goto(`${BASE}/sbox/${presentId}/`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.metrics-grid', { timeout: 15000 })
    check('★ PRESENT（4bit）详情页 非线性度 NL = 4',
      (await metricValue('非线性度')) === '4', String(await metricValue('非线性度')))
    const sz = await page.$$eval('canvas.heat-canvas', (els) => els.map((c) => c.width))
    check('★ PRESENT 热力图是 16×16（没有把尺寸写死成 256）',
      sz.length === 2 && sz.every((v) => v === 16), JSON.stringify(sz))
  }

  // BCA 进度接口：本轮新增，专门盯一件事 —— 它的路由**必须排在兜底页之前**，
  // 否则会被 404 页吞掉，返回一坨 HTML 而不是 JSON（这正是踩过的坑）。
  // 本机是 Windows，BCA 跑不了 → 预期 `ok:false, reason:needs_linux`，但仍须是
  // 200 + JSON。是不是真的有进度数据，不在这里验（那要 WSL + 几小时）。
  const progResp = await fetch(`${BASE}/api/bca/progress/?cipher=sm4&model=map`)
  const progCt = progResp.headers.get('content-type') || ''
  let progBody = null
  try { progBody = await progResp.json() } catch { /* 不是 JSON 就留 null */ }
  check('★ /api/bca/progress/ 没被兜底页吞掉（返回 JSON 而不是 HTML）',
    progCt.includes('application/json') && progBody !== null,
    `${progResp.status} ${progCt}`)
  check('★ 进度接口的形状正确（有 ok 字段；本机 Windows 下为 needs_linux）',
    progBody !== null && typeof progBody.ok === 'boolean'
      && (progBody.ok === true ? 'records' in progBody : 'reason' in progBody),
    JSON.stringify(progBody).slice(0, 120))

  // 不存在的地址：真 404，而不是「回壳 + 200」
  inExpected404 = true
  const nf = await page.goto(BASE + '/definitely-not-a-page/', { waitUntil: 'domcontentloaded' })
  const nfStatus = nf.status()
  const nfKey = await pageKey(page)
  await page.waitForTimeout(400)
  inExpected404 = false
  check('★ 未知地址返回真正的 404（不是回壳 200）', nfStatus === 404, String(nfStatus))
  check('★ 404 页也是独立根文件（data-page=not-found）', nfKey === 'not-found', nfKey)
  check('★ 这次 404 是服务端给的（控制台也为此记了一次失败，属预期内）',
    expected404.length >= 1, String(expected404.length))

  // 旧的无斜杠地址仍然可用（Django 自动 301）
  const old = await page.goto(BASE + '/ciphers', { waitUntil: 'domcontentloaded' })
  check('旧的无斜杠地址 /ciphers 自动 301 到 /ciphers/',
    old.status() === 200 && page.url().endsWith('/ciphers/'), page.url())

  // ★ 决定性证据：站内跳转必须是**整页加载**，不是客户端路由
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await page.evaluate(() => { window.__mpa_probe = 'alive' })
  await page.locator('nav.nav a', { hasText: '算法选择' }).first().click()
  await page.waitForURL('**/ciphers/', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(500)

  const probe = await page.evaluate(() => window.__mpa_probe ?? null)
  check('★ 站内跳转是整页加载（window 上的探针消失 → 证明没有客户端路由）',
    probe === null, String(probe))
  check('★ 跳转后到达的是算法选择页自己的根文件',
    (await pageKey(page)) === 'ciphers', await pageKey(page))

  /* ============================================================ 12. 跨页结果的模式口径 */
  console.log('【12】跨页结果不许被误当成本页结果')
  // 结果在整站内共享（sessionStorage 里只有一份 result），换页**不会**自动重算 ——
  // 差分页跑完直接进「线性分析」，线性页会把那份**差分**结果原样显示出来：
  // 标题写着「每一步查 LAT」，数字却来自 DDT。从前没有任何提示，
  // 用户会读成「两种分析算出来一模一样」，进而怀疑引擎。
  // 干净起点（前面的小节改过参数 / 教学开关，会污染基准）
  await page.goto(BASE + '/structure/', { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* ignore */ } })
  await page.goto(BASE + '/differential/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  await page.fill('input[type=number] >> nth=1', '4')
  await page.locator('button:has-text("运行分析")').first().click()
  await page.waitForFunction(() => document.body.innerText.includes('6.00'), { timeout: 90000 })
    .catch(() => {})
  check('★ 差分页跑出 6.00（作为对照基准）',
    /6\.00/.test(await page.locator('body').innerText()))

  /* ⚠️ 落盘是**去抖**的（`scheduleSave` 一个 timeout）。命中缓存时结果 200ms 就回来了，
     若立刻点导航，sessionStorage 可能还没写进去 —— 到了线性页自然没有"陈旧结果"可警告。
     这不是产品缺陷（正常人手速不会这么快），但测试必须等它落盘，否则测的是竞态。 */
  await page.waitForFunction(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem('cda_session') || '{}')
      return Boolean(s.result && s.result.mode)
    } catch { return false }
  }, { timeout: 10000 }).catch(() => {})
  const persisted = await page.evaluate(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem('cda_session') || '{}')
      return s.result ? s.result.mode : null
    } catch { return null }
  })
  check('结果已落 sessionStorage 且记着模式（differential）', persisted === 'differential',
    String(persisted))

  await page.locator('nav.nav a', { hasText: '线性分析' }).first().click()
  await page.waitForURL('**/linear/', { timeout: 20000 }).catch(() => {})
  await page.waitForTimeout(700)
  const staleBox = page.locator('.stale-result').first()
  check('★ 线性页在「结果还是差分算的」时给出显式警告',
    (await page.locator('.stale-result').count()) === 1,
    String(await page.locator('.stale-result').count()))
  check('★ 警告点明来源是「差分」，不是本页的线性',
    (await staleBox.count()) === 1 && /差分/.test(await staleBox.innerText()),
    (await staleBox.count()) === 1 ? (await staleBox.innerText()).slice(0, 60) : '(没有警告框)')

  await page.locator('button:has-text("运行分析")').first().click()
  await page.waitForFunction(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem('cda_session') || '{}')
      return s.result && s.result.mode === 'linear'
    } catch { return false }
  }, { timeout: 90000 }).catch(() => {})
  const linRes = await page.evaluate(() => {
    try {
      const s = JSON.parse(sessionStorage.getItem('cda_session') || '{}')
      return s.result
        ? { mode: s.result.mode, charMode: s.result.char && s.result.char.mode, w: s.result.metrics && s.result.metrics.weight }
        : null
    } catch { return null }
  })
  /* 线性走后端是 `attack=linear` + `model=LIN`（不是 MAP）——
     结果对象的 mode / char.mode 必须都是 linear，否则结果页会把它画成「差分特征」。 */
  check('★ 线性页重算后结果模式是 linear（不是差分）',
    linRes && linRes.mode === 'linear' && linRes.charMode === 'linear', JSON.stringify(linRes))
  check('★ 线性 4 轮结果 = 6.00（每活跃盒 6 bit；不是差分那套）',
    linRes && linRes.w === 6, JSON.stringify(linRes))
  const linText = await page.locator('body').innerText()
  check('页面口径标签跟着切成线性（−log₂p = 6.00 + 线性逼近）',
    /6\.00/.test(linText) && /线性逼近/.test(linText), '')
  check('★ 重算后警告消失（口径已经对上）',
    (await page.locator('.stale-result').count()) === 0)

  /* ============================================================ 13. 控制台干净 */
  console.log('【13】控制台错误')
  // 这里**不再**用正则把 favicon 之类的 404 过滤掉再宣布"干净"——
  // 那种写法会把真 bug 一起放过。预期内的 404 只有一处（第 10 节故意访问的
  // 未知地址），它在上面的窗口里已被单独收走；剩下的任何一条都是真问题。
  check('★ 全程零控制台错误（除故意制造的 404 外）',
    consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' ｜ '))

  await browser.close()

  console.log('\n' + '─'.repeat(60))
  if (fails.length) {
    console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`)
    for (const f of fails) console.log('   ✗ ' + f)
    process.exitCode = 1
  } else {
    console.log(`✓ 全部通过：${pass}/${pass} 项`)
  }
})().catch((e) => {
  console.error('E2E 执行异常:', e.message)
  process.exitCode = 2
})
