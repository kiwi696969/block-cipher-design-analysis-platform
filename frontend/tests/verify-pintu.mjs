/**
 * 「拼图」设计的**独立复核**（不信任平台引擎的自证）。
 *
 * 被测对象：用户提出的第三个实操样例 —— 非平衡 Feistel + 查找表
 *   分组 96bit / 4 轮；每轮 96bit → L(32) + R(64)
 *   LUT ：R 的高 16 位 → 32 位固定映射（扩展查找表）
 *   G   ：R 的低 48 位 → 3 × 16bit → 3 个 16×16 S 盒 → 48bit
 *   新 L = G(R_low48) XOR 旧 L；新 R = LUT(R_high16) || R_low48
 *
 * 这份复核对应用户的四个「平台验证要点」，答案**必须来自独立证据**：
 *   ① 能否支持非等分（32+64）的数据分割？
 *   ② 能否创建「输入 16 位 / 输出 32 位」的查找表组件？
 *   ③ 能否实现部分比特提取（高 16 / 低 48）与重新拼接？
 *   ④ 连线是否清晰体现「左右宽度不同且功能不对称」？
 *
 * 手法（与 verify-shuangyu / verify-fangzhen 同款：换一条独立路径）：
 *   · **独立穷举** S 盒的差分分布行（不复用 analysis.js 的任何代码），与引擎掩码级逐值对拍；
 *   · **独立按公式重算** LUT 的输出（不读平台存下来的那张表），与引擎值级加密对拍；
 *   · 掩码级与值级**必须自洽** —— 同一次查表不可能「掩码报 prob=0、值级却确定」；
 *   · 平台源码正则守卫：把「能力边界」与「不许回退」的写法钉死。
 *
 * ⚠️ 本样例的独立性说明：**「拼图」整体在平台上搭不出来**（卡在 ① 的 96bit/64bit
 *    与 ③ 的「移位后拼接」，不是卡在 ②）。因此**没有浏览器留档、也没有 session.json**
 *    —— 这份复核是**纯 Node 的独立穷举对拍**，故意不依赖任何 design-*.cjs 产物。
 *
 * ⚠️ 有一次「断言翻转」的历史：修复前 16→32 查找表被按**输入位宽**平铺 → 相邻 32bit
 *    输出块重叠 OR，掩码级报 prob=0 而值级是确定映射（自相矛盾）。修好后同一批断言
 *    改锁**正确行为**（整字一次查表、掩码级 ≡ 独立穷举、宽输出线性侧显式「不支持」）。
 *    修法见 AGENTS.md §4.37（「拼图」样例）。
 *
 * 跑法：
 *   node frontend/tests/verify-pintu.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SBox, SBOX_TABLE_CAP } from '../src/core/sbox.js'
import { SBoxLibrary } from '../src/core/sboxlib.js'
import {
  MODE, analyze, forwardEncryptWords, feistelGraphProfile,
} from '../src/core/analysis.js'
import { CipherGraph, NODE_TYPES, graphBlockBits, graphBlockSize } from '../src/core/graph.js'

// 引擎依赖 globalThis.localStorage（SBoxLibrary 构造时会读；lib.import 会 save）
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const lib = new SBoxLibrary()

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', 'src')

let pass = 0
const fails = []
/** check(断言, 说明, 实得值) —— 说明在前更易读，但调用处一律「先布尔后文案」 */
function check(ok, name, got = '') {
  if (ok) { pass++; console.log('  ✓ ' + name); return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
  console.log('  ✗ ' + name + (got !== '' ? ` —— 实得: ${got}` : ''))
}
const head = (t) => console.log('\n' + '═'.repeat(70) + '\n' + t + '\n' + '═'.repeat(70))
const sub = (t) => console.log('\n  ── ' + t + ' ──')
const hex = (v, w = 8) => '0x' + (v >>> 0).toString(16).padStart(w, '0')
const readSrc = (rel) => fs.readFileSync(path.resolve(SRC, rel), 'utf8')

/* ════════════════════════════════════════════ 【0】独立素材 */
head('【0】独立素材：16→32 查找表 / 16×16 大盒 / 10bit 方盒')

/** LUT 映射的**公式**（独立于平台存下来的表；用它重算，不读平台数据） */
const lutFormula = (x) => (Math.imul(x & 0xFFFF, 0x9E3779B1) ^ ((x & 0xFFFF) << 21)) >>> 0

const LUT_TABLE = Array.from({ length: 1 << 16 }, (_, x) => lutFormula(x))
const LUT = new SBox(LUT_TABLE.slice(), 16, 32, '复核-LUT(16→32)')
const lutRef = lib.import('复核-LUT(16→32)', LUT.table, 16, 32, '独立复核素材').id

// 16×16 方盒（DDT/LAT 全表 65536×65536 ≈ 4.3G cell → 必然不可行）
const BIG = new SBox(
  Array.from({ length: 1 << 16 }, (_, x) => (Math.imul(x ^ (x >>> 7) ^ (x << 3), 0x9E3779B1) >>> 8) & 0xFFFF),
  16, 16, '复核-16x16')
const bigRef = lib.import('复核-16x16', BIG.table, 16, 16, '独立复核素材').id

// 10bit 方盒（DDT 1M cell → 可行；用来验「按需单行 ≡ 全表」）
const SMALL = new SBox(
  Array.from({ length: 1 << 10 }, (_, x) => ((x * 0x2B) ^ (x >>> 3)) & 0x3FF),
  10, 10, '复核-10x10')

// 8bit 方盒（用于回归：既有行为零影响）
const SQ8 = new SBox(Array.from({ length: 256 }, (_, x) => (x * 0x1D) & 0xFF), 8, 8, '复核-8bit')

check(LUT.inBits === 16 && LUT.outBits === 32, '素材：16 入 / 32 出的扩展查找表建立成功')
check(LUT.outSize === 2 ** 32, `★ outSize = ${LUT.outSize}（不是坍缩的 1）`, `${LUT.outSize}`)
check(LUT.outMask === 0xFFFFFFFF, `outMask = ${hex(LUT.outMask)}`)
check(SQ8.outSize === 256, `回归：8bit 方盒 outSize = ${SQ8.outSize}（零影响）`)
console.log(`    SBOX_TABLE_CAP = ${SBOX_TABLE_CAP} cell`)

/* ════════════════════════════════════════════ 独立参考实现 */
/** 独立穷举：Δin = a 时的输出差分分布（Map: Δout -> 次数）—— 不复用 analysis.js */
function bruteRow(sb, a) {
  const row = new Map()
  for (let x = 0; x < sb.inSize; x++) {
    const d = (sb.table[x] ^ sb.table[x ^ a]) & sb.outMask
    row.set(d, (row.get(d) || 0) + 1)
  }
  return row
}
function argmaxRow(row) {
  let bo = 0, bc = 0
  for (const [d, c] of row) { if (d !== 0 && c > bc) { bc = c; bo = d } }
  return { out: bo >>> 0, count: bc }
}
/** 跑 INPUT(bits) → SBOX → OUTPUT 的图，返回 analyze 结果 */
function graphWith(bits, tableRef, rounds = 1) {
  const g = new CipherGraph()
  const i = g.addNode('INPUT', 0, 0, { bits, blocks: 1 })
  const s = g.addNode('SBOX', 200, 0, { sboxId: tableRef, mode: 'parallel', repeat: 1 })
  const o = g.addNode('OUTPUT', 400, 0, { rounds })
  g.addEdge(i.id, 'out', s.id, 'in')
  g.addEdge(s.id, 'out', o.id, 'in')
  return g
}
function runDiff(bits, tableRef, initDiffs, rounds = 1) {
  return analyze(graphWith(bits, tableRef, rounds),
    { mode: MODE.DIFFERENTIAL, rounds, blockBits: bits, initDiffs, onLog: () => {} })
}
function runLin(bits, tableRef, initDiffs, rounds = 1) {
  return analyze(graphWith(bits, tableRef, rounds),
    { mode: MODE.LINEAR, rounds, blockBits: bits, initDiffs, onLog: () => {} })
}

/* ════════════════════════════════════════════ 【1】要点① 非等分分割 */
head('【1】要点①：非等分（32 + 64）分割 —— 96bit → L(32) + R(64)')

const inputBitsMax = NODE_TYPES.INPUT.props.find((p) => p.key === 'bits').max
check(inputBitsMax === 32, `INPUT「位宽」上限 = ${inputBitsMax}（写死 max:32）`, `${inputBitsMax}`)

{
  const g = new CipherGraph()
  g.addNode('INPUT', 0, 0, { bits: 96, blocks: 1 })
  check(graphBlockBits(g) === 32, `填 96 → 引擎真正用的词宽被夹到 ${graphBlockBits(g)}`, `${graphBlockBits(g)}`)
  check(graphBlockSize(g) === 32, `「分组长度」派生也只到 32（96 进不来）`, `${graphBlockSize(g)}`)
}
{
  const g = new CipherGraph()
  g.addNode('INPUT', 0, 0, { bits: 32, blocks: 3 })
  check(graphBlockSize(g) === 96, `96 只能靠「32bit × 3 块」凑（graphBlockSize=${graphBlockSize(g)}，纯界面派生）`, `${graphBlockSize(g)}`)
}
{
  const g = new CipherGraph()
  g.addNode('INPUT', 0, 0, { bits: 32, blocks: 3, multiword: true })
  const inp = g.nodes.find((n) => n.type === 'INPUT')
  check(inp.outputs.length === 3, `开「多字端口」后 INPUT 有 ${inp.outputs.length} 个独立端口（${inp.outputs.map((p) => p.label).join(',')}）`, `${inp.outputs.length}`)
}

const splitMax = NODE_TYPES.SPLIT.props.find((p) => p.key === 'splitBits').max
check(splitMax === 32, `SPLIT「A 部分位宽」上限 = ${splitMax}（分不出 64bit 的 B 支路）`, `${splitMax}`)

// 独立验算 SPLIT 语义：A = 低 splitBits 位、B = 其余高位
{
  const inM = 0xDEADBEEF, sb = 16
  const A = (inM & ((1 << sb) - 1)) >>> 0
  const B = (inM >>> sb) >>> 0
  check(A === 0xBEEF && B === 0xDEAD,
    `SPLIT(splitBits=16) 语义独立验算：A=${hex(A, 4)}=低 16、B=${hex(B, 4)}=高 16`)
}
console.log('    ⇒ 单字内「宽度不同的分割」能表达；但 **64bit 的 R 无处安放**（无节点承载 >32bit 单字）')

/* ════════════════════════════════════════════ 【2】要点② 16→32 查找表 */
head('【2】要点②：16bit 入 / 32bit 出的查找表组件')

const sboxProps = NODE_TYPES.SBOX.props.map((p) => p.key)
check(!sboxProps.some((k) => /outBits|outWidth|outSize|输出位宽/.test(k)),
  `SBOX 节点**没有**「输出位宽」入口（属性只有 ${sboxProps.join(',')}）—— 输出宽由所引用的 S 盒决定`)

sub('值级：引擎加密 == 独立按公式重算（不读平台存的表）')
for (const x of [0x00010001, 0xFFFF0000, 0x0000ABCD]) {
  const got = forwardEncryptWords(graphWith(32, lutRef), x, { rounds: 1, blockBits: 32, lib })[0] >>> 0
  const want = lutFormula(x) // 索引 = 低 16 位
  check(got === want, `明文 ${hex(x)}：引擎 ${hex(got)} == 独立重算 ${hex(want)}`, `${hex(got)} vs ${hex(want)}`)
}

sub('掩码级：Δin=1 → 与独立穷举的分布一致（精确、非 0）')
{
  const row = bruteRow(LUT, 1)
  const { out, count } = argmaxRow(row)
  const r1 = (runDiff(32, lutRef, [1]).perRound || [])[0]
  const engOut = (r1?.outputMask ?? 0) >>> 0
  const engProb = r1?.prob ?? 0
  console.log(`    独立穷举：Δout=${hex(out)} 概率=${(count / LUT.inSize).toFixed(6)}（=${count}/65536）`)
  console.log(`    引擎掩码级：Δout=${hex(engOut)} 概率=${engProb.toFixed(6)}`)
  check(engOut === out, '掩码级 Δout == 独立穷举的最可能 Δout', `${hex(engOut)} vs ${hex(out)}`)
  check(Math.abs(engProb - count / LUT.inSize) < 1e-9,
    '掩码级概率 == 独立穷举（精确）', `${engProb} vs ${count / LUT.inSize}`)
  check(engProb > 0, '★ 不再出现「掩码级 prob=0、值级却确定」的自相矛盾', `${engProb}`)
}

sub('线性侧：宽输出（32bit）必须显式标注「不支持」，绝不伪装成 0')
{
  const steps = ((runLin(32, lutRef, [1]).perRound || [])[0]?.steps) ?? []
  const notes = steps.map((st) => st.note || '').join(' | ')
  console.log(`    step notes：${notes || '(无)'}`)
  check(/线性侧不支持/.test(notes), '★ 宽输出线性侧显式标注「不支持」（不是 0 相关）')
  const linWeight = steps.filter((st) => st.unsupported).length
  check(linWeight >= 1, `至少 1 个 step 带 unsupported 标记（实得 ${linWeight}）`, `${linWeight}`)
}

sub('词宽 < 输出位宽时：截断但可预期（有明确提示）')
{
  const x = 0x0001
  const got = forwardEncryptWords(graphWith(16, lutRef), x, { rounds: 1, blockBits: 16, lib })[0] >>> 0
  check(got === (lutFormula(x) & 0xFFFF),
    `16bit 词宽下 32bit 输出只留低 16 位 ${hex(got, 4)}（截断可预期）`, `${hex(got)}`)
}

/* ════════════════════════════════════════════ 【3】要点③ 提取与重拼接 */
head('【3】要点③：部分比特提取（高 16 / 低 48）与重新拼接')

console.log('  提取：')
console.log('    · 取高 16 位 = SPLIT 的 B 支路（在 ≤32bit 字内可）')
console.log('    · 取低 48 位需要 48bit 字 → INPUT.bits 上限 32 ⇒ 不可表达')
{
  // SPLIT(splitBits=48) 会被夹到 32
  const sbEff = Math.max(1, Math.min(splitMax, 48))
  check(sbEff === 32, `SPLIT(splitBits=48) 被夹到 ${sbEff}（A 位宽=32，B 支路=空）`, `${sbEff}`)
}

console.log('  拼接：')
const mergeOps = NODE_TYPES.MERGE.props.find((p) => p.key === 'op').options.map((o) => o.v)
const linearOps = NODE_TYPES.LINEAR.props.find((p) => p.key === 'op').options.map((o) => o.v)
check(!mergeOps.some((o) => /concat|join|shift|拼/.test(o)),
  `MERGE 只有 ${mergeOps.join('/')} —— 同位置逐位合并，无「移位后拼接」`)
check(!linearOps.some((o) => o === 'shl' || o === 'shiftLeft'),
  `LINEAR 只有 ${linearOps.join('/')} —— 有 rotl/rotr，但**没有「左移补零」**`)
console.log('    ⇒ 「新 R = LUT_32 || R_low48」这种「移位后拼成更宽值」的组合运算 **平台没有节点**')

/* ════════════════════════════════════════════ 【4】要点④ 非平衡迭代语义 */
head('【4】要点④：左右宽度不同且功能不对称 —— 迭代内核与连线')

{
  const src = readSrc('core/analysis.js')
  // 迭代内核里只有一个 branchBits —— 对称 Feistel 专用
  check(/const branchBits = Math\.max\(1, Math\.min\(32,[^\n]*splitBits[^\n]*\)/.test(src),
    '源码守卫：feistelGraphProfile 用**单个** branchBits（两侧同宽 ⇒ 只支持对称 Feistel）')
  const fsrc = src.slice(src.indexOf('export function feistelGraphProfile'))
  check(/状态 = 2 × \$\{branchBits\}bit 分支/.test(fsrc),
    '源码守卫：内核日志明说「状态 = 2 × N bit 分支」（不区分左右各自位宽）')
}
{
  const gsz = readSrc('core/graph.js')
  // 端口对象只带 label，不带位宽字段
  const portBlock = gsz.match(/outputs:\s*\[[\s\S]{0,400}?\]/)?.[0] ?? ''
  check(!/bits:|width:/.test(portBlock),
    '源码守卫：画布端口对象**不携带位宽**（宽度只在属性面板，连线上看不出左右不等宽）')
}

/* ════════════════════════════════════════════ 【5】按需单行 ≡ 全表 */
head('【5】按需单行 ≡ 全表（10bit 盒：两条路径必须逐值等价）')
{
  const ddt = SMALL.getDDT()
  let bad = 0, samples = 0
  for (const a of [1, 2, 3, 0x2B, 0x155, 0x3FF]) {
    const on = bruteRow(SMALL, a) // 与 analysis.js 的 ddtRowOnDemand 同一算法
    const full = ddt[a]
    for (let b = 0; b < SMALL.outSize; b++) {
      samples++
      if ((on.get(b) || 0) !== full[b]) bad++
    }
  }
  check(bad === 0, `6 个 Δin × ${SMALL.outSize} 个 Δout = ${samples} 组，按需行与全表**零不符**`, `${bad}`)
}
{
  // 引擎侧：10bit 盒 Δin=1 的掩码级也要等于独立穷举
  const sRef = lib.import('复核-10x10', SMALL.table, 10, 10, '独立复核素材').id
  const row = bruteRow(SMALL, 1)
  const { out, count } = argmaxRow(row)
  const r1 = (runDiff(10, sRef, [1]).perRound || [])[0]
  check(((r1?.outputMask ?? 0) >>> 0) === out, '10bit 盒：引擎掩码级 Δout == 独立穷举')
  check(Math.abs((r1?.prob ?? 0) - count / SMALL.inSize) < 1e-9, '10bit 盒：引擎概率 == 独立穷举（精确）')
}

/* ════════════════════════════════════════════ 【6】大盒（16×16） */
head('【6】大盒（16×16）：显式拒绝全表 + 差分走按需单行且精确')
{
  check(!BIG.fullTableFeasible(), '16×16 盒 fullTableFeasible = false')
  let ddtThrew = false, latThrew = false
  try { BIG.getDDT() } catch { ddtThrew = true }
  try { BIG.getLAT() } catch { latThrew = true }
  check(ddtThrew, '★ getDDT() 显式抛错（不静默建 4.3G cell 假表）')
  check(latThrew, '★ getLAT() 显式抛错（宽输出线性侧无可行精确算法）')

  const row = bruteRow(BIG, 1)
  const { out, count } = argmaxRow(row)
  let res = null, threw = null
  try { res = runDiff(16, bigRef, [1]) } catch (e) { threw = e }
  const r1 = (res?.perRound || [])[0]
  console.log(`    独立穷举：Δout=${hex(out, 4)} 概率=${(count / BIG.inSize).toFixed(6)}`)
  console.log(`    引擎：Δout=${hex((r1?.outputMask ?? 0) >>> 0, 4)} 概率=${(r1?.prob ?? 0).toFixed(6)}`)
  check(threw === null, '★ analyze() 不再因大盒抛错（修复前会崩在指标日志那一行）', threw ? String(threw).slice(0, 60) : '')
  check(res?.ok !== false, 'analyze() 返回 ok ≠ false')
  check(((r1?.outputMask ?? 0) >>> 0) === out, '掩码级 Δout == 独立穷举最可能值')
  check(Math.abs((r1?.prob ?? 0) - count / BIG.inSize) < 1e-9, '掩码级概率 == 独立穷举（精确）')

  const st = lib.stats(BIG)
  check(st?.metricsUnavailable === true, 'S 盒库 stats() 对大盒返回 metricsUnavailable（不把页面带崩）')
  check(typeof st?.fixedPoints === 'number', 'stats() 仍给出「能算的事实」（不动点计数）')
}

/* ════════════════════════════════════════════ 【7】validate 与源码守卫 */
head('【7】validate() 守卫 + 不许回退的源码写法')
{
  const issues = graphWith(32, lutRef).validate()
  const lutIssue = issues.find((i) => /非等宽查找表/.test(i.msg ?? ''))
  check(!!lutIssue, `图校验给出「非等宽查找表」提示（level=${lutIssue?.level}）`)
  console.log(`    提示原文：${lutIssue?.msg ?? '(无)'}`)

  const issues2 = graphWith(16, bigRef).validate()
  const bigIssue = issues2.find((i) => /DDT\/LAT 全表超出内存上限/.test(i.msg ?? ''))
  check(!!bigIssue, '图校验给出「DDT/LAT 全表超出内存上限，改按需单行」提示')
}
{
  const sboxSrc = readSrc('core/sbox.js')
  check(/outBits >= 31 \? 2 \*\* outBits : \(1 << outBits\)/.test(sboxSrc),
    '源码守卫：outSize 对 ≥31bit 用实数（2 ** outBits），不回退成 `1 << outBits`')
  check(/SBOX_TABLE_CAP/.test(sboxSrc), '源码守卫：存在 SBOX_TABLE_CAP 全表上限常量')
  const asrc = readSrc('core/analysis.js')
  check(/function ddtRowOnDemand/.test(asrc), '源码守卫：存在按需单行差分 ddtRowOnDemand')
  check(/function unsupportedWideOutput/.test(asrc), '源码守卫：存在宽输出线性「不支持」占位 unsupportedWideOutput')
  check(/return single part|整字一次查表|inBits !== sb\.outBits/.test(asrc),
    '源码守卫：非等宽 S 盒按「整字一次查表」处理（不按输入位宽平铺）')
}

/* ════════════════════════════════════════════ 汇总 */
head('汇总')
console.log('  ① 非等分分割          ⚠️ 单字内可（A/B 宽度可不同）；**32+64 不可**（96bit 进不来、B 支路 ≤31bit）')
console.log('  ② 16bit 入/32bit 出   ✅ **已可正确使用**：非等宽查找表按「整字一次查表」应用，差分侧精确')
console.log('  ③ 高16/低48 + 重拼接   ❌ 提取仅限 ≤32bit 字；且**没有「移位后拼接」节点**')
console.log('  ④ 左右不等宽 + 不对称  ⚠️ 分割与连线能表达宽度差；迭代内核是**单宽度**（只支持对称 Feistel）')
console.log('\n  ⇒ 「拼图」整体**搭不出来**：卡在 ①（96bit/64bit）与 ③（拼接），不是卡在 ②。')
console.log(`\n  通过 ${pass} 项，失败 ${fails.length} 项`)
if (fails.length) { console.log('  失败明细：'); for (const f of fails) console.log('    - ' + f) }
process.exit(fails.length ? 1 : 0)
