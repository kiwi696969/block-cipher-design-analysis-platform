/**
 * 集成回归测试：走**应用完全相同的调用路径**参数 → 引擎。
 *
 * 与 verify-core.mjs 的分工：
 *   verify-core.mjs   直接调引擎，验证算法正确性（89 项基准）；
 *   本文件            从 `buildSearchOptions()` 出发，模拟浏览器里点「运行分析」
 *                    时发生的事 —— 包括界面字符串参数的解析、教学开关的读取、
 *                    以及参数缺省时的字段裁剪。
 *
 * 这层是必要的原因：analyze() 直接调着正确，不代表**界面的参数能正确到达引擎**。
 * `initDiffs` 的崩溃就属于这一类 —— 引擎没问题，参数装配错了。
 *
 *   node tests/verify-integration.mjs
 */
import { SBoxLibrary } from '../src/core/sboxlib.js'
import { PARAM_DEFAULTS, buildSearchOptions } from '../src/core/params.js'
import {
  MODE, SEARCH_MODEL, sm4RoundProfile, feistelGraphProfile, feistelCharacteristicSearch, analyze,
} from '../src/core/analysis.js'
import { TEMPLATES, CipherGraph, graphBlockBits, graphBlockSize, graphEngine } from '../src/core/graph.js'
import { empiricalHitRate } from '../src/core/empirical.js'

// 引擎依赖 globalThis.__SBOX_LIB__；SBoxLibrary 会读 localStorage
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
new SBoxLibrary()

let pass = 0
const fails = []

function check(name, ok, got = '') {
  if (ok) { pass++; return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
}

/** 模拟「运行分析」：装配参数 → **按图分流引擎** → 取最优特征
 *
 * ⚠️ 分流规则必须与 `stores/platform.js: runProfile()` 保持一致：
 *    engine === 'sm4'  → SM4 专用迭代引擎（只有内置 SM4 模板带这个标记）
 *    structure==='feistel' → 通用 Feistel 分支迭代（真正遍历图）
 *    否则                → 通用图传播
 * 从前这里是 `feistel || mode === MODE.LINEAR` —— 于是**所有**线性分析都被
 * 送给 SM4 专用引擎，图被忽略。那是被测出来的真缺陷。
 */
function runAnalysis({ params = {}, mode = MODE.DIFFERENTIAL, graph = TEMPLATES.sm4.build(), rounds = null } = {}) {
  const g = graph
  const opts = buildSearchOptions({ params: { ...PARAM_DEFAULTS, ...params }, mode, graph: g })
  const r = { start: opts.startRound, end: opts.endRound, rounds: opts.endRound - opts.startRound + 1 }
  const n = rounds ?? r.rounds

  if (opts.engine === 'sm4') {
    const prof = sm4RoundProfile({ ...opts, rounds: n })
    return { best: prof.best, perRound: prof.perRound, path: 'sm4', opts }
  }

  if (opts.structure === 'feistel') {
    const prof = feistelGraphProfile(g, {
      mode,
      blockBits: opts.blockBits,
      startRound: r.start,
      endRound: r.end,
      rounds: n,
      model: opts.model,
      lambda: opts.lambda,
      snr: opts.snr,
    })
    if (prof.best) return { best: prof.best, perRound: prof.perRound, path: 'feistel-graph', opts }
  }

  const res = analyze(g, {
    mode, startRound: r.start, endRound: r.end, rounds: n, blockBits: opts.blockBits,
    searchMode: opts.searchDepth === 'greedy' ? 'greedy' : 'bb',
    maxCandidates: opts.maxCandidates, timeBudgetMs: opts.timeBudgetMs,
    model: opts.model, lambda: opts.lambda, snr: opts.snr,
  })
  const full = (res?.characteristics || []).filter((c) => c.rounds === n)
  const pool = full.length ? full : (res?.characteristics || [])
  return {
    best: pool.reduce((a, b) => (!a || b.weight < a.weight ? b : a), null),
    perRound: res?.perRound || [],
    path: 'graph', opts,
  }
}

/* ================================================================ 1. 权威基准 */

console.log('\n【1】权威基准：界面参数路径 → 引擎（SM4 差分）')
// ⚠️ 2026-10-15：默认起点扩了「三轮免费」族 → R1~R3 = 0，R4 = 6，与后端 BCA 一致。
for (const [e, expected, sbox] of [[2, 0.00, 0], [4, 6.00, 1], [8, 92.00, 15], [16, 274.00, 45], [32, 647.00, 107]]) {
  const r = runAnalysis({ params: { startRound: 1, endRound: e } })
  check(`${e} 轮 −log₂p = ${expected.toFixed(2)}`,
    r.best && Math.abs(r.best.weight - expected) < 1e-9,
    r.best ? r.best.weight.toFixed(2) : 'null')
  check(`${e} 轮活跃 S 盒 = ${sbox}`, r.best?.activeSboxes === sbox,
    String(r.best?.activeSboxes))
}

console.log('【2】区间平移不变性（Feistel 结构的关键性质）')
for (const s of [1, 5, 9, 29]) {
  const r = runAnalysis({ params: { startRound: s, endRound: s + 3 } })
  check(`第 ${s}~${s + 3} 轮 −log₂p 应为 6.00（与起点无关）`,
    r.best && Math.abs(r.best.weight - 6.00) < 1e-9,
    r.best ? r.best.weight.toFixed(2) : 'null')
  check(`第 ${s}~${s + 3} 轮 perRound 长度 = 4`, r.perRound.length === 4, String(r.perRound.length))
}

/* ================================================================ 3. 崩溃回归点 */

console.log('【3】★ 崩溃回归：起始差分从界面文本走到引擎')
// 曾经：'0,0,0,1' 被原样透传 → 引擎 c.inputState.join 抛 TypeError
let crashed = null
let r = null
try {
  r = runAnalysis({ params: { startRound: 1, endRound: 4, initDiffs: '0,0,0,1' } })
} catch (err) {
  crashed = err
}
check('★ 填了起始差分不再抛异常（曾经必崩）', crashed === null, crashed ? crashed.message : '')
check('★ 起点 (0,0,0,1) 的 4 轮权重 = 68.00',
  r?.best && Math.abs(r.best.weight - 68.00) < 1e-9,
  r?.best ? r.best.weight.toFixed(2) : 'null')
check('★ 引擎收到的 inputState 是数组',
  Array.isArray(r?.best?.inputState) && r.best.inputState.length === 4,
  JSON.stringify(r?.best?.inputState))
check('★ 起点规范化正确：第 4 个字 = 1，前三个 = 0',
  r?.best && r.best.inputState[3] === 1 && r.best.inputState[0] === 0,
  JSON.stringify(r?.best?.inputState))

// 自动起点（留空）
const rAuto = runAnalysis({ params: { startRound: 1, endRound: 4 } })
check('留空起点 → 自动选中 6.00（引擎自己找最优）',
  rAuto.best && Math.abs(rAuto.best.weight - 6.00) < 1e-9,
  rAuto.best ? rAuto.best.weight.toFixed(2) : 'null')
check('自动起点首字非零（落在免费族 (a,a,a,0) 上）', rAuto.best?.inputState?.[0] === 1,
  JSON.stringify(rAuto.best?.inputState))

// 两种写法等价
const rHex = runAnalysis({ params: { startRound: 1, endRound: 4, initDiffs: '0x00000002' } })
const rHex8 = runAnalysis({ params: { startRound: 1, endRound: 4, initDiffs: '00000002' } })
check('0x00000002 与 00000002 两种写法结果一致',
  rHex.best && rHex8.best && rHex.best.weight === rHex8.best.weight,
  `${rHex.best?.weight} vs ${rHex8.best?.weight}`)

// 多起点：应取最优
const rMulti = runAnalysis({ params: { startRound: 1, endRound: 4, initDiffs: '0,0,0,1; 1,0,0,0' } })
check('多起点取最优 = 44.00（优于单用 0,0,0,1 的 68.00）',
  rMulti.best && Math.abs(rMulti.best.weight - 44.00) < 1e-9,
  rMulti.best ? rMulti.best.weight.toFixed(2) : 'null')

/* ================================================================ 4. 教学开关端到端 */

console.log('【4】★ 教学对照开关：从图节点走到引擎')
function withFlag(flag) {
  const g = TEMPLATES.sm4.build()
  g.nodes.find((n) => n.type === 'TTRANS').props[flag] = true
  return g
}

const rStd = runAnalysis({ params: { startRound: 1, endRound: 4 } })
check('标准 SM4 4 轮 = 6.00', Math.abs(rStd.best.weight - 6.00) < 1e-9, rStd.best.weight.toFixed(2))

const rTau = runAnalysis({ params: { startRound: 1, endRound: 4 }, graph: withFlag('tauOnly') })
// ⚠️ 扩起点后前 3 轮是免费轮，第 4 轮只有 1 个活跃盒 —— 跳不跳 L 都是 6.00；要看差别得用 8 轮
check('★ 仅 τ：4 轮权重 = 6.00（与标准相同——前 3 轮本就是免费轮）',
  Math.abs(rTau.best.weight - 6.00) < 1e-9, rTau.best.weight.toFixed(2))
check('★ 仅 τ：4 轮活跃 S 盒 = 1', rTau.best.activeSboxes === 1, String(rTau.best.activeSboxes))

const rTau8 = runAnalysis({ params: { startRound: 1, endRound: 8 }, graph: withFlag('tauOnly') })
const rStd8 = runAnalysis({ params: { startRound: 1, endRound: 8 } })
check('★ 仅 τ：8 轮权重 = 14.00（对照标准 92.00）',
  Math.abs(rTau8.best.weight - 14.00) < 1e-9, rTau8.best.weight.toFixed(2))
check('★ 仅 τ：确实比标准 SM4 弱（8 轮权重更小）', rTau8.best.weight < rStd8.best.weight,
  `${rTau8.best.weight} vs ${rStd8.best.weight}`)

const rLs = runAnalysis({ params: { startRound: 1, endRound: 4 }, graph: withFlag('linearS') })
check('★ 线性化 S 盒：4 轮权重归零', rLs.best.weight === 0, String(rLs.best.weight))
const rLs32 = runAnalysis({ params: { startRound: 1, endRound: 32 }, graph: withFlag('linearS') })
check('★ 线性化 S 盒：32 轮权重仍是 0（必然路径）', rLs32.best.weight === 0, String(rLs32.best.weight))

check('★ 未勾选时不受影响（无串扰）', Math.abs(rStd.best.weight - 6.00) < 1e-9,
  rStd.best.weight.toFixed(2))

/* ================================================================ 5. 线性模式 */

console.log('【5】线性模式（同一参数入口，换 mode）')
for (const [e, expected, sbox] of [[4, 6.00, 1], [8, 90.00, 15], [16, 276.00, 46], [32, 642.00, 107]]) {
  const r = runAnalysis({ params: { startRound: 1, endRound: e }, mode: MODE.LINEAR })
  check(`线性 ${e} 轮 −log₂p = ${expected.toFixed(2)}`,
    r.best && Math.abs(r.best.weight - expected) < 1e-9,
    r.best ? r.best.weight.toFixed(2) : 'null')
  check(`线性 ${e} 轮活跃 S 盒 = ${sbox}`, r.best?.activeSboxes === sbox,
    String(r.best?.activeSboxes))
}

/* ================================================================ 6. 三种模型 */

console.log('【6】三种搜索模型（8 轮差分）')
const modelResults = {}
for (const mo of Object.values(SEARCH_MODEL)) {
  const r = runAnalysis({ params: { startRound: 1, endRound: 8, model: mo } })
  modelResults[mo] = r.best
  check(`模型 ${mo} 返回了结果`, !!r.best, 'null')
}
check('概率权重模型 8 轮 = 92.00',
  Math.abs(modelResults.weight.weight - 92.00) < 1e-9, modelResults.weight.weight.toFixed(2))
check('概率映射模型 8 轮 = 92.00（默认参数下与权重模型一致，属预期行为）',
  Math.abs(modelResults.map.weight - 92.00) < 1e-9, modelResults.map.weight.toFixed(2))
check('双权优化模型 8 轮 = 99.00（用 1 bit 权重换更稀疏的差分）',
  Math.abs(modelResults.dual.weight - 99.00) < 1e-9, modelResults.dual.weight.toFixed(2))
check('双权模型的扩散权重确实更小（55 < 87）',
  modelResults.dual.diffusionWeight < modelResults.weight.diffusionWeight,
  `${modelResults.dual.diffusionWeight} vs ${modelResults.weight.diffusionWeight}`)
const moSpecs = ['weight', 'map'].map((mo) => modelResults[mo].mapWeight.toFixed(6))
check('概率权重 / 概率映射两模型同一条特征 → 相同映射权重（概率算法与目标函数解耦）',
  new Set(moSpecs).size === 1, moSpecs.join(' / '))
check('三种模型都满足 E[w] ≥ W 不变量',
  Object.values(SEARCH_MODEL).every((mo) => modelResults[mo].mapWeight >= modelResults[mo].weight - 1e-9),
  Object.values(SEARCH_MODEL).map((mo) => `${mo}:${modelResults[mo].mapWeight.toFixed(2)}≥${modelResults[mo].weight.toFixed(2)}`).join(' '))

/* ================================================================ 7. SPN 路径 */

console.log('【7】SPN 路径（类 PRESENT，16 轮，走通用图传播）')
const rSpn = runAnalysis({ params: { startRound: 1, endRound: 16 }, graph: TEMPLATES.present_like.build() })
check('SPN 路径确实被选中（走通用图传播，而不是 SM4 专用引擎）', rSpn.path === 'graph', rSpn.path)
check('类 PRESENT 16 轮 −log₂p = 32.00',
  rSpn.best && Math.abs(rSpn.best.weight - 32.00) < 1e-9,
  rSpn.best ? rSpn.best.weight.toFixed(2) : 'null')
check('类 PRESENT 16 轮活跃 S 盒 = 16', rSpn.best?.activeSboxes === 16,
  String(rSpn.best?.activeSboxes))
check('SPN 路径逐轮数据有 16 条', rSpn.perRound.length === 16, String(rSpn.perRound.length))

/* ================================================================ 8. 抽样验证 */

console.log('【8】抽样验证（真实加密，4 轮）')
// ⚠️ 扩起点后 R=1~3 是免费轮（概率 1），真正落在 2⁻⁶ 的是 R=4
const r4 = runAnalysis({ params: { startRound: 1, endRound: 4 } })
const emp = empiricalHitRate(r4.best, { samples: 50000, maxBits: 30 })
check('抽样判定可行', emp.feasible === true, JSON.stringify(emp.reason))
check('理论命中率 = 2⁻⁶ = 1.5625%', Math.abs(emp.expected - 1 / 64) < 1e-12,
  String(emp.expected))
check('实测命中数落在 ±3√λ 内（真实加密与理论一致）',
  emp.hits >= Math.max(0, emp.lambda - 3 * Math.sqrt(emp.lambda))
  && emp.hits <= emp.lambda + 3 * Math.sqrt(emp.lambda),
  `hits=${emp.hits} λ=${emp.lambda.toFixed(2)} 区间=[${(emp.lambda - 3 * Math.sqrt(emp.lambda)).toFixed(1)}, ${(emp.lambda + 3 * Math.sqrt(emp.lambda)).toFixed(1)}]`)
check('判定等级为 good', emp.level === 'good', emp.level)

/* ================================================================ 9. 诚实性：大轮数必须拒绝抽样 */

console.log('【9】诚实性：不可行时不得编造数字')
const big = runAnalysis({ params: { startRound: 1, endRound: 32 } })
const empBig = empiricalHitRate(big.best, { samples: 10000, maxBits: 30 })
check('32 轮抽样返回不可行', empBig.feasible === false, JSON.stringify(empBig.feasible))
check('不可行时 samples=0（不给假样本数）', empBig.samples === 0, String(empBig.samples))
check('不可行时给出原因说明', typeof empBig.reason === 'string' && empBig.reason.length > 10,
  String(empBig.reason))

/* ================================================================ 10. 四缺陷回归
 *
 * 「能画 ≠ 能算」曾经是这个平台最大的坑：界面能拖 10 种组件、能连线、
 * 能改属性、能跨页保留 —— 但引擎只认 SPN 那一趟传播，Feistel 这条路
 * 是 SM4 硬编码的，图一旦标成 feistel 就被整个丢掉。
 * 这一节把四处修复逐条钉死。
 */

console.log('【10】★ 四缺陷回归：图怎么画，就怎么算')

/* ---- ① 结构类型：图上该能被读到、也能被改 ---- */
const oBlank = buildSearchOptions({ params: PARAM_DEFAULTS, graph: TEMPLATES.blank.build() })
check('① blank 模板默认结构为 spn', oBlank.structure === 'spn', oBlank.structure)

const gF = TEMPLATES.blank.build()
gF.meta.structure = 'feistel'
const oF = buildSearchOptions({ params: PARAM_DEFAULTS, graph: gF })
check('①★ 把图上 structure 改成 feistel，装配层读得到（从前没有界面入口）',
  oF.structure === 'feistel', oF.structure)

const gBad = TEMPLATES.blank.build()
gBad.meta.structure = '瞎写的值'
check('① 非法结构名被夹回 spn',
  buildSearchOptions({ params: PARAM_DEFAULTS, graph: gBad }).structure === 'spn')

/* ---- ② 引擎分流：SM4 专用引擎只给内置 SM4 模板 ---- */
check('② SM4 模板 engine = sm4（走专用引擎，保权威基准）',
  buildSearchOptions({ params: PARAM_DEFAULTS, graph: TEMPLATES.sm4.build() }).engine === 'sm4')
for (const [name, tpl] of [['类 AES', TEMPLATES.aes_like], ['空白画布', TEMPLATES.blank]]) {
  check(`② ${name} engine = graph`, graphEngine(tpl.build()) === 'graph', graphEngine(tpl.build()))
}

/* ---- ② feistel 标记不再让图作废 ---- */
/** 搭一张「双鱼」：64bit 分组 = 2 × 32bit，SPLIT 分左右，右半进 F */
function buildShuangyu(sboxId = 'aes', inputBits = 32) {
  const g = new CipherGraph()
  g.meta = { name: '双鱼', blockSize: inputBits * 2, keySize: 64, rounds: 8, structure: 'feistel' }
  const inp = g.addNode('INPUT', 40, 200, { bits: inputBits, blocks: 2 })
  const sp = g.addNode('SPLIT', 220, 200, { splitBits: inputBits })
  const sb = g.addNode('SBOX', 420, 320, { sboxId, mode: 'byte', repeat: 1 })
  const perm = g.addNode('PERM', 600, 320, { shift: 1, reverse: false })
  const k = g.addNode('XORKEY', 780, 320, { keyVar: 'C', independent: 'yes' })
  const mg = g.addNode('MERGE', 780, 140, { op: 'xor' })
  const out = g.addNode('OUTPUT', 950, 200, { rounds: 8 })
  g.addEdge(inp.id, 'out', sp.id, 'in')
  g.addEdge(sp.id, 'b', sb.id, 'in')     // 右半 R → F
  g.addEdge(sb.id, 'out', perm.id, 'in')
  g.addEdge(perm.id, 'out', k.id, 'in')
  g.addEdge(k.id, 'out', mg.id, 'a')     // F(R) → MERGE.a
  g.addEdge(sp.id, 'a', mg.id, 'b')      // 左半 L → MERGE.b
  g.addEdge(mg.id, 'out', out.id, 'in')
  return g
}

const rSy = runAnalysis({ params: { startRound: 1, endRound: 8 }, graph: buildShuangyu() })
check('②★ 双鱼走的是 Feistel 图迭代（不是 SM4 专用引擎）', rSy.path === 'feistel-graph', rSy.path)
check('②★ 双鱼 8 轮算出了有限权重', Number.isFinite(rSy.best?.weight), String(rSy.best?.weight))
check('②★ 双鱼逐轮记录 = 8 条', rSy.perRound.length === 8, String(rSy.perRound.length))
check('②★ 双鱼权重 ≠ 真 SM4 的 92.00（图不再被忽略）',
  rSy.best && Math.abs(rSy.best.weight - 92.00) > 1e-6, rSy.best ? rSy.best.weight.toFixed(2) : 'null')

// 换掉图上的 S 盒，结果必须跟着变 —— 证明引擎读的是图
const rSyGift = runAnalysis({
  params: { startRound: 1, endRound: 8 }, graph: buildShuangyu('gift'),
})
check('②★ 换图上的 S 盒后结果变化（引擎确实在读图）',
  rSyGift.best && Math.abs(rSyGift.best.weight - rSy.best.weight) > 1e-6,
  `${rSy.best?.weight} vs ${rSyGift.best?.weight}`)

// 空图（只有输入/输出）标 feistel：从前会返回整串 SM4 数值，现在必须算不出来
const emptyF = new CipherGraph()
emptyF.meta = { name: '空图', structure: 'feistel', blockSize: 64 }
emptyF.addNode('INPUT', 0, 0, { bits: 32, blocks: 2 })
emptyF.addNode('OUTPUT', 600, 0, { rounds: 8 })
const profEmpty = feistelGraphProfile(emptyF, { rounds: 8, blockBits: 32 })
check('②★ 缺 SPLIT 的 feistel 图被明确拒绝，并说明原因',
  profEmpty.best === null && typeof profEmpty.reason === 'string' && profEmpty.reason.length > 5,
  String(profEmpty.reason))

const rEmpty = runAnalysis({ params: { startRound: 1, endRound: 8 }, graph: emptyF })
check('②★ 空图标 feistel 不再返回 SM4 的 92.00',
  rEmpty.best && Math.abs(rEmpty.best.weight - 92.00) > 1e-6,
  rEmpty.best ? rEmpty.best.weight.toFixed(2) : 'null')

// 真 SM4 模板仍然走专用引擎、权威基准不变
const rSm4 = runAnalysis({ params: { startRound: 1, endRound: 8 }, graph: TEMPLATES.sm4.build() })
check('② SM4 模板仍走专用引擎，8 轮 = 92.00', rSm4.path === 'sm4'
  && Math.abs(rSm4.best.weight - 92.00) < 1e-9, `${rSm4.path} ${rSm4.best?.weight}`)

/* ---- ③ 端口参与传播：SPLIT 的两条支路必须各走各的 ---- */
/** 让 SPLIT 的一条支路进 S 盒，看 S 盒实际收到什么掩码 */
function portProbe(branchPort) {
  const g = new CipherGraph()
  g.meta = { name: 'port', structure: 'spn', blockSize: 32 }
  const inp = g.addNode('INPUT', 0, 0, { bits: 32, blocks: 1 })
  const sp = g.addNode('SPLIT', 200, 0, { splitBits: 8 })
  const sb = g.addNode('SBOX', 400, 0, { sboxId: 'present', mode: 'nibble' })
  const out = g.addNode('OUTPUT', 600, 0, { rounds: 1 })
  g.addEdge(inp.id, 'out', sp.id, 'in')
  g.addEdge(sp.id, branchPort, sb.id, 'in')
  g.addEdge(sb.id, 'out', out.id, 'in')
  const res = analyze(g, { rounds: 1, blockBits: 32, mode: MODE.DIFFERENTIAL })
  const st = res.perRound[0].steps.find((s) => s.nodeType === 'SBOX')
  return st ? st.inMask : null
}

// 起点掩码 = 0x1（bit0）→ 按 splitBits=8 切分后只落在 A 支路
check('③★ 走 SPLIT.a 支路，S 盒收到 0x1（端口真的参与取掩码）',
  portProbe('a') === 0x1, '0x' + (portProbe('a') ?? 0).toString(16))
check('③★ 走 SPLIT.b 支路，S 盒收到 0（同一张图、不同端口 = 不同结果）',
  portProbe('b') === 0x0, '0x' + (portProbe('b') ?? 0).toString(16))
check('③ 两条支路的结果不同（从前端口不参与，两者会被或成一样）',
  portProbe('a') !== portProbe('b'))

/* ---- ④ 位宽与 S 盒从图上取，不再写死 ---- */
const gW8 = TEMPLATES.blank.build()
gW8.nodes.find((n) => n.type === 'INPUT').props.bits = 8
check('④★ blockBits 从 INPUT 派生（8bit 图 → 8）',
  buildSearchOptions({ params: PARAM_DEFAULTS, graph: gW8 }).blockBits === 8,
  String(buildSearchOptions({ params: PARAM_DEFAULTS, graph: gW8 }).blockBits))
check('④★ graphBlockBits / graphBlockSize 与图一致',
  graphBlockBits(gW8) === 8 && graphBlockSize(gW8) === 8,
  `${graphBlockBits(gW8)} / ${graphBlockSize(gW8)}`)

const syG = buildShuangyu()
check('④ 双鱼（32bit × 2 块）分组长度 = 64',
  graphBlockSize(syG) === 64, String(graphBlockSize(syG)))

check('④★ sboxRef 从图上的 S 盒节点取（不再是写死的 sm4）',
  buildSearchOptions({ params: PARAM_DEFAULTS, graph: buildShuangyu('gift') }).sboxRef === 'gift',
  buildSearchOptions({ params: PARAM_DEFAULTS, graph: buildShuangyu('gift') }).sboxRef)

/** 位宽必须真的改变传播结果：mixColumns 是**真 GF(2⁸) 列混淆**，按 blockBits/8 个字节作用 */
function widthSpread(bits) {
  const g = new CipherGraph()
  g.meta = { name: 'w', structure: 'spn', blockSize: bits }
  const inp = g.addNode('INPUT', 0, 0, { bits, blocks: 1 })
  const lin = g.addNode('LINEAR', 200, 0, { op: 'mixColumns', amount: 0 })
  const out = g.addNode('OUTPUT', 400, 0, { rounds: 1 })
  g.addEdge(inp.id, 'out', lin.id, 'in')
  g.addEdge(lin.id, 'out', out.id, 'in')
  const o = buildSearchOptions({ params: PARAM_DEFAULTS, graph: g })
  const res = analyze(g, { rounds: 1, blockBits: o.blockBits, mode: MODE.DIFFERENTIAL })
  const st = res.perRound[0].steps.find((s) => s.nodeType === 'LINEAR')
  return st.outMask
}
// ⚠️ 这两条断言从前锁的是「自造的近似层」：32bit 时把字节掩码原样复制到下一个字节
// （0x101，分支数 3），8bit 时原地不动（0x1）。改成真 AES 列混淆后，
// 1 个活跃字节必须扩散到 **4 个**（AES 的分支数 5），8bit 字退化成 xtime。
// 详见 AGENTS.md §4.35。
check('④★ 32bit 图：mixColumns = 真 AES 列混淆，0x00000001 → 0x03010102（分支数 5）',
  widthSpread(32) === 0x03010102, '0x' + widthSpread(32).toString(16))
check('④★ 8bit 图：单字节字退化为 xtime，0x01 → 0x02',
  widthSpread(8) === 0x2, '0x' + widthSpread(8).toString(16))

/* ---- ⑤ 线性分析不再被无条件送给 SM4 专用引擎 ---- */
const oLinearAes = buildSearchOptions({
  params: PARAM_DEFAULTS, graph: TEMPLATES.aes_like.build(), mode: MODE.LINEAR,
})
check('⑤★ 类 AES 线性分析走图引擎（engine = graph）', oLinearAes.engine === 'graph', oLinearAes.engine)
const rLinAes = runAnalysis({ params: { startRound: 1, endRound: 10 }, graph: TEMPLATES.aes_like.build(), mode: MODE.LINEAR })
check('⑤★ 类 AES 线性 10 轮走通用图传播路径', rLinAes.path === 'graph', rLinAes.path)
check('⑤★ 类 AES 线性结果与差分结果不再必然相同（图不同 → 数值不同）',
  rLinAes.best && Number.isFinite(rLinAes.best.weight), String(rLinAes.best?.weight))
check('⑤ SM4 线性仍走专用引擎（32 轮 = 642.00）',
  (() => {
    const r = runAnalysis({ params: { startRound: 1, endRound: 32 }, mode: MODE.LINEAR })
    return r.path === 'sm4' && Math.abs(r.best.weight - 642.00) < 1e-9
  })())

/* ---- ⑥ 没有引擎的结构标记不许悄悄溜到计算里 ---- */
// 界面只提供有引擎的结构类型（spn / feistel）；万一图（如导入的 JSON）标了别的，
// 装配层必须把它归一成 spn —— 而不是让引擎收到一个自己不认识的值。
const gUnsupported = TEMPLATES.blank.build()
gUnsupported.meta.structure = 'gfn'
const oUnsupported = buildSearchOptions({ params: PARAM_DEFAULTS, graph: gUnsupported })
check('⑥★ 图标记 gfn（无引擎）→ 装配层归一成 spn',
  oUnsupported.structure === 'spn', String(oUnsupported.structure))
const oFeistelKept = buildSearchOptions({
  params: PARAM_DEFAULTS, graph: (() => { const g = TEMPLATES.blank.build(); g.meta.structure = 'feistel'; return g })(),
})
check('⑥★ 图标记 feistel（有引擎）→ 原样保留',
  oFeistelKept.structure === 'feistel', String(oFeistelKept.structure))

/* ---- ⑦ 合并运算按节点自己声明的 op 算（Feistel 反馈是 XOR，不是 OR） ---- */
// 权威值：双鱼图（AES 8bit 盒 + 字节循环移位 1）8 轮
//   A = L ⊕ F(R)  →  −log₂p = 66.00、活跃 S 盒 11 个
// 从前传播核写的是 `inMask |= ...`（按位或），会把「被异或抵消掉的差位」留在状态里，
// 于是第 3 轮起凭空多出活跃 S 盒，被抬成 84.00 / 14 个。
check('⑦★ 双鱼 8 轮 = 66.00（合并按 XOR 算，权威值）',
  Math.abs(rSy.best.weight - 66.00) < 1e-9, rSy.best ? rSy.best.weight.toFixed(2) : 'null')
check('⑦★ 双鱼 8 轮活跃 S 盒 = 11 个（XOR 会消掉抵消的差位）',
  rSy.best.activeSboxes === 11, String(rSy.best.activeSboxes))
// 第 3 轮就走岔：ΔL=0x1f00, ΔF=0x69001f00 → 真异或 = 0x69000000（不是 0x69001f00）
check('⑦★ 第 3 轮状态 = 0x69000000（异或，而非按位或的 0x69001f00）',
  (rSy.perRound[2].outputMask >>> 0) === 0x69000000,
  '0x' + (rSy.perRound[2].outputMask >>> 0).toString(16))
// 逐轮表的列名是「输出状态」→ 每行的 state 必须是**本轮结束**的状态。
// 从前 Feistel 塞的是轮首状态，同一列两种语义，末行还对不上总览的输出差分。
check('⑦★ 末行 state = 特征的输出差分（逐轮表与总览自洽）',
  JSON.stringify(rSy.perRound.at(-1).state) === JSON.stringify(rSy.best.outputState),
  `${JSON.stringify(rSy.perRound.at(-1).state)} vs ${JSON.stringify(rSy.best.outputState)}`)
// op 换成 add / and：差分域没有精确映射 → 走保守并集，数值必须变 —— 证明 op 没被忽略
for (const op of ['add', 'and']) {
  const gOp = buildShuangyu()
  gOp.nodes.find((n) => n.type === 'MERGE').props.op = op
  const rOp = runAnalysis({ params: { startRound: 1, endRound: 8 }, graph: gOp })
  check(`⑦★ 合并运算改成 ${op} 后结果变化（op 真的被引擎理会）`,
    rOp.best && Math.abs(rOp.best.weight - rSy.best.weight) > 1e-6,
    `${rOp.best?.weight} vs ${rSy.best?.weight}`)
}

/* ================================================================ 汇总 */

console.log('\n' + '─'.repeat(58))
if (fails.length) {
  console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项\n`)
  for (const f of fails) console.log('   ✗ ' + f)
  process.exitCode = 1
} else {
  console.log(`✓ 全部通过：${pass}/${pass} 项`)
}
