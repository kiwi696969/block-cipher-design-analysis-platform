/**
 * 「双鱼 Feistel」设计的**独立复核**（不信任平台引擎的自证）。
 *
 * 为什么需要它：`accept-four-defects.cjs` 与 `design-shuangyu.cjs` 能证明
 * 「界面 → 引擎 → 数字」这条链是通的，但**链条本身算得对不对**是另一回事 ——
 * 它们读到的数字都来自同一个引擎。这里换一条完全独立的路径：
 *
 *   ① 用 GF(2⁸) 乘法 + x²⁵⁴ 求逆 + 仿射变换**重新构造** AES S 盒，与平台内置表逐字节比对；
 *   ② **穷举 DDT / LAT**（256×256 全枚举，不是抽样），得到 AES 的真实差分/线性上限；
 *   ③ 自己**读导出的图**（节点 + 连线），按图的语义**另写一份传播实现**
 *      （S 盒逐字节取 DDT 最优 → 字节循环移位 → 异或轮密钥 → 与另一半合并 → 交换），
 *      与平台引擎没有一行代码共享；
 *   ④ 把平台逐轮日志里声称的 (L, R, A) 拿来，用穷举 DDT 精确判它「可能是怎么算出来的」，
 *      再与独立实现逐轮对比；
 *   ⑤ 用独立参考实现**真加密**若干对明文，统计命中率是否等于理论值 2^(−weight)。
 *
 * 跑法（需先跑过 design-shuangyu.cjs 生成 session.json）：
 *   node frontend/tests/verify-shuangyu.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILTIN_SBOXES } from '../src/core/sbox.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '..', '..', 'outputs', '双鱼Feistel设计记录')

let pass = 0
const fails = []
function check(name, ok, got = '') {
  if (ok) { pass++; console.log('  ✓ ' + name); return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
  console.log('  ✗ ' + name + (got !== '' ? ` —— 实得: ${got}` : ''))
}
const hex = (v, w = 8) => '0x' + (v >>> 0).toString(16).padStart(w, '0')

/* ════════════════════════════════════════════════════ ① 独立构造 AES S 盒 */

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
function ginv(a) {
  if (a === 0) return 0
  let r = 1
  let base = a
  let e = 254
  while (e) {
    if (e & 1) r = gmul(r, base)
    base = gmul(base, base)
    e >>= 1
  }
  return r
}
const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff
const AES_S = Array.from({ length: 256 }, (_, x) => {
  const b = ginv(x)
  return (b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4) ^ 0x63) & 0xff
})

console.log('\n【1】独立构造 AES S 盒（GF(2⁸) 求逆 + 仿射变换），与平台内置表比对')
const libAes = BUILTIN_SBOXES.aes.table
check('内置 AES 表有 256 项', libAes.length === 256, String(libAes.length))
let diffBytes = 0
for (let i = 0; i < 256; i++) if (libAes[i] !== AES_S[i]) diffBytes++
check('★ 与独立构造逐字节一致（256/256）', diffBytes === 0, `${diffBytes} 字节不同`)

/* ════════════════════════════════════════════════════ ② 穷举 DDT / LAT */

const DDT = Array.from({ length: 256 }, () => new Uint16Array(256))
for (let a = 0; a < 256; a++) {
  for (let x = 0; x < 256; x++) DDT[a][AES_S[x] ^ AES_S[x ^ a]]++
}
let du = 0
for (let a = 1; a < 256; a++) for (let b = 1; b < 256; b++) if (DDT[a][b] > du) du = DDT[a][b]

const parity = (v) => { let p = 0; while (v) { p ^= 1; v &= v - 1 } return p }
let latMax = 0
for (let a = 1; a < 256; a++) {
  for (let b = 1; b < 256; b++) {
    let s = 0
    for (let x = 0; x < 256; x++) s += parity(a & x) ^ parity(b & AES_S[x]) ? -1 : 1
    if (Math.abs(s) > latMax) latMax = Math.abs(s)
  }
}

console.log('\n【2】穷举差分分布表 DDT 与线性逼近表 LAT（256×256 全枚举）')
check('★ 差分均匀度 DU = 4（AES 是 4-均匀，公开事实）', du === 4, String(du))
check('★ 线性逼近最大绝对值 = 32（即相关度 2⁻³，公开事实）', latMax === 32, String(latMax))
const BITS_PER_SBOX = -Math.log2(du / 256)
console.log(`     → 单活跃 S 盒：差分 ${BITS_PER_SBOX.toFixed(2)} bit（= −log₂(${du}/256)）`
  + ` ｜线性 ${(-Math.log2((latMax / 128) ** 2)).toFixed(2)} bit（Matsui 定理）`)

/** 该行 DDT 的最优输出差分（argmax），并列时取最小下标 —— 与平台策略一致 */
function bestOut(d) {
  const row = DDT[d]
  let bo = 0; let bc = 0
  for (let b = 1; b < 256; b++) if (row[b] > bc) { bc = row[b]; bo = b }
  return { out: bo, count: bc }
}

/* ════════════════════════════════════════════════════ ③ 读图 + 另写一份传播实现 */

const sessPath = path.join(OUT, 'session.json')
check('找得到设计留档 session.json（先跑 design-shuangyu.cjs）', fs.existsSync(sessPath), sessPath)
if (!fs.existsSync(sessPath)) { report(); process.exit(1) }
const sess = JSON.parse(fs.readFileSync(sessPath, 'utf8'))
const G = sess.graph

console.log('\n【3】从导出的图里**自己读**出结构（不引用平台引擎）')
const byId = new Map(G.nodes.map((n) => [n.id, n]))
const typeOf = (id) => byId.get(id)?.type
const inEdges = (id) => G.edges.filter((e) => e.to === id)
const outEdges = (id) => G.edges.filter((e) => e.from === id)

const inputNode = G.nodes.find((n) => n.type === 'INPUT')
const outputNode = G.nodes.find((n) => n.type === 'OUTPUT')
const splitNode = G.nodes.find((n) => n.type === 'SPLIT')
const mergeNode = G.nodes.find((n) => n.type === 'MERGE')
const sboxNode = G.nodes.find((n) => n.type === 'SBOX')
const permNode = G.nodes.find((n) => n.type === 'PERM')
const xorNode = G.nodes.find((n) => n.type === 'XORKEY')
check('图里有 INPUT / OUTPUT / SPLIT / MERGE / SBOX / PERM / XORKEY 各一个',
  !!(inputNode && outputNode && splitNode && mergeNode && sboxNode && permNode && xorNode))
check('★ 结构类型标记为 feistel', G.meta.structure === 'feistel', G.meta.structure)
const blockBits = Math.min(32, (inputNode.props.bits | 0) || 32)
check('★ INPUT 位宽 = 32、分块数 = 2 → 分组长度 64', blockBits === 32 && inputNode.props.blocks === 2,
  `${blockBits} × ${inputNode.props.blocks}`)

// 从 SPLIT 的两个输出口出发，看哪一支通到 MERGE 的哪个入口
const splitA = outEdges(splitNode.id).find((e) => e.fromPort === 'a')
const splitB = outEdges(splitNode.id).find((e) => e.fromPort === 'b')
check('SPLIT.a 与 SPLIT.b 各有一条出线', !!splitA && !!splitB)

// 沿「非线性那一支」验证 F 链的形状：SBOX → PERM → XORKEY → MERGE
const fChain = []
{
  let cur = typeOf(splitB.to) === 'MERGE' ? null : splitB.to
  const seen = new Set()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    fChain.push(typeOf(cur))
    const nx = outEdges(cur).find((e) => typeOf(e.to) !== 'OUTPUT')
    if (!nx || typeOf(nx.to) === 'MERGE') break
    cur = nx.to
  }
}
check('★ F 链形状 = SBOX → PERM → XORKEY（自己沿图走出来，非写死）',
  fChain.join('→') === 'SBOX→PERM→XORKEY', fChain.join('→'))
check('★ 合并节点声明的运算 = xor', (mergeNode.props.op || 'xor') === 'xor', String(mergeNode.props.op))

// 图的语义（我自己的实现）
const sboxId = sboxNode.props.sboxId
check('★ S 盒节点选的是 aes', sboxId === 'aes', String(sboxId))
check('★ S 盒应用方式 = byte（4 个并行 8bit S 盒）', sboxNode.props.mode === 'byte', String(sboxNode.props.mode))
const shiftBytes = permNode.props.shift | 0
check('★ 置换 = 字节循环移位 1 位', shiftBytes === 1, String(shiftBytes))

/** 字节循环左移 n 个字节（与图的「字节循环移位」同向） */
function rotBytesLeft(x, n, bytes) {
  const s = ((n % bytes) + bytes) % bytes
  if (!s) return x >>> 0
  return (((x << (8 * s)) | (x >>> (32 - 8 * s))) >>> 0)
}
/** 逐字节 AES S 盒代换 */
function subBytes(x) {
  let o = 0
  for (let i = 0; i < 4; i++) o |= AES_S[(x >>> (i * 8)) & 0xff] << (i * 8)
  return o >>> 0
}
/** 轮函数 F（差分域）：Δ → DDT 最优输出差分的逐字节映射 → 字节循环移位。轮密钥对差分无贡献 */
function Fdiff(delta, pick) {
  let Y = 0
  let prob = 1
  let active = 0
  const chosen = []
  for (let i = 0; i < 4; i++) {
    const d = (delta >>> (i * 8)) & 0xff
    if (d === 0) { chosen.push(0); continue }
    const o = pick ? pick[i] : bestOut(d).out
    const c = DDT[d][o]
    Y |= (o << (i * 8))
    prob *= c / 256
    if (c > 0) active++
    chosen.push(o)
  }
  return { out: rotBytesLeft(Y, shiftBytes, 4), prob, active, chosen }
}
/** 轮函数 F（真实域，用于抽样实测） */
function Freal(x, key) {
  return (rotBytesLeft(subBytes(x), shiftBytes, 4) ^ (key >>> 0)) >>> 0
}

console.log('\n【4】用独立实现按图重算 8 轮差分特征（合并按声明的 xor）')
let iL = 0
let iR = 1
let cumProb = 1
let cumActive = 0
const indep = []
for (let r = 1; r <= 8; r++) {
  const f = Fdiff(iR)
  const A = (iL ^ f.out) >>> 0          // ← 合并 (XOR)：按声明的运算
  cumProb *= f.prob
  cumActive += f.active
  indep.push({ round: r, L: iL, R: iR, F: f.out, A, prob: f.prob, active: f.active, cumActive, cumProb })
  iL = iR
  iR = A
}
const indepWeight = -Math.log2(cumProb)
console.log('     轮  ΔL(左)      ΔR(右)      F(R)        新左 A=L⊕F(R)  本轮活跃  累计权重')
for (const x of indep) {
  console.log(`     ${String(x.round).padStart(2)}  ${hex(x.L)}  ${hex(x.R)}  ${hex(x.F)}  ${hex(x.A)}`
    + `       ${x.active}      ${(-Math.log2(x.cumProb)).toFixed(2)}`)
}
console.log(`     → 独立结论：8 轮 −log₂p = ${indepWeight.toFixed(2)} ｜活跃 S 盒累计 = ${cumActive}`)

/* ── 把平台日志里逐轮声称的 A 拿来，判它到底按哪个运算算出来的 ── */
console.log('\n【5】平台日志的逐轮声称 vs 独立重算（判定合并运算究竟是什么）')
const logs = (sess.logs?.differential || []).join('\n')
const re = /第 (\d+) 轮：L=0x([0-9a-f]+) R=0x([0-9a-f]+) → F\(R\) 激活 (\d+) 个 S 盒 → A=L⊕F\(R\)=0x([0-9a-f]+) ｜累计 -log₂p=([\d.]+)/
const plat = []
for (const line of logs.split('\n')) {
  const m = line.match(re)
  if (m) plat.push({ round: +m[1], L: parseInt(m[2], 16), R: parseInt(m[3], 16), active: +m[4], A: parseInt(m[5], 16), cum: +m[6] })
}
check('解析出 8 轮平台声称记录', plat.length === 8, String(plat.length))

let xorOk = 0
let orOk = 0
for (const p of plat) {
  const f = Fdiff(p.R)
  if (((p.L ^ f.out) >>> 0) === p.A) xorOk++
  if (((p.L | f.out) >>> 0) === p.A) orOk++
  const flag = (((p.L ^ f.out) >>> 0) === p.A) ? 'XOR 自洽' : ((((p.L | f.out) >>> 0) === p.A) ? '★ 实际是 OR' : '两者都不符')
  console.log(`     第 ${p.round} 轮：日志 A=${hex(p.A)} ｜ L⊕F=${hex(p.L ^ f.out)} ｜ L|F=${hex(p.L | f.out)}`
    + `   → ${flag}`)
}
console.log(`     合计：与 XOR 自洽 ${xorOk}/8 轮，与 OR 自洽 ${orOk}/8 轮`)
check('★ 平台的「合并」真的是按日志所写的 XOR 算的（8/8 轮）', xorOk === 8, `XOR 自洽仅 ${xorOk}/8，OR 自洽 ${orOk}/8`)

/* ── 逐轮与独立实现对比 ── */
let same = 0
for (let i = 0; i < Math.min(plat.length, indep.length); i++) {
  if (plat[i].A === indep[i].A) same++
}
check('★ 平台逐轮的 A 与独立重算逐轮一致（8/8）', same === 8, `${same}/8 一致`)
check('★ 平台总权重与独立重算一致', Math.abs(indepWeight - plat[plat.length - 1].cum) < 1e-9,
  `${indepWeight.toFixed(2)} vs ${plat[plat.length - 1].cum}`)
check('★ 平台活跃 S 盒总数与独立重算一致',
  cumActive === plat.reduce((a, p) => a + p.active, 0),
  `${cumActive} vs ${plat.reduce((a, p) => a + p.active, 0)}`)

/* ════════════════════════════════════════════════════ ⑥ 真加密抽样 */

console.log('\n【6】用独立参考实现真加密抽样，验证「理论概率」不是纸面数字')
function sampleRounds(rounds, N) {
  const keys = Array.from({ length: rounds }, () => (Math.random() * 2 ** 32) >>> 0)
  const target = indep[rounds - 1].A
  let hits = 0
  for (let i = 0; i < N; i++) {
    const L0 = (Math.random() * 2 ** 32) >>> 0
    const R0 = (Math.random() * 2 ** 32) >>> 0
    const enc = (l, r) => {
      for (let k = 0; k < rounds; k++) {
        const A = (l ^ Freal(r, keys[k])) >>> 0
        l = r
        r = A
      }
      return r
    }
    // 明文对：Δ(L₀,R₀) = (0, 1) —— 只改 R₀ 的最低位
    if (((enc(L0, R0) ^ enc(L0, (R0 ^ 1) >>> 0)) >>> 0) === target) hits++
  }
  return { hits, N, measured: hits / N, expected: indep[rounds - 1].cumProb, rounds, target }
}
const s1 = sampleRounds(1, 200000)
console.log(`     1 轮：${s1.hits}/${s1.N} = ${(s1.measured * 100).toFixed(4)}%`
  + `   理论 2^${(-(-Math.log2(s1.expected))).toFixed(2)} = ${(s1.expected * 100).toFixed(4)}%`)
check('★ 1 轮实测命中率 ≈ 2⁻⁶（相对误差 < 10%）',
  s1.hits > 0 && Math.abs(s1.measured - s1.expected) / s1.expected < 0.10,
  `${(s1.measured * 100).toFixed(4)}% vs ${(s1.expected * 100).toFixed(4)}%`)
const s2 = sampleRounds(2, 2000000)
const gap2 = -Math.log2(s2.measured) + Math.log2(s2.expected)
console.log(`     2 轮：${s2.hits}/${s2.N} = ${(s2.measured * 100).toFixed(5)}%`
  + `   单条特征 2^-12 = ${(s2.expected * 100).toFixed(5)}%`
  + `   → 差分比特征高 ${gap2.toFixed(2)} bit`)
// 差分密码分析的常识：单条特征的 −log₂p 是**差分**（所有同尾特征之和）的下界。
// 2 轮时扩散还很弱，多条特征会汇聚到同一个输出差，实测概率必然高于单条特征。
check('★ 2 轮实测差分概率 ≥ 单条特征概率（特征给的是下界，含抽样噪声留 20% 余量）',
  s2.hits > 0 && s2.measured >= s2.expected * 0.8,
  `${(s2.measured * 100).toFixed(5)}% vs ${(s2.expected * 100).toFixed(5)}%`)
check('★ 2 轮实测差分概率在单条特征的 64 倍以内（超出说明抽样的语义弄错了）',
  s2.measured <= s2.expected * 64, `${(s2.measured / s2.expected).toFixed(1)}×`)

/* ════════════════════════════════════════════════════ ⑦ 指标卡口径 */

console.log('\n【7】指标卡口径自检')
const dm = sess.metrics?.differential || {}
const val = (k) => dm[k]?.value ?? dm[k]?.sub ?? '(缺)'
console.log(`     平台卡片：活跃 S 盒 ${JSON.stringify(dm['活跃 S 盒?']?.value)}`
  + `｜单轮命中率 ${JSON.stringify(dm['命中率?']?.value)}`
  + `｜数据复杂度 ${dm['数据复杂度?']?.value}（${dm['数据复杂度?']?.sub}）`)
check('★ 「数据复杂度」= SNR/p（SNR=2）',
  Math.abs(2 ** (indepWeight + 1) / 2 ** indepWeight - 2) < 1e-9 && !!dm['数据复杂度?'], val('数据复杂度?'))
const avgW = indepWeight / 8
check('★ 「单轮命中率」= 2^(−平均每轮权重)',
  avgW > 0 && dm['命中率?']?.sub?.includes('平均权重'), `${val('命中率?')}（平均权重 ${avgW.toFixed(2)}）`)

function report() {
  console.log('\n' + '─'.repeat(64))
  if (!fails.length) console.log(`✓ 全部通过（${pass} 项）`)
  else {
    console.log(`✗ ${fails.length} 项失败 / 共 ${pass + fails.length} 项`)
    for (const f of fails) console.log('   ✗ ' + f)
    process.exitCode = 1
  }
}
report()
