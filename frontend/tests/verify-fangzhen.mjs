/**
 * 「方阵」SPN 设计的**独立复核**（不信任平台引擎的自证）。
 *
 * 被测对象：用户提出的 AES 风格 SPN —— 128 位 4×4 字节矩阵 / 6 轮
 *   SubBytes → ShiftRows → MixColumns → AddConstant，末轮省略 MixColumns。
 *
 * 这份复核要回答三个「平台验证要点」，而且答案必须来自**独立证据**：
 *   ① 128 位能否表示为 4×4 矩阵并支持行列操作？
 *   ② 能否串联 GF(2⁸) 乘法的列混淆？
 *   ③ 能否实现「末轮跳过某层」的条件逻辑或手动连线差异？
 *
 * 手法（与 verify-shuangyu.mjs 同款：换一条独立路径）：
 *   · 独立实现 GF(2⁸) 乘法 / AES 列混淆矩阵，与平台实现逐值对拍；
 *   · **黑盒**测出平台 mixColumns 的**两套**实现（差分传播用掩码级、加密用值级）
 *     各自的线性映射，检验二者是否自洽（线性层必须满足「同一语义」）；
 *   · 平台**自己加密**出来的差分校验平台**自己分析**出来的差分 —— 自证矛盾即可证伪；
 *   · 独立搜索真 GF(2⁸) 版 6 轮最优特征，与平台报告值对照；
 *   · 独立复现「类 AES 10 轮」的权威基准（222.00 / 37 个活跃 S 盒）。
 *
 * ⚠️ 本套件在 2026-10-14 有一次**断言翻转**：此前它锁的是「平台的近似层有多错」
 *    （两套实现互相矛盾、分支数 3、饱和即恒等）。那批缺陷修好后，同一条款改锁
 *    **正确行为**（掩码级 = 值级 = 真 AES、分支数 5）—— 所以它不是"改断言凑绿"，
 *    而是缺陷消失后本该如此。修法见 AGENTS.md §4.35。
 *
 * 跑法（【11】需要先跑过 design-fangzhen.cjs 生成 session.json）：
 *   node frontend/tests/verify-fangzhen.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SBoxLibrary } from '../src/core/sboxlib.js'
import { BUILTIN_SBOXES } from '../src/core/sbox.js'
import { CipherGraph, graphBlockBits, graphBlockSize, NODE_TYPES } from '../src/core/graph.js'
import {
  MODE, analyze, forwardEncrypt,
  gf256Mul, gf256Xtime, mixColumnsWord, mixColumnsMask,
} from '../src/core/analysis.js'

// 引擎依赖 globalThis.__SBOX_LIB__（SBoxLibrary 构造时会读 localStorage）
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
new SBoxLibrary()

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', '..', 'outputs', '方阵SPN设计记录')
const SRC = path.resolve(HERE, '..', 'src')

let pass = 0
const fails = []
function check(name, ok, got = '') {
  if (ok) { pass++; console.log('  ✓ ' + name); return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
  console.log('  ✗ ' + name + (got !== '' ? ` —— 实得: ${got}` : ''))
}
const hex = (v, w = 8) => '0x' + (v >>> 0).toString(16).padStart(w, '0')
const bytesOf = (w) => [0, 1, 2, 3].map((i) => (w >>> (i * 8)) & 0xff)
/** 活跃字节数（非零字节个数）*/
const activeBytes = (w) => bytesOf(w).filter((b) => b !== 0).length

/* ════════════════════════════════════════════ ① 真 GF(2⁸)：独立实现 */

/** 独立的 GF(2⁸) 乘法（与平台实现无关的另一份代码） */
function gmul(a, b) {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p & 0xff
}
/** 真 AES xtime：溢出时按 x⁸+x⁴+x³+x+1 约减（XOR 0x1b） */
const xtimeTrue = (b) => gmul(b, 2)

/** 独立实现真 AES 列混淆：out = [02 03 01 01] 循环矩阵 × in */
function mixColumnsTrue(word) {
  const a = bytesOf(word)
  const out = [0, 1, 2, 3].map((i) =>
    (gmul(a[i], 2) ^ gmul(a[(i + 1) % 4], 3) ^ a[(i + 2) % 4] ^ a[(i + 3) % 4]) & 0xff)
  return out.reduce((acc, b, i) => (acc | (b << (i * 8))) >>> 0, 0)
}
/** 真 ShiftRows 对**一列**是恒等；这里用字节循环左移 k 作为「行移位」的 32 位替身 */
const rotBytesLeft = (word, k) => {
  let o = 0
  for (let i = 0; i < 4; i++) o |= (((word >>> (((i - k + 8) % 4) * 8)) & 0xff) << (i * 8))
  return o >>> 0
}

console.log('\n【1】GF(2⁸) 乘法：独立实现 vs 平台导出实现（逐值对拍）')
check('★ xtime(0x80) = 0x1b（按 AES 约减多项式 —— 不是循环左移的 0x01）',
  xtimeTrue(0x80) === 0x1b, hex(xtimeTrue(0x80), 2))
check('★ 平台导出的 gf256Xtime 与独立实现逐值一致（256/256）',
  Array.from({ length: 256 }, (_, b) => gf256Xtime(b) === xtimeTrue(b)).every(Boolean),
  '有分歧')
let mulDiff = 0
for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) if (gf256Mul(a, b) !== gmul(a, b)) mulDiff++
check('★ 平台 gf256Mul 与独立 gmul 在 65536 个输入上全同',
  mulDiff === 0, `${mulDiff} 个不同`)
check('★ 32bit 字：mixColumnsWord(0x00000001) = 0x03010102 = 独立实现',
  mixColumnsWord(1, 32) === mixColumnsTrue(1) && mixColumnsTrue(1) === 0x03010102,
  `${hex(mixColumnsWord(1, 32))} vs ${hex(mixColumnsTrue(1))}`)
check('★ 平台掩码级 mixColumnsMask 与值级 mixColumnsWord 同源（32 个基向量全同）',
  Array.from({ length: 32 }, (_, b) => {
    const e = (1 << b) >>> 0
    return mixColumnsMask(e, 32) === mixColumnsWord(e, 32)
  }).every(Boolean),
  Array.from({ length: 32 }, (_, b) => {
    const e = (1 << b) >>> 0
    return mixColumnsMask(e, 32) !== mixColumnsWord(e, 32) ? hex(e) : null
  }).filter(Boolean).join('、'))

/* ════════════════════════════════════════════ ② 平台两套 mixColumns 的黑盒测量 */

/** 搭一张最小图：INPUT → LINEAR(mixColumns) → OUTPUT */
function buildLinearGraph({ bits = 32, blocks = 4 } = {}) {
  const g = new CipherGraph()
  g.meta = { name: '方阵·线性层探针', blockSize: bits * blocks, keySize: 128, rounds: 6, structure: 'spn' }
  const inp = g.addNode('INPUT', 40, 200, { bits, blocks })
  const lin = g.addNode('LINEAR', 440, 200, { op: 'mixColumns', amount: 0, mask: '0' })
  const out = g.addNode('OUTPUT', 640, 200, { rounds: 6 })
  g.addEdge(inp.id, 'out', lin.id, 'in')
  g.addEdge(lin.id, 'out', out.id, 'in')
  return { g }
}

/** 用平台**差分分析**测掩码级映射：逐 bit 指定起始差分（引擎现在认 initDiffs） */
function maskLevelMap() {
  const { g } = buildLinearGraph()
  const res = {}
  for (let b = 0; b < 32; b++) {
    const e = (1 << b) >>> 0
    const r = analyze(g, {
      mode: MODE.DIFFERENTIAL, rounds: 1, blockBits: 32, searchMode: 'greedy',
      initDiffs: [[e, 0, 0, 0]],
    })
    res[e] = r.perRound[0].outputMask >>> 0
  }
  return res
}

/** 用平台**自己的加密**测值级映射：M(e) = E(0) ⊕ E(e) */
function valueLevelMap() {
  const { g } = buildLinearGraph()
  const base = forwardEncrypt(g, 0, { rounds: 1, blockBits: 32 })
  const res = {}
  for (let b = 0; b < 32; b++) {
    const e = (1 << b) >>> 0
    res[e] = (forwardEncrypt(g, e, { rounds: 1, blockBits: 32 }) ^ base) >>> 0
  }
  return res
}

console.log('\n【2】黑盒测量平台 `mixColumns` 的**两套**实现（掩码级传播 vs 值级加密）')
console.log('     Δin（单 bit 基）      平台差分分析       平台自己加密       真 AES 列混淆')
const N = maskLevelMap()
const M = valueLevelMap()
const rows = []
for (let b = 0; b < 32; b++) {
  const e = (1 << b) >>> 0
  const t = mixColumnsTrue(e)
  rows.push({ e, N: N[e], M: M[e], T: t })
  if (b % 8 === 0) console.log(`     ${hex(e)}            ${hex(N[e])}          ${hex(M[e])}          ${hex(t)}`)
}
check('★ 平台「差分分析」说的 Δout = 平台「自己加密」出来的 Δout（32/32 基向量全同）',
  rows.every((r) => r.N === r.M),
  rows.filter((r) => r.N !== r.M).map((r) => `${hex(r.e)}: 分析=${hex(r.N)} vs 加密=${hex(r.M)}`).join('；'))
check('★ 两者都等于独立实现的真 AES 列混淆（32/32 基向量全同）',
  rows.every((r) => r.N === r.T && r.M === r.T),
  rows.filter((r) => r.N !== r.T || r.M !== r.T)
    .map((r) => `${hex(r.e)}: 平台=${hex(r.N)} 真AES=${hex(r.T)}`).join('；'))

/* ════════════════════════════════════════════ ③ 分支数（扩散能力） */

console.log('\n【3】分支数对比：1 个活跃字节进列混淆，出来几个活跃字节？（AES 规范要求 4）')
const bnPlatformMask = activeBytes(N[1])
const bnPlatformValue = activeBytes(M[1])
const bnTrue = activeBytes(mixColumnsTrue(1))
check('★ 真 AES 列混淆：1 → 4 个活跃字节（分支数 5，AES 的扩散保证）', bnTrue === 4, String(bnTrue))
check('★ 平台（掩码级）：1 → 4 个活跃字节 —— 与 AES 一致',
  bnPlatformMask === 4, String(bnPlatformMask))
check('★ 平台（值级）：1 → 4 个活跃字节', bnPlatformValue === 4, String(bnPlatformValue))
console.log(`     → 真 AES 单轮扩散 1→${bnTrue}；平台 1→${bnPlatformMask}（掩码级）/ 1→${bnPlatformValue}（值级）`)

/* ════════════════════════════════════════════ ④ 掩码级映射 = 值级映射 */

console.log('\n【4】线性层必须「同一语义」：差分域 Δout = M·Δin，M 就是值级映射')
const MatMask = new Array(32).fill(0)
const MatValue = new Array(32).fill(0)
for (let b = 0; b < 32; b++) {
  const e = (1 << b) >>> 0
  MatMask[b] = N[e]
  MatValue[b] = M[e]
}
let matDiff = 0
for (let b = 0; b < 32; b++) if (MatMask[b] !== MatValue[b]) matDiff++
check('★ 32 个基向量上掩码级与值级映射完全一致（0 个不同）', matDiff === 0, `${matDiff}/32 不同`)

// 顺带验证「线性」：M(a ⊕ b) = M(a) ⊕ M(b)
let linearOk = true
const pairs = [[1, 0x00000100], [0x01000000, 0x00000001], [0x00010000, 0x01000000]]
const { g: gLin } = buildLinearGraph()
const base = forwardEncrypt(gLin, 0, { rounds: 1, blockBits: 32 })
const valOf = (x) => (forwardEncrypt(gLin, x, { rounds: 1, blockBits: 32 }) ^ base) >>> 0
for (const [x, y] of pairs) if (valOf((x ^ y) >>> 0) !== ((valOf(x) ^ valOf(y)) >>> 0)) linearOk = false
check('★ 值级映射确实是 GF(2)-线性的（M(x⊕y) = M(x)⊕M(y)）', linearOk)

/* ════════════════════════════════════════════ ⑤ 128 位 / 4×4 矩阵 */

console.log('\n【5】验证要点①：128 位能否表示为 4×4 字节矩阵并支持行列操作？')
check('INPUT「位宽」上限就是 32（组件定义写死 max: 32）',
  NODE_TYPES.INPUT.props.find((p) => p.key === 'bits').max === 32,
  String(NODE_TYPES.INPUT.props.find((p) => p.key === 'bits').max))
const g128 = buildLinearGraph({ bits: 32, blocks: 4 }).g
check('★ 界面上「分组长度」能显示 128（32bit × 4 块）', graphBlockSize(g128) === 128, String(graphBlockSize(g128)))
check('★ 但引擎真正参与运算的词宽被夹到 32 —— 128 位进不去计算',
  graphBlockBits(g128) === 32, String(graphBlockBits(g128)))
const allOps = Object.values(NODE_TYPES).flatMap((t) => t.props.map((p) => `${t.label}.${p.label}`))
check('★ 组件库里没有任何「矩阵 / 行 / 列」节点（无行列数据结构）',
  !allOps.some((l) => /矩阵|行移位|列|行列/.test(l)), allOps.filter((l) => /矩阵|行移位|行列/.test(l)).join('；'))
const permProps = NODE_TYPES.PERM.props.map((p) => p.key)
check('★ 置换组件只有「一个」统一移位量（无法让第 i 行移 i 个字节）',
  permProps.length === 2 && permProps.includes('shift') && !permProps.some((k) => /row|perRow/i.test(k)),
  permProps.join(','))

/* ════════════════════════════════════════════ ⑥ 末轮跳过 / 条件逻辑 */

console.log('\n【6】验证要点③：能否实现「末轮跳过 MixColumns」的条件逻辑？')
const analysisSrc = fs.readFileSync(path.join(SRC, 'core', 'analysis.js'), 'utf8')
const graphSrc = fs.readFileSync(path.join(SRC, 'core', 'graph.js'), 'utf8')
// 引擎的轮循环：for (let r = r0; r <= totalRounds; r++) { ... propagateGraphOnce(...) }
// 窗口取 4000 字符：循环体里除传播内核外还夹杂 INPUT 多字注入（128bit=4×32bit）等
// 与「是否每轮同一内核」无关的常规语句，窗口须容得下它们（曾因 1400 太小而误报）。
const roundLoop = analysisSrc.match(/for \(let r = r0; r <= totalRounds; r\+\+\)[\s\S]{0,4000}?propagateGraphOnce\(/)
check('★ 引擎主循环对每轮调用**同一个** propagateGraphOnce（无「末轮专用」分支）', !!roundLoop)
// 更强的一条：循环体里不存在把 propagateGraphOnce 用「末轮」条件门控起来的写法
check('★ 循环体内 propagateGraphOnce 无「末轮专用」门控（不被 r === totalRounds 包住）',
  !/r\s*===\s*totalRounds[\s\S]{0,120}propagateGraphOnce\(|if\s*\([^)]*totalRounds[^)]*\)\s*\{?[\s\S]{0,120}propagateGraphOnce\(/.test(analysisSrc))
check('★ 该调用点没有传「第几轮」给节点语义（propagateGraphOnce 收到 round 但不做分层）',
  /propagateGraphOnce\(\{ graph, order, state, mode, blockBits, round: r \}\)/.test(analysisSrc))
check('★ 无任何「按轮次选层 / skip 某层」的分支（skip 只被 Feistel 引擎用于注入节点）',
  !/round\s*===\s*declaredRounds|isLastRound|lastRound/.test(analysisSrc),
  (analysisSrc.match(/isLastRound|lastRound/g) || []).join(','))
/** 在「会参与计算」的源码里搜某标识符 —— 只出现在 graph.js 的定义/模板里 = 死属性 */
const SRC_FILES = [
  ['core', 'analysis.js'], ['core', 'params.js'], ['core', 'explain.js'], ['core', 'model.js'],
  ['stores', 'platform.js'], ['views', 'AnalysisView.vue'], ['views', 'ResultsView.vue'],
  ['views', 'StructureEditorView.vue'],
]
function consumersOf(token) {
  const hits = []
  for (const rel of SRC_FILES) {
    const p = path.join(SRC, ...rel)
    if (!fs.existsSync(p)) continue
    const src = fs.readFileSync(p, 'utf8')
    if (new RegExp(`\\b${token}\\b`).test(src)) hits.push(rel.join('/'))
  }
  return hits
}
check('★ ROUND 的「展开为独立轮」哑属性已**删除**（不留「改了不影响计算」的开关）',
  !Object.prototype.hasOwnProperty.call(NODE_TYPES.ROUND.props.find((p) => p.key === 'unroll') || {}, 'key')
  && consumersOf('unroll').length === 0,
  consumersOf('unroll').join('、') || '(已无)')
check('★ XORKEY 的「独立轮密钥」**已接上语义**：引擎按轮次派生轮密钥（有消费者）',
  consumersOf('independent').includes('core/analysis.js'), consumersOf('independent').join('、') || '(无)')

// ★ 界面上的「起始差分 / 掩码」现在通用图路径也生效
const rInit = analyze(buildUniform(), {
  mode: MODE.DIFFERENTIAL, rounds: 1, blockBits: 32, searchMode: 'greedy',
  initDiffs: [[0x10000000, 0, 0, 0]],
})
check('★ 通用图路径**认**「起始差分」输入：请求 0x10000000 就真的从这里起步',
  rInit.perRound[0].inputMask === 0x10000000, hex(rInit.perRound[0].inputMask))
check('★ 顺带：通用图路径现在也填 outputState（结果页的「输出差分」不再是「未记录」）',
  Array.isArray(rInit.best?.outputState) && rInit.best.outputState.length === 1
  && rInit.best.outputState[0] === (rInit.perRound[0].outputMask >>> 0),
  JSON.stringify(rInit.best?.outputState))

/* ════════════════════════════════════════════ ⑦ AddConstant 语义 */

console.log('\n【7】AddConstant（固定 128 位常量 XOR）在平台上的等价性与缺口')
const xkProps = NODE_TYPES.XORKEY.props.map((p) => p.key)
check('★ XORKEY 只有「密钥变量名 / 是否独立」两项 —— 没有「常量值」输入框（无法指定 AES 那种固定常量）',
  xkProps.length === 2 && !xkProps.includes('constValue'), xkProps.join(','))
const gXor = (() => {
  const g = new CipherGraph()
  g.meta = { name: '常量探针', blockSize: 32, rounds: 1, structure: 'spn' }
  const inp = g.addNode('INPUT', 40, 200, { bits: 32, blocks: 1 })
  const xk = g.addNode('XORKEY', 240, 200, { keyVar: 'RC', independent: 'yes' })
  const out = g.addNode('OUTPUT', 440, 200, { rounds: 1 })
  g.addEdge(inp.id, 'out', xk.id, 'in'); g.addEdge(xk.id, 'out', out.id, 'in')
  return g
})()
const rXor = analyze(gXor, { mode: MODE.DIFFERENTIAL, rounds: 1, blockBits: 32, searchMode: 'greedy' })
check('★ 差分域里常量加层贡献 0（与 XOR 常量等价：不改变差分）',
  (rXor.perRound[0].outputMask >>> 0) === 1, hex(rXor.perRound[0].outputMask))
check('★ 数值域里常量是「由变量名 + 轮次派生的伪随机值」，不是可指定的常量',
  /keySchedule\(node\.props\.keyVar/.test(analysisSrc))

// 「独立轮密钥 = 否」= 各轮复用同一把 → 与「每轮独立」在**值级**必须给出不同结果
const gIndep = (() => {
  const g = new CipherGraph()
  g.meta = { name: '轮密钥探针', blockSize: 32, rounds: 4, structure: 'spn' }
  const inp = g.addNode('INPUT', 0, 0, { bits: 32, blocks: 1 })
  const xk = g.addNode('XORKEY', 0, 0, { keyVar: 'RC', independent: 'yes' })
  const out = g.addNode('OUTPUT', 0, 0, { rounds: 4 })
  g.addEdge(inp.id, 'out', xk.id, 'in'); g.addEdge(xk.id, 'out', out.id, 'in')
  return g
})()
const enc4 = (indep, n) => {
  gIndep.nodes.find((x) => x.type === 'XORKEY').props.independent = indep
  return forwardEncrypt(gIndep, 0x12345678, { rounds: n, blockBits: 32 })
}
check('★「独立轮密钥」真的影响真实加密：选「是」与「否」4 轮结果不同',
  enc4('yes', 4) !== enc4('no', 4),
  `${hex(enc4('yes', 4))} vs ${hex(enc4('no', 4))}`)
check('★「否」= 各轮复用同一把：4 轮结果 = 单轮密钥异或 4 次 = 0 次（密钥自己抵消）',
  enc4('no', 4) === 0x12345678, hex(enc4('no', 4)))

/* ════════════════════════════════════════════ ⑧ 独立搜索：真 GF(2⁸) 版 6 轮 */

console.log('\n【8】独立搜索「真 GF(2⁸) 列混淆」版 4 字节 6 轮最优差分特征（与平台同款贪心/束搜索）')
const AES_S = BUILTIN_SBOXES.aes.table
const DDT = Array.from({ length: 256 }, () => new Uint16Array(256))
for (let a = 0; a < 256; a++) for (let x = 0; x < 256; x++) DDT[a][AES_S[x] ^ AES_S[x ^ a]]++
/** 该行 DDT 里达到最大值的**全部**输出差分（贪心/束搜索要枚举，不能只取第一个） */
function bestOutputs(d) {
  const row = DDT[d]
  let mx = 0
  for (let b = 1; b < 256; b++) if (row[b] > mx) mx = row[b]
  const outs = []
  for (let b = 1; b < 256; b++) if (row[b] === mx) outs.push(b)
  return { outs, count: mx }
}
const perSboxBits = -Math.log2(4 / 256) // AES 最大 DDT 4/256 → 2⁻⁶

/** 束搜索：状态 = 32 位字节差分；每轮 = 逐字节 S 盒 → 字节循环移位 → 层 */
function searchTrail({ rounds = 6, mix, shift = 1, beam = 400, lastSkipsMix = true }) {
  let base = [{ w: 1, cost: 0, trail: [1] }]
  const out = []
  for (let r = 1; r <= rounds; r++) {
    const nxt = []
    for (const st of base) {
      const act = bytesOf(st.w).map((b, i) => [b, i]).filter(([b]) => b !== 0)
      const opts = act.map(([b]) => bestOutputs(b).outs)
      const combos = opts.reduce((acc, os) => acc.flatMap((c) => os.map((o) => c.concat([o]))), [[]])
      for (const combo of combos) {
        let w = 0
        act.forEach(([, i], k) => { w |= (combo[k] << (i * 8)) })
        w = rotBytesLeft(w, shift)
        if (!(lastSkipsMix && r === rounds)) w = mix(w)
        const cost = st.cost + act.length * perSboxBits
        nxt.push({ w: w >>> 0, cost, trail: st.trail.concat([w >>> 0]) })
      }
    }
    nxt.sort((a, b) => a.cost - b.cost || activeBytes(a.w) - activeBytes(b.w))
    base = nxt.slice(0, beam)
    out.push({ round: r, minActive: Math.min(...base.map((s) => activeBytes(s.w))), best: base[0] })
  }
  return { end: base[0], perRound: out }
}
const trueTrail = searchTrail({ rounds: 6, mix: mixColumnsTrue, shift: 1 })
const trueActive = 1 + trueTrail.perRound.slice(0, -1).reduce((a, p) => a + activeBytes(p.best.w), 0)
console.log(`     独立搜索（真 GF(2⁸)，末轮省列混淆）：末轮 Δ = ${hex(trueTrail.end.w)}`
  + `｜累计 −log₂p = ${trueTrail.end.cost.toFixed(2)}｜活跃字节轨迹 `
  + `${trueTrail.perRound.map((p) => activeBytes(p.best.w)).join('→')}`)
/** 严格下界：列混淆分支数 5 ⇒ 每 2 轮 ≥ 5 个活跃字节 ⇒ 6 轮 ≥ 15（这条不依赖搜索） */
const LOWER_BOUND = 15

/* ════════════════════════════════════════════ ⑨ 末轮跳过的「手工连线差异」可行性 */

console.log('\n【9】验证要点③的正面答案：手工把轮函数展开、让末轮少一层，引擎认不认？')

function buildUniform() {
  const g = new CipherGraph()
  g.meta = { name: '方阵·统一轮函数', blockSize: 128, keySize: 128, rounds: 6, structure: 'spn' }
  const inp = g.addNode('INPUT', 0, 0, { bits: 32, blocks: 4 })
  const s = g.addNode('SBOX', 0, 0, { sboxId: 'aes', mode: 'byte', repeat: 1 })
  const p = g.addNode('PERM', 0, 0, { shift: 1, reverse: false })
  const m = g.addNode('LINEAR', 0, 0, { op: 'mixColumns', amount: 0 })
  const k = g.addNode('XORKEY', 0, 0, { keyVar: 'RC' })
  const out = g.addNode('OUTPUT', 0, 0, { rounds: 6 })
  g.addEdge(inp.id, 'out', s.id, 'in'); g.addEdge(s.id, 'out', p.id, 'in')
  g.addEdge(p.id, 'out', m.id, 'in'); g.addEdge(m.id, 'out', k.id, 'in')
  g.addEdge(k.id, 'out', out.id, 'in')
  return g
}

/** 手工展开 N 轮；可分别让「第 1 轮」或「最后一轮」省掉列混淆（靠少一个节点+一条连线表达） */
function buildUnrolled({ rounds = 6, lastSkipsMix = false, firstSkipsMix = false }) {
  const g = new CipherGraph()
  g.meta = { name: '方阵·手工展开', blockSize: 128, keySize: 128, rounds: 1, structure: 'spn' }
  const inp = g.addNode('INPUT', 0, 0, { bits: 32, blocks: 4 })
  let prev = inp
  for (let r = 1; r <= rounds; r++) {
    const s = g.addNode('SBOX', 0, 0, { sboxId: 'aes', mode: 'byte', repeat: 1 })
    const p = g.addNode('PERM', 0, 0, { shift: 1, reverse: false })
    const k = g.addNode('XORKEY', 0, 0, { keyVar: 'RC' })
    g.addEdge(prev.id, 'out', s.id, 'in')
    g.addEdge(s.id, 'out', p.id, 'in')
    const skip = (lastSkipsMix && r === rounds) || (firstSkipsMix && r === 1)
    if (skip) {
      g.addEdge(p.id, 'out', k.id, 'in')
    } else {
      const m = g.addNode('LINEAR', 0, 0, { op: 'mixColumns', amount: 0 })
      g.addEdge(p.id, 'out', m.id, 'in')
      g.addEdge(m.id, 'out', k.id, 'in')
    }
    prev = k
  }
  const out = g.addNode('OUTPUT', 0, 0, { rounds: 1 })
  g.addEdge(prev.id, 'out', out.id, 'in')
  return g
}

const runG = (g, rounds) => analyze(g, {
  mode: MODE.DIFFERENTIAL, rounds, blockBits: 32, searchMode: 'greedy',
})
const gU = buildUniform()
const gF = buildUnrolled({ rounds: 6 })
const gS = buildUnrolled({ rounds: 6, lastSkipsMix: true })
const gT2 = buildUnrolled({ rounds: 2 })
const gT2s = buildUnrolled({ rounds: 2, firstSkipsMix: true })
const u6 = runG(gU, 6)
const f6 = runG(gF, 1)
const s6 = runG(gS, 1)
const t2 = runG(gT2, 1)
const t2s = runG(gT2s, 1)
const lastMask = (r) => r.perRound[r.perRound.length - 1].outputMask >>> 0
const wOf = (r) => r.perRound[r.perRound.length - 1].weight
const aOf = (r) => r.perRound[r.perRound.length - 1].cumActive
const line = (name, g, r) => `     ${name}：${g.nodes.length} 节点｜−log₂p = ${wOf(r).toFixed(2)}`
  + `｜活跃 S 盒 ${aOf(r)}｜末轮 Δ = ${hex(lastMask(r))}`
console.log(line('统一轮函数 × 6 轮 ', gU, u6))
console.log(line('手工展开 6 轮全层 ', gF, f6))
console.log(line('手工展开 6 轮省 MC', gS, s6))
console.log(line('手工展开 2 轮全层 ', gT2, t2))
console.log(line('手工展开 2 轮省 MC1', gT2s, t2s))

check('★ 手工展开的整条链被当作**一趟传播**跑完（逐轮表只有 1 行）',
  f6.perRound.length === 1 && s6.perRound.length === 1,
  `${f6.perRound.length} / ${s6.perRound.length}`)
check('★ 手工展开图规模 = 6×(S+P+K) + 6×MC + 输入 + 输出 = 26 节点（省末轮 MC = 25）',
  gF.nodes.length === 26 && gS.nodes.length === 25, `${gF.nodes.length} / ${gS.nodes.length}`)
check('★ 展开 6 轮 ≡ 统一轮函数迭代 6 轮：权重与末轮 Δout 完全一致（两条路径语义统一）',
  Math.abs(wOf(f6) - wOf(u6)) < 1e-9 && lastMask(f6) === lastMask(u6),
  `${wOf(f6).toFixed(2)}/${hex(lastMask(f6))} vs ${wOf(u6).toFixed(2)}/${hex(lastMask(u6))}`)
check('★ 末轮省略 MixColumns 现在**可观测**：末轮 Δout 与全层版不同（真 GF(2⁸) 不再是恒等映射）',
  lastMask(s6) !== lastMask(f6), `${hex(lastMask(s6))} vs ${hex(lastMask(f6))}`)
check('★ 但 −log₂p 仍然相同 —— 代价只统计「各轮进 S 盒的活跃字节数」，末轮的层不改变它',
  Math.abs(wOf(s6) - wOf(f6)) < 1e-9 && aOf(s6) === aOf(f6),
  `${wOf(s6).toFixed(2)} vs ${wOf(f6).toFixed(2)}`)
check('★ 「手工连线的逐轮差异」被引擎执行：把差异放到**第 1 轮**（去掉 MC1），权重与活跃都变',
  wOf(t2s) !== wOf(t2) && aOf(t2s) < aOf(t2),
  `${wOf(t2s).toFixed(2)}/${aOf(t2s)} vs ${wOf(t2).toFixed(2)}/${aOf(t2)}`)
check('★ 而且末轮 Δout 也跟着变了 —— 图怎么画就怎么算，不是空话',
  lastMask(t2s) !== lastMask(t2), `${hex(lastMask(t2s))} vs ${hex(lastMask(t2))}`)
check('★ 省末轮 MC 的 6 轮末轮 Δout = 独立搜索的同条件末轮 Δout（两手独立算法互证）',
  lastMask(s6) === (trueTrail.end.w >>> 0),
  `${hex(lastMask(s6))} vs ${hex(trueTrail.end.w)}`)

/* ════════════════════════════════════════════ ⑩ 类 AES 10 轮：独立复现权威基准 */

console.log('\n【10】独立复现「类 AES 10 轮」（真 GF(2⁸) 列混淆，PERM 恒等）—— 权威基准必须能从零算出来')
const aesTrail = searchTrail({ rounds: 10, mix: mixColumnsTrue, shift: 0, beam: 4000, lastSkipsMix: false })
const aesActive = 1 + aesTrail.perRound.slice(0, -1).reduce((a, p) => a + activeBytes(p.best.w), 0)
console.log(`     独立复现：累计活跃 S 盒 ${aesActive}（每轮 ${aesTrail.perRound.map((p) => activeBytes(p.best.w)).join('→')}）`
  + `｜权重 = ${(aesActive * perSboxBits).toFixed(2)}`)
check('★ 独立复现类 AES 10 轮 = 37 个活跃 S 盒（1 + 9×4：分支数 5 ⇒ 每轮稳定新增 4）',
  aesActive === 37, String(aesActive))
check('★ 权重 = 37 × 6.00 = 222.00（与 verify-core 的权威基准一致）',
  Math.abs(aesActive * perSboxBits - 222.00) < 1e-9, (aesActive * perSboxBits).toFixed(2))

/* ════════════════════════════════════════════ ⑪ 与浏览器留档对拍 */

console.log('\n【11】与真实浏览器留档（session.json）对拍')
console.log(`     独立搜索：真 GF(2⁸) 版 ${trueActive} 个活跃 / ${trueTrail.end.cost.toFixed(2)}`
  + `；严格下界 ${LOWER_BOUND} 个（分支数 5 导出）`)

const sessPath = path.join(OUT, 'session.json')
if (fs.existsSync(sessPath)) {
  const sess = JSON.parse(fs.readFileSync(sessPath, 'utf8'))
  const g = sess.graph
  const inp = g.nodes.find((n) => n.type === 'INPUT')
  check('留档图里 INPUT 位宽 = 32、分块数 = 4（界面显示 128 位）',
    inp.props.bits === 32 && inp.props.blocks === 4, `${inp.props.bits}×${inp.props.blocks}`)
  check('★ 界面「分组长度」显示 128，而引擎日志写的是「词宽 32bit」——一张图两套口径',
    String(sess.blockBitsProbe.blockSizeField).startsWith('128') && /32bit/.test(sess.engineLine || ''),
    `分组长度=${sess.blockBitsProbe.blockSizeField}｜引擎行=${sess.engineLine}`)
  check('★ 往「位宽」里填 128 会被界面当场夹回 32（组件定义 max=32）',
    String(sess.blockBitsProbe.inputValueAfterFill128) === '32',
    String(sess.blockBitsProbe.inputValueAfterFill128))

  const rowsB = sess.roundTable.differential.rows
  const lastRow = rowsB[rowsB.length - 1]
  const wBrowser = parseFloat(lastRow[3])
  const aBrowser = parseInt(lastRow[5], 10)
  console.log(`     浏览器 6 轮逐轮表末行：累计 −log₂p = ${wBrowser.toFixed(2)}｜累计活跃 S 盒 = ${aBrowser}`)
  check('★ 浏览器跑出的 6 轮 −log₂p = 独立搜索的真 GF(2⁸) 值 —— 引擎与复现互为佐证',
    Math.abs(wBrowser - trueTrail.end.cost) < 0.01,
    `${wBrowser} vs ${trueTrail.end.cost.toFixed(2)}`)
  check('★ 浏览器跑出的 6 轮活跃 S 盒 = 独立搜索值',
    aBrowser === trueActive, `${aBrowser} vs ${trueActive}`)
  check('★ 且都高于「分支数 5」导出的严格下界 15',
    LOWER_BOUND === 15 && aBrowser >= LOWER_BOUND && trueActive >= LOWER_BOUND,
    `${aBrowser} / ${trueActive} ≥ ${LOWER_BOUND}`)

  // 末轮跳过的手工连线实验
  const u = sess.unrollExperiment || {}
  if (u.skipLast && u.fullTwoRounds) {
    const lw = (t) => parseFloat(t.roundTable.rows[t.roundTable.rows.length - 1][3])
    console.log(`     手工小样（末轮省列混淆）：−log₂p = ${lw(u.skipLast).toFixed(2)}｜${u.skipLast.outputDiff}`)
    console.log(`     两轮全层对照：            −log₂p = ${lw(u.fullTwoRounds).toFixed(2)}｜${u.fullTwoRounds.outputDiff}`)
    check('★ 手工展开的链在界面上跑得通（1 轮 = 整条链一趟传播）',
      parseFloat(u.skipLast.metrics['运行轮数?']?.value) === 1 || /1轮/.test(JSON.stringify(u.skipLast.metrics)))
    check('★ 结果页的「输出差分」不再是「未记录」—— 通用图路径已填 outputState',
      !/未记录/.test(String(u.skipLast.outputDiff)) && !/未记录/.test(String(u.fullTwoRounds.outputDiff)),
      `${u.skipLast.outputDiff} ／ ${u.fullTwoRounds.outputDiff}`)
    check('★ 两份 −log₂p 一模一样（代价只数各轮进 S 盒的活跃字节，末轮的层不改变它）',
      Math.abs(lw(u.skipLast) - lw(u.fullTwoRounds)) < 0.01,
      `${lw(u.skipLast)} vs ${lw(u.fullTwoRounds)}`)
    check('★ 但「末轮少一层」确实进了图：两份的建模规模不同（变量数/子句数不一样）',
      JSON.stringify(u.skipLast.metrics) !== JSON.stringify(u.fullTwoRounds.metrics),
      '指标卡完全一致')
  } else {
    console.log('     （未找到手工连线实验数据）')
  }
} else {
  console.log('     （未找到 session.json —— 先跑 design-fangzhen.cjs 再做这一节）')
}

/* ════════════════════════════════════════════ 汇总 */

console.log('\n' + '─'.repeat(64))
console.log(`通过 ${pass} 项` + (fails.length ? `，失败 ${fails.length} 项：\n  - ` + fails.join('\n  - ') : '，全部通过'))
process.exit(fails.length ? 1 : 0)
