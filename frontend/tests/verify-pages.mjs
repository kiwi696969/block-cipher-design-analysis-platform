/**
 * 多页站点结构一致性测试。
 *
 * 为什么要单独测这个：
 * 本站是**多页站点（MPA）** —— 一个页面要在四处同时存在，缺一处就是死链
 * （更糟的情况是路由在、入口文件不在，构建直接失败）。靠人记不住，让机器盯着：
 *
 *   ① frontend/src/pages.js         页面注册表（导航、站内链接生成）
 *   ② frontend/<html>               Vite 构建入口（每个页面一个根文件）
 *   ③ frontend/src/entries/<key>.js 该页面的挂载脚本
 *   ④ analysis/pages.py             服务端：路由 → 模板 → Vite 入口
 *   ⑤ templates/analysis/<tpl>      服务端根模板（每个页面一个）
 *
 * 另外守住两条硬约束：
 *   · **不得再引入 vue-router** —— 客户端路由与"每页一个根文件"是互斥的，
 *     迁回 SPA 会让这个项目的形态整个变掉（2026-09-18 明确改造过）。
 *   · 每个 HTML 根文件必须自带挂载点和**自己的**入口脚本，
 *     否则又退化成"一个入口伺候所有页面"。
 *
 *   node tests/verify-pages.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PAGES, NAV, href, matchPath, navKeyOf } from '../src/pages.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FRONTEND = join(ROOT, 'frontend')
const TEMPLATES = join(ROOT, 'templates', 'analysis')

let pass = 0
const fails = []

function check(name, ok, got = '') {
  if (ok) { pass++; return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
}

const read = (p) => readFileSync(p, 'utf8')

/* ================================================================ 1. 注册表自身 */

console.log('\n【1】页面注册表（frontend/src/pages.js）')

check('页面数量为 13（12 个可访问页面 + 404）', PAGES.length === 13, String(PAGES.length))

const keys = PAGES.map((p) => p.key)
check('key 无重复', new Set(keys).size === keys.length, keys.join(','))

const nonRoot = PAGES.filter((p) => p.path)
for (const p of nonRoot) {
  check(`[${p.key}] path 一律带尾斜杠：${p.path}`, p.path === '/' || p.path.endsWith('/'), p.path)
}
check('只有首页的 path 是 /', PAGES.filter((p) => p.path === '/').length === 1)

const htmls = PAGES.map((p) => p.html)
check('html 入口名无重复', new Set(htmls).size === htmls.length, htmls.join(','))

/* ================================================================ 2. 前端三处对齐 */

console.log('【2】前端：HTML 根文件 / 入口脚本 / 注册表 三处对齐')

for (const p of PAGES) {
  const htmlPath = join(FRONTEND, p.html)
  const entryPath = join(FRONTEND, 'src', 'entries', `${p.key}.js`)

  check(`[${p.key}] HTML 根文件存在 frontend/${p.html}`, existsSync(htmlPath))
  check(`[${p.key}] 入口脚本存在 src/entries/${p.key}.js`, existsSync(entryPath))

  if (existsSync(htmlPath)) {
    const doc = read(htmlPath)
    // Vue 挂载后会加 data-v-app 等属性，所以断言必须容许 <div id="app" 后面还有别的属性
    check(`[${p.key}] HTML 里有自己的挂载点 <div id="app" data-page="${p.key}">`,
      new RegExp(`<div id="app"[^>]*data-page="${p.key}"`).test(doc),
      (doc.match(/<div id="app"[^>]*>/) || [''])[0])
    check(`[${p.key}] HTML 加载的是自己的入口脚本 /src/entries/${p.key}.js`,
      doc.includes(`/src/entries/${p.key}.js`),
      (doc.match(/src="([^"]*entries[^"]*)"/) || [''])[0])
    check(`[${p.key}] HTML 声明了 lang="zh-CN"`, /<html lang="zh-CN"/.test(doc))
  }

  if (existsSync(entryPath)) {
    const js = read(entryPath)
    check(`[${p.key}] 入口脚本 mountPage 的 key 与注册表一致`,
      js.includes(`mountPage('${p.key}'`),
      (js.match(/mountPage\([^)]*/) || [''])[0])
  }
}

// 没有多余的入口文件（含 boot.js 之外的游离脚本）
const entryFiles = readdirSync(join(FRONTEND, 'src', 'entries')).filter((f) => f.endsWith('.js'))
const boot = entryFiles.filter((f) => f === 'boot.js')
const pageEntries = entryFiles.filter((f) => f !== 'boot.js').map((f) => f.replace(/\.js$/, '')).sort()
check('entries/ 下恰好一个 boot.js（公共挂载逻辑）', boot.length === 1, entryFiles.join(','))
check('entries/ 下的入口脚本与注册表一一对应',
  JSON.stringify(pageEntries) === JSON.stringify([...keys].sort()),
  pageEntries.join(','))

// 没有多余的 HTML 入口
const htmlFiles = readdirSync(FRONTEND).filter((f) => f.endsWith('.html')).sort()
check('frontend/ 下的 HTML 与注册表一一对应',
  JSON.stringify(htmlFiles) === JSON.stringify([...htmls].sort()),
  htmlFiles.join(','))

/* ================================================================ 3. 服务端对齐 */

console.log('【3】服务端：URL / 模板 / Vite 入口 与前端对齐')

const py = read(join(ROOT, 'analysis', 'pages.py'))
const pyPages = [...py.matchAll(
  /Page\(\s*'([^']+)',\s*'([^']*)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\s*\)/g,
)].map((m) => ({ key: m[1], url: m[2], template: m[3], entry: m[4], title: m[5] }))

check('从 analysis/pages.py 解析出 13 个页面（含 404）', pyPages.length === 13, String(pyPages.length))
check('服务端 key 集合与前端注册表一致',
  JSON.stringify(pyPages.map((p) => p.key).sort()) === JSON.stringify([...keys].sort()),
  pyPages.map((p) => p.key).join(','))

const byKey = new Map(pyPages.map((p) => [p.key, p]))
for (const p of PAGES) {
  const sv = byKey.get(p.key)
  check(`[${p.key}] 服务端有同名条目`, !!sv)
  if (!sv) continue
  check(`[${p.key}] 服务端入口 = 前端 ${p.html}`, sv.entry === p.html, sv.entry)

  const tplPath = join(TEMPLATES, sv.template)
  check(`[${p.key}] 服务端模板存在 templates/analysis/${sv.template}`, existsSync(tplPath))
  if (existsSync(tplPath)) {
    const tpl = read(tplPath)
    if (p.key === 'not-found') {
      check('[not-found] 模板直接继承 base（它就是兜底根文件）', tpl.includes('analysis/base.html'))
    } else {
      check(`[${p.key}] 模板继承 base.html`, tpl.includes('{% extends "analysis/base.html" %}'))
    }
  }

  // 服务端 URL 与前端 path 必须是同一条（去掉 Django 的参数语法后比对）
  if (p.key !== 'not-found') {
    const svUrl = sv.url.startsWith('/') ? sv.url : `/${sv.url}`
    const norm = (s) => s.replace(/<int:[^>]+>/g, ':id')
    check(`[${p.key}] 服务端 URL 与前端 path 一致：${p.path}`,
      norm(svUrl) === norm(p.path), `${svUrl} vs ${p.path}`)
  }
}

// 模板目录里不该有游离文件（base 之外都要能在注册表里找到）
const tplFiles = readdirSync(TEMPLATES).filter((f) => f.endsWith('.html'))
const knownTpl = new Set([...pyPages.map((p) => p.template), 'base.html'])
check('templates/analysis/ 下没有游离模板',
  tplFiles.every((f) => knownTpl.has(f)),
  tplFiles.filter((f) => !knownTpl.has(f)).join(','))

/* ================================================================ 4. 不再是单页应用 */

console.log('【4】硬约束：不得退回单页应用')

const pkg = JSON.parse(read(join(FRONTEND, 'package.json')))
check('package.json 里没有 vue-router 依赖',
  !JSON.stringify(pkg.dependencies || {}).includes('vue-router'),
  JSON.stringify(pkg.dependencies))

const urlsPy = read(join(ROOT, 'analysis', 'urls.py'))
check('服务端不再有「catch-all 回壳」的 spa 视图',
  !urlsPy.includes('views.spa'),
  (urlsPy.match(/views\.\w+/g) || []).join(','))

const srcFiles = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(js|vue)$/.test(e.name)) srcFiles.push(p)
  }
}
walk(join(FRONTEND, 'src'))

const routerHits = []
for (const f of srcFiles) {
  const t = read(f)
  if (/vue-router|RouterLink|RouterView|useRouter|useRoute\b/.test(t)) {
    routerHits.push(f.replace(ROOT, '').replace(/\\/g, '/'))
  }
}
check('src/ 下没有任何 vue-router 用法残留', routerHits.length === 0, routerHits.join(', '))

// 站内链接必须走注册表，不能散落硬编码路径
const hardcoded = []
for (const f of srcFiles) {
  if (f.endsWith('pages.js')) continue
  const t = read(f)
  for (const m of t.matchAll(/(?:href|location\.assign)\s*[=(]?\s*["'`](\/[a-z-]+\/?)["'`]/g)) {
    hardcoded.push(`${f.replace(ROOT, '').replace(/\\/g, '/')}: ${m[0]}`)
  }
}
check('站内链接没有硬编码路径（一律经 href() 生成）', hardcoded.length === 0, hardcoded.join(' | '))

/* ================================================================ 4b. 模板里不许碰 window */

console.log('【4b】视图模板：不许出现 window，用到的函数必须真的导入')

// 这两条抓的是"编译得过去、静态检查也过得去、只在点击时才炸"的一类错误。
// 真实案例：模板里写 @click="window.location.assign(...)" —— Vue 模板表达式的作用域里
// 没有 window，编译成 `_ctx.window` 后是 undefined，点一下就是
// "t.href is not a function"。E2E 抓到了它，但那是运行期；这里再加一道静态防线。
const windowInTemplate = []
const missingImport = []
for (const f of srcFiles.filter((x) => x.endsWith('.vue'))) {
  const rel = f.replace(ROOT, '').replace(/\\/g, '/')
  const t = read(f)
  const tpl = (t.match(/<template>([\s\S]*)<\/template>/) || ['', ''])[1]
  const script = (t.match(/<script setup>([\s\S]*?)<\/script>/) || ['', ''])[1]

  if (/\bwindow\b/.test(tpl)) windowInTemplate.push(rel)

  // 模板里调用的站内跳转/链接函数，都必须在 <script setup> 里导入过
  for (const fn of ['href', 'go', 'matchPath', 'navKeyOf', 'pageByKey']) {
    if (!new RegExp(`\\b${fn}\\s*\\(`).test(tpl)) continue
    const imported = new RegExp(
      `import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*'@/pages\\.js'`,
    ).test(script)
    if (!imported) missingImport.push(`${rel}: ${fn}()`)
  }
}
check('视图模板里没有 window（模板作用域没有它，编译成 _ctx.window 必炸）',
  windowInTemplate.length === 0, windowInTemplate.join(', '))
check('模板里用到的 href()/go() 等都已从 @/pages.js 导入',
  missingImport.length === 0, missingImport.join(', '))

// 站点图标：不声明的话浏览器会去要 /favicon.ico，每次访问都留一条 404
const baseTpl = read(join(TEMPLATES, 'base.html'))
check('base.html 声明了站点图标（rel="icon"）',
  /<link[^>]+rel="icon"/.test(baseTpl),
  (baseTpl.match(/<link[^>]*icon[^>]*>/) || ['(无)'])[0])
check('站点图标文件存在 frontend/public/favicon.svg',
  existsSync(join(FRONTEND, 'public', 'favicon.svg')))

/* ================================================================ 5. 链接生成 */

console.log('【5】链接生成与路径解析')

check("href('home') === '/'", href('home') === '/', href('home'))
check("href('ciphers') === '/ciphers/'", href('ciphers') === '/ciphers/', href('ciphers'))
check("href('sbox-detail', { id: 7 }) === '/sbox/7/'",
  href('sbox-detail', { id: 7 }) === '/sbox/7/', href('sbox-detail', { id: 7 }))
check('未提供的参数保留占位符（说明调用方漏传）',
  href('sbox-detail', {}) === '/sbox/:id/', href('sbox-detail', {}))

const m1 = matchPath('/sbox/12/')
check("matchPath('/sbox/12/') → sbox-detail + id=12",
  m1.key === 'sbox-detail' && m1.params.id === '12', JSON.stringify(m1))
const m2 = matchPath('/ciphers/')
check("matchPath('/ciphers/') → ciphers", m2.key === 'ciphers', JSON.stringify(m2))
check("matchPath('/nope/') → not-found", matchPath('/nope/').key === 'not-found')
check("matchPath('/sbox/3')（无尾斜杠也能认）", matchPath('/sbox/3').key === 'sbox-detail',
  JSON.stringify(matchPath('/sbox/3')))

check('详情页的导航高亮归属到 S 盒库', navKeyOf('sbox-detail') === 'sbox', navKeyOf('sbox-detail'))
check('导航项数量为 10', NAV.length === 10, String(NAV.length))
check('404 与自检页不进导航',
  !NAV.some((p) => p.key === 'not-found' || p.key === 'check'),
  NAV.map((p) => p.key).join(','))

/* ================================================================ 6. 算法选项 */

console.log('【6】算法选择：选项收敛到 SM4 / AES-128 / PRESENT-64 / 类 AES / 空白自定义')

// 界面只提供三个起点。清单在 core/graph.js 的 USER_TEMPLATE_IDS 里维护一份，
// 两个界面都从它取 —— 这里盯着"清单对不对"以及"两个界面有没有真的用它"。
// 真实踩过的坑：算法选择页和结构编辑器的「恢复模板」各遍历一次 TEMPLATES，
// 删模板时只改了一处，另一个下拉框里还留着已经下架的选项。
const graphSrc = read(join(FRONTEND, 'src', 'core', 'graph.js'))
const userIds = (graphSrc.match(/USER_TEMPLATE_IDS\s*=\s*\[([^\]]*)\]/) || ['', ''])[1]
  .split(',')
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
  .filter(Boolean)

check('USER_TEMPLATE_IDS 恰好是 sm4 / aes / present / aes_like / blank',
  JSON.stringify(userIds) === JSON.stringify(['sm4', 'aes', 'present', 'aes_like', 'blank']),
  userIds.join(','))
// 三个标准算法必须带 engine 标记 —— 少了它就会被当成通用图跑，
// 128bit 状态塞进单个 32bit 字的引擎里，数字静默错掉。
for (const id of ['sm4', 'aes', 'present']) {
  check(`[${id}] 模板带 meta.engine = '${id}'`,
    new RegExp(`engine: '${id}'`).test(graphSrc))
}

for (const id of userIds) {
  check(`[${id}] 在 TEMPLATES 里有定义`, new RegExp(`\\n  ${id}:\\s*\\{`).test(graphSrc))
}

// 下架的模板不许再冒回选项里
for (const id of ['sm4_keyext', 'present_like', 'feistel_like']) {
  check(`[${id}] 不在 USER_TEMPLATE_IDS 里`, !userIds.includes(id))
}

// 两个界面必须从同一份清单取，不能各自遍历 TEMPLATES
const selectSrc = read(join(FRONTEND, 'src', 'views', 'CipherSelectView.vue'))
check('算法选择页从 USER_TEMPLATE_IDS 生成选项',
  /USER_TEMPLATE_IDS\.map\(/.test(selectSrc))
check('算法选择页不再遍历全部 TEMPLATES',
  !/Object\.keys\(TEMPLATES\)/.test(selectSrc))

const editorSrc = read(join(FRONTEND, 'src', 'views', 'StructureEditorView.vue'))
// 注意：只断言「出现过 USER_TEMPLATE_IDS」是不够的 —— 光 import 也会命中，
// 所以要求它真的被 filter/map 用上。
check('结构编辑器「恢复模板」用 USER_TEMPLATE_IDS 过滤',
  /USER_TEMPLATE_IDS\.(filter|map)\(/.test(editorSrc),
  (editorSrc.match(/const templates = computed[\s\S]{0,160}/) || [''])[0].replace(/\s+/g, ' '))
check('结构编辑器不再遍历全部 TEMPLATES',
  !/Object\.entries\(TEMPLATES\)/.test(editorSrc))

// 教程示例不许载入界面上选不到的模板 —— 否则用户照着教程做会找不到入口
const tutSrc = read(join(FRONTEND, 'src', 'views', 'TutorialView.vue'))
const tutTpls = [...tutSrc.matchAll(/template:\s*'([^']+)'/g)].map((m) => m[1])
const strayTpls = [...new Set(tutTpls)].filter((t) => !userIds.includes(t))
check('教程示例只用界面上可选的模板（否则教程指向了不存在的入口）',
  strayTpls.length === 0,
  strayTpls.join(','))

// 保留在 TEMPLATES 里的下架模板，必须有明确注释说明它们不在界面上 ——
// 否则下一个人会以为"没被引用"而删掉，而 present_like 是测试夹具
check('保留的下架模板有注释说明（不是被遗忘的死代码）',
  /不在界面上作为选项出现/.test(graphSrc))

/* ---- 「能画 ≠ 能算」四处缺陷的守卫 ----
 *
 * 这四条盯的不是「功能有没有」，而是「界面/装配层有没有把图当回事」。
 * 从前：结构类型没有界面入口、feistel 标记会让整张图作废、
 * 端口不参与传播、图上选的 S 盒与位宽到不了引擎。
 */

// ① 结构类型必须有界面入口
check('★ 结构编辑器提供「结构类型」下拉（缺陷①的界面入口）',
  /setMeta\('structure'/.test(editorSrc) && /STRUCTURE_LABELS/.test(editorSrc),
  (editorSrc.match(/setMeta\('structure'[^\n]*/) || [''])[0])
check('★ 结构编辑器不再把「分组长度」当自由填写的字段',
  !/k: 'blockSize'/.test(editorSrc))
check('★ 结构编辑器从 INPUT 节点同步分组长度（免得 meta 与画布打架）',
  /syncBlockSize\(\)/.test(editorSrc) && /graphBlockSize/.test(editorSrc))
// 元信息面板与属性面板是同一个 card 的二选一（v-if="!selected"）：
// 没有取消选中的入口，只要点过任意节点，「结构类型」就再也回不去了。
check('★ 点画布空白处能取消选中（否则元信息面板不可达）',
  /function deselect\(\)/.test(editorSrc) && /@click\.self="deselect"/.test(editorSrc))

// 下拉里的每一项都必须**真的有引擎**：否则就是个「改了却不影响计算」的哑开关
// （曾经有 'gfn'：选它和不选结果一样，因为没有 GFN 引擎，一律落到 SPN）。
const structSrc = read(join(FRONTEND, 'src', 'core', 'params.js'))
const structList = (structSrc.match(/export const STRUCTURES = \[([^\]]*)\]/) || [])[1] || ''
check('★ STRUCTURES 只列有引擎的结构类型（不许再出现 gfn 这类哑选项）',
  /'spn'/.test(structList) && /'feistel'/.test(structList) && !/gfn/.test(structList),
  structList.trim() || '(没匹配到)')
check('★ 没有引擎的结构标记有明示出口（UNSUPPORTED_STRUCTURES）',
  /export const UNSUPPORTED_STRUCTURES/.test(structSrc))
check('★ 结构编辑器对没有引擎的结构标记给出可见警告',
  /unsupportedStructure/.test(editorSrc))

// ② 引擎标记只许落在内置 SM4 模板上
const engineMarks = (graphSrc.match(/engine:\s*'sm4'/g) || []).length
check('★ 只有 SM4 与 SM4 密钥扩展模板带 engine: \'sm4\'（其余走通用图引擎）',
  engineMarks === 2, String(engineMarks))

const storeSrc = read(join(FRONTEND, 'src', 'stores', 'platform.js'))
check('★ 运行分析按 opts.engine 分流', /opts\.engine === 'sm4'/.test(storeSrc))
check('★ 全轮扫描与运行分析共用同一条分流（否则曲线与单次结果对不上）',
  /function runProfile\(/.test(storeSrc))
check('★ 不再有「线性模式一律送 SM4 专用引擎」的老写法',
  !/mode === MODE\.LINEAR \|\| graph\.value\?\.meta\?\.structure === 'feistel'/.test(storeSrc))
check('★ 运行前对没有引擎的结构标记给出警告（不静默按 SPN 算）',
  /没有对应引擎/.test(storeSrc))

// ★ 分流规则只许有**一份**实现 —— 这条仍然成立（`runProfile` 是唯一入口）。
//
// 但 2026-10-17 起页面**不再调用前端引擎求解**：结果页/分析页/全轮扫描的数值
// 全部来自后端 BCA 的全空间精确解。原来的断言是「结果页必须复用 runProfile」，
// 现在页面根本不求解了，那条断言失去了对象 —— 改成钉死「不得调用」。
// 若不钉，有人把前端引擎接回页面，同一页又会同时出现上界与精确值两个口径。
const resultsSrc = read(join(FRONTEND, 'src', 'views', 'ResultsView.vue'))
check('★ 分流规则唯一实现：runProfile 仍从 store 导出（引擎回归测试用）',
  /export function runProfile\(/.test(storeSrc))
check('★ 结果页不得调用前端求解（runProfile / 引擎函数），数值只来自后端',
  !/\brunProfile\(/.test(resultsSrc)
  && !/\bfeistelCharacteristicSearch\(/.test(resultsSrc)
  && !/\bsm4RoundProfile\(/.test(resultsSrc)
  && !/isFeistel/.test(resultsSrc)
  && !/mode\.value === MODE\.LINEAR \|\|/.test(resultsSrc))
check('★ 结果页的求解来源是 bca-solve（后端 BCA），不是本地引擎',
  /bca-solve/.test(resultsSrc))

// ★ 结果与页面口径不一致必须**显式**提示。
//   结果在整站内共享（sessionStorage 一份 result），换页不自动重算 ——
//   差分页跑完直接点「线性分析」，线性页会把那份差分结果原样显示：
//   标题写「查 LAT」，数字却来自 DDT，会被读成「两种分析算出来一模一样」。
const analysisSrc = read(join(FRONTEND, 'src', 'views', 'AnalysisView.vue'))
check('★ 分析页在「结果来自另一个模式」时给出显式警告',
  /const staleMode = computed/.test(analysisSrc) && /stale-result/.test(analysisSrc))
check('★ 结果页的徽标 / 解析口径取自结果自己的 mode，不是当前页 mode',
  /const resultMode = computed/.test(resultsSrc)
  && /isLinearResult/.test(resultsSrc)
  && !/mode === 'linear' \?/.test(resultsSrc))
// 数值真相等的情形：AES 盒的差分/线性最优点权重都是 6.00，各轮活跃数一致时总权重相同。
// 页面上必须说清「相同 ≠ 算错」，否则还会被读成「两种分析一模一样」。
check('★ 分析页说明了「两种模式 −log₂p 可能相等」不是算错',
  /可能相等/.test(analysisSrc) && /独立计算/.test(analysisSrc))

// ③ 端口必须参与掩码传播
const coreSrc = read(join(FRONTEND, 'src', 'core', 'analysis.js'))
check('★ 引擎按来源端口取掩码（outMaskAt(state, e.from, e.fromPort)）',
  /outMaskAt\(state,\s*e\.from,\s*e\.fromPort\)/.test(coreSrc))
check('★ 引擎里不再有「把来源节点整个输出或进来」的老写法',
  !/inMask \|= \(state\.get\(e\.from\) \?\? 0\)/.test(coreSrc))
check('★ 存在通用 Feistel 图迭代引擎 feistelGraphProfile',
  /export function feistelGraphProfile/.test(coreSrc))
// ③+ 合并节点按**自己声明的运算**合并 —— Feistel 分支反馈是 XOR，不能退化成按位或
check('★ 传播核按 MERGE 声明的运算合并（xor 才是真的异或）',
  /node\.type === 'MERGE' && \(node\.props\.op \|\| 'xor'\) === 'xor'/.test(coreSrc)
  && !/for \(const e of inEdges\) inMask \|= outMaskAt/.test(coreSrc))
check('★ 前向加密的 MERGE 也按 op 合并（两条路径语义必须一致）',
  /ins\.reduce\(\(a, b\) => a \^ b, 0\)/.test(coreSrc))

// ④ 位宽与 S 盒来自图，不再写死
const paramsSrc = read(join(FRONTEND, 'src', 'core', 'params.js'))
check('★ 参数装配层不再写死 sboxRef: \'sm4\'',
  !/sboxRef:\s*'sm4'/.test(paramsSrc),
  (paramsSrc.match(/^\s*sboxRef:.*$/m) || [''])[0])
check('★ 参数装配层从图派生 blockBits / engine',
  /graphBlockBits/.test(paramsSrc) && /graphEngine/.test(paramsSrc))

// ⑤ 属性/元信息字段的写入目标必须与「当前选中」解耦
//    踩过的坑：原生 change 在**失焦**时才发，而失焦晚于新节点的 mousedown（选中已切走），
//    于是「改完 A 的属性、直接点 B」会把 A 字段的值写进 B 的 props。
//    实测：改「输入明文」的分块数 → 结果落到「分支/分块」上，INPUT 一点没变。
const editorSrc2 = read(join(FRONTEND, 'src', 'views', 'StructureEditorView.vue'))
check('★ 字段描述符钉住归属节点（nodeId: node.id）',
  /nodeId:\s*node\.id/.test(editorSrc2))
check('★ 写属性时按 nodeId 定位节点，不回退成「当前选中」写错节点',
  /setProp\(key,\s*value,\s*nodeId = null\)/.test(editorSrc2)
  && /graph\.value\.getNode\(nodeId\)/.test(editorSrc2))
check('★ 改属性传的是字段自带的 nodeId',
  /setProp\(field\.key,\s*v,\s*field\.nodeId\)/.test(editorSrc2))
check('★ 数值 / 文本属性字段用 @input（@change 只在失焦时发，会写错节点）',
  // number 与 fallback 文本输入都必须 @input；
  // <select> 不在此列 —— 它选中即触发 change，没有失焦时延问题。
  /v-else-if="f\.type === 'number'"[\s\S]{0,240}@input="onPropInput\(f, \$event\.target\.value\)"/.test(editorSrc2)
  && /v-else class="input" :value="f\.value"\s*\n\s*@input="onPropInput\(f, \$event\.target\.value\)"/.test(editorSrc2)
  && !/v-else-if="f\.type === 'number'"[\s\S]{0,240}@change=/.test(editorSrc2))
check('★ 元信息字段也用 @input（面板卸载时不会吞掉刚敲的值）',
  /@input="setMeta\(f\.k, \$event\.target\.value\)"/.test(editorSrc2))

/* ---- 「上界 vs 精确下界」口径标注（2026-10-15） ----
 *
 * 背景：SM4 4 轮，平台旧值给 44.00、后端 BCA 给 6，一度被当成「后端不是这份代码」。
 * 实为两个口径 —— 束搜索给的是概率的**上界**，SAT 精确求解给的是**下界**。
 * 单靠文档不够：数字旁边必须有标注，且要有一张能直接看的对照表。
 *
 * ★ 2026-10-15 二次改动：结果页也要内联同一组对照数字 ⇒ 数据抽到
 *   `src/core/bca-reference.js`（同一语义两处实现是项目铁律禁止的）。
 *   本段改为从共享模块取表，并额外守住「结果页徽标 / 内联对照 / 一键复核链接/
 *   BCA 页解析链接参数」这条链路。
 *
 * 这张表会随引擎参数（束宽 / 起点集合）失效 —— 所以和 verify-core 一样钉住关键数值，
 * 改了要连带改这里。数据源：后端任务 exact-r1-8（见 core/bca-reference.js 的注释）。
 */
const refSrc = read(join(FRONTEND, 'src', 'core', 'bca-reference.js'))
const tutCmp = [...refSrc.matchAll(/\{ r: (\d+), front: ([\d.]+), bca: (\d+), same: (true|false)/g)]
  .map((m) => ({ r: +m[1], front: +m[2], bca: +m[3], same: m[4] === 'true' }))
check('★ 有共享的对照常量 core/bca-reference.js（导出 BCA_CMP）',
  /export const BCA_CMP = \[/.test(refSrc))
check('★ 教程页从共享模块取表，不再本地定义（同一语义一处实现）',
  /from '@\/core\/bca-reference\.js'/.test(tutSrc) && !/const BCA_CMP = \[/.test(tutSrc))
check('★ 对照表覆盖 1~8 轮', tutCmp.length === 8 && tutCmp[0].r === 1 && tutCmp[7].r === 8,
  `${tutCmp.length} 行`)
check('★ 对照表后端列 = 实测精确下界 0/0/0/6/12/12/30/38',
  tutCmp.map((c) => c.bca).join(',') === '0,0,0,6,12,12,30,38',
  tutCmp.map((c) => c.bca).join(','))
check('★ 对照表 1~4 轮两列相等（0/0/0/6）；5~8 轮全部标为不一致且前端逐轮偏高',
  tutCmp.slice(0, 4).every((c) => c.same && c.front === c.bca)
  && tutCmp.slice(4).every((c) => !c.same && c.front > c.bca),
  `R5 ${tutCmp[4].front} vs ${tutCmp[4].bca} / R8 ${tutCmp[7].front} vs ${tutCmp[7].bca}`)
check('★ 教程表只给后端精确值一列（旧的「本平台（束搜索上界）」列已移除）',
  /全空间精确值/.test(tutSrc) && !/本平台（束搜索上界）/.test(tutSrc))
check('★ 教程点明旧版 5 轮起偏高源于默认起点族的覆盖，不是搜索算法',
  /起点族/.test(tutSrc) && /不是搜索算法/.test(tutSrc))
check('★ 共享模块自带「上界 ≥ 精确下界」与成立前提的警示',
  /上界 ≥ 精确下界/.test(refSrc) && /不再适用/.test(refSrc))

// 链接契约：结果页构建 → BCA 页解析，两侧共用同一份键名；用真模块跑一遍，不靠肉眼
const refMod = await import('../src/core/bca-reference.js')
const q = new URLSearchParams(refMod.bcaCheckQuery(5))
check('★ 复核链接参数能原样读回（构建端与解析端键名一致）',
  q.get(refMod.BCA_QUERY_KEYS.cipher) === 'SM4'
  && q.get(refMod.BCA_QUERY_KEYS.model) === 'MAP'
  && q.get(refMod.BCA_QUERY_KEYS.start) === '1'
  && q.get(refMod.BCA_QUERY_KEYS.end) === '5',
  refMod.bcaCheckQuery(5))
check('★ 超范围的轮数不返回对照行（不给没核过的数字）',
  refMod.bcaReference(9) === null && refMod.bcaReference(4).bca === 6)

const homeSrc = read(join(FRONTEND, 'src', 'views', 'HomeView.vue'))
check('★ 首页写明「求解一律走后端 BCA」，且未跑出来的轮次显示「还未求解」',
  /后端 BCA/.test(homeSrc) && /还未求解/.test(homeSrc) && /精确/.test(homeSrc))
const anaSrc = read(join(FRONTEND, 'src', 'views', 'AnalysisView.vue'))
check('★ 分析页标明数值由后端全空间 SAT 给出，并给后端入口',
  /全空间 SAT/.test(anaSrc) && /精确/.test(anaSrc) && /href\('bca'\)/.test(anaSrc))
const resSrc = read(join(FRONTEND, 'src', 'views', 'ResultsView.vue'))
check('★ 结果页累计权重徽标写「精确值」（未解完时写「部分求解」）',
  /'精确值'/.test(resSrc) && /'部分求解'/.test(resSrc))
check('★ 结果页不再内联「前端 vs 后端」两列对照（数值只有后端一份，没有第二列可比）',
  !/bcaReference\(/.test(resSrc))
check('★ 结果页展示求解来源卡：kissat / 任务名 / 已解轮数',
  /求解来源/.test(resSrc) && /kissat/.test(resSrc) && /solvedThrough/.test(resSrc))
check('★ 结果页给「去 BCA 页查看原始记录」入口并带轮数参数',
  /bcaCheckQuery/.test(resSrc) && /href\('bca'\)/.test(resSrc))
const bcaSrc = read(join(FRONTEND, 'src', 'views', 'BcaView.vue'))
check('★ /bca/ 页有一键跑到 1–6 轮的对照预设', /SM4 · 1–6 轮/.test(bcaSrc))
check('★ /bca/ 页把「按轮汇总」的最小 SAT 权重标成精确下界', /全空间精确下界/.test(bcaSrc))
check('★ /bca/ 页能读取链接参数预填表单（复核入口落地生效）',
  /BCA_QUERY_KEYS/.test(bcaSrc) && /prefillFromUrl/.test(bcaSrc)
  && /onMounted\(\(\) => \{\s*\n\s*prefillFromUrl\(\)/.test(bcaSrc))
check('★ 指标卡组件支持口径徽标（可选 prop，不影响其他页面）',
  /badge: \{ type: String, default: '' \}/.test(read(join(FRONTEND, 'src', 'components', 'MetricCard.vue'))))

/* 后端线性（LIN）：attack 由模型推导、口径钉在数字旁 */
check('★ /bca/ 的 attack 由模型推导并写进请求体（选不出 LIN + 差分这种非法组合）',
  /form\.value\.model === 'LIN' \? 'linear' : 'differential'/.test(bcaSrc)
  && /attack: attack\.value/.test(bcaSrc))
check('★ /bca/ 有 LIN（线性）预设', /SM4 · LIN 1–4 轮/.test(bcaSrc))
check('★ /bca/ 线性口径钉在权重数字旁，且按**结果**判定而非表单（表单切 LIN 但结果是旧差分时不许错标）',
  /LinearWeightBound/.test(bcaSrc) && /严格下界/.test(bcaSrc)
  && /result\.value\?\.summary\?\.attack === 'linear'/.test(bcaSrc)
  && /v-if="isLinear"/.test(bcaSrc))
check('★ /bca/ 线性口径必须提「未必全局最优」（下界 vs 一条特征的真实权重是两回事）',
  /未必全局最优/.test(bcaSrc) && /LinearWeightExact/.test(bcaSrc))

/* 「拼图」样例（查找表 / 大 S 盒）：能力边界必须显示在数字旁，不能静默 */
const anaSrc2 = read(join(FRONTEND, 'src', 'views', 'AnalysisView.vue'))
const graphSrc2 = read(join(FRONTEND, 'src', 'core', 'graph.js'))
check('★ 分析页对「查找表 / 大 S 盒」给出显式提示（非等宽一次查表 / 截断 / 线性不支持 / 按需单行）',
  /sboxCapability/.test(anaSrc2) && /非等宽查找表/.test(anaSrc2)
  && /高位会被截断/.test(anaSrc2) && /线性（Matsui）分析不支持/.test(anaSrc2)
  && /按需单行/.test(anaSrc2))
check('★ 分析页点明「−log₂p = 0.00 是占位值」，防止被读成零权重线性逼近',
  /占位值/.test(anaSrc2) && /不是<\/b>「存在零权重线性逼近」/.test(anaSrc2))
check('★ 结构编辑器校验条渲染 issue 的 msg（不再 join 出 `[object Object]`）',
  /validation\.issues\.map\(\(i\) => i\?\.msg \?\? i\)\.join\('；'\)/.test(read(join(FRONTEND, 'src', 'views', 'StructureEditorView.vue'))))
check('★ 图校验含「非等宽查找表」与「DDT/LAT 全表超出内存上限」两条提示（源码守卫）',
  /非等宽查找表/.test(graphSrc2) && /DDT\/LAT 全表超出内存上限/.test(graphSrc2))

/* ================================================================ 结果 */

console.log('\n' + '─'.repeat(60))
if (fails.length) {
  console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`)
  for (const f of fails) console.log('   ✗ ' + f)
  process.exitCode = 1
} else {
  console.log(`✓ 全部通过：${pass}/${pass} 项`)
}
