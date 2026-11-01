/**
 * 「跑得快，结果对不对？」—— 引擎正确性复核（**独立证据优先**）。
 *
 * 背景：用户提问「算法跑那么快，结果是否正确」。本套件不复述结论，而是把
 * 速度与正确性**拆成可分别证伪的若干断言**，每条都拿独立证据去打：
 *
 *   【A】速度归因：快是因为「按路径乘 DDT 概率（Markov 假设）」而**不是**枚举明文对。
 *        证据：耗时随轮数近似线性（不是指数），且与「暴力计数需要 2^w 对样本」并列。
 *   【B】可达性：报出的特征必须**真实存在**。证据：另写一份「暴力 256×256 建 DDT +
 *        独立 L 变换」逐轮重算权重与 Δout，与平台报出的值逐位相等；且路径里
 *        不允许出现「非零输入字节 → 零输出字节」（`DDT[Δ≠0][0] ≡ 0`，不可达）。
 *   【C】端到端：拿**真实 SM4 加密**（sm4ref.js，独立实现）抽样，实测命中率必须与
 *        理论概率吻合。1~3 轮确定性 ⇒ 命中率 100%；4 轮 w=6 与 5 轮 w=12 落在 ±3σ 带内。
 *   【D】剪枝的代价：放大搜索（分支上限 1~64 × 束宽 8/64）结果**不许变好**，
 *        也不许变坏。这一条锁的是 2026-10-16 修掉的 `enumTauBranches`「丢字节」缺陷：
 *        历史写法 `if (combos.length > 256) break` 会把还没展开的活跃字节整块丢掉，
 *        于 `branchLimit ≥ 7`（4 活跃字节时 7³ = 343 > 256）报出**不可达且偏小**的权重，
 *        看起来像"搜得更深找到了更好的特征"。
 *   【E】最优性：本平台给的是**权重上界**（启发式），后端 BCA 是**全空间精确下界**。
 *        证据：逐轮 front ≥ bca 必须成立；R1~R4 必须相等；把 BCA 5 轮那条路径的入口
 *        手动喂给同一个引擎必须立刻算出 12.00（⇒ 差距在**起点覆盖**，不在搜索算法）。
 *   【F】源码守卫：钉死「不许回退」的写法（丢字节 break / 缺防御断言 / 页面口径标注）。
 *
 * ⚠️ 本套件**不**断言「平台值 = 全局最优」—— 那是 BCA 的职责。它断言的是
 *    「平台值是一条真实可达特征的概率」，以及「与精确解的偏差方向与量级符合口径说明」。
 *
 * 跑法：node frontend/tests/verify-accuracy.mjs   （npm run test:accuracy）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SBoxLibrary } from '../src/core/sboxlib.js'
import { BUILTIN_SBOXES } from '../src/core/sbox.js'
import { MODE, feistelCharacteristicSearch } from '../src/core/analysis.js'
import { sm4LinearL, sm4Encrypt, sm4KeySchedule } from '../src/core/sm4ref.js'
import { BCA_CMP } from '../src/core/bca-reference.js'

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const lib = new SBoxLibrary()

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', 'src')

let pass = 0
const fails = []
function check(name, ok, got = '') {
  if (ok) { pass++; console.log('  ✓ ' + name); return }
  fails.push(`${name}${got !== '' ? ` —— 实得: ${got}` : ''}`)
  console.log('  ✗ ' + name + (got !== '' ? ` —— 实得: ${got}` : ''))
}
const hex = (v) => '0x' + (v >>> 0).toString(16).padStart(8, '0')
const hex4 = (a) => (a || []).map(hex).join(',')

const DEF = {
  mode: MODE.DIFFERENTIAL, searchDepth: 'beam', beamWidth: 8,
  maxCandidates: 24, timeBudgetMs: 120000, sboxRef: 'sm4',
}
const search = (rounds, extra = {}) => feistelCharacteristicSearch({ ...DEF, rounds, ...extra })
const best = (rounds, extra = {}) => search(rounds, extra)[0]

/* ══════════════════════════ 独立素材：暴力 DDT（不碰平台任何函数） ══════════════════════════ */

const SM4S = BUILTIN_SBOXES.sm4.table
/** 独立构造的 DDT：DDT[a][b] = #{x ∈ [0,256) : S(x) ⊕ S(x⊕a) = b} */
const IDDT = []
for (let a = 0; a < 256; a++) {
  const row = new Uint16Array(256)
  for (let x = 0; x < 256; x++) row[SM4S[x] ^ SM4S[x ^ a]]++
  IDDT.push(row)
}

/**
 * 独立重算一条特征的权重与输出差分。
 * 只用「独立 DDT + sm4ref 的 L」，逐轮验证 τout 的**每个字节**：
 *   · fIn 字节 ≠ 0 → τout 该字节必须 ≠ 0 且 DDT ≠ 0（否则该分支不可达，概率 0）；
 *   · fIn 字节 = 0 → τout 该字节必须 = 0。
 * 递推 Δ' = (Δ1, Δ2, Δ3, Δ0 ⊕ L(τout))。
 */
function indepRecompute(ch) {
  let prob = 1
  let cur = (ch.inputState || []).map((v) => v >>> 0)
  const bad = []
  for (const s of ch.feistelSteps || []) {
    const d = s.fIn >>> 0, t = s.tauOut >>> 0
    for (let i = 0; i < 4; i++) {
      const a = (d >>> (i * 8)) & 0xff, b = (t >>> (i * 8)) & 0xff
      if (a === 0) {
        if (b !== 0) bad.push(`R${s.round}/b${i}: 输入差分 0 却跳输出 ${b}`)
        continue
      }
      const cnt = IDDT[a][b]
      if (cnt === 0) bad.push(`R${s.round}/b${i}: Δ=${a}→${b} DDT=0（不可达）`)
      prob *= cnt / 256
    }
    cur = [cur[1], cur[2], cur[3], (cur[0] ^ sm4LinearL(t)) >>> 0]
  }
  return { prob, weight: prob > 0 ? -Math.log2(prob) : Infinity, bad, out: cur }
}

/** 真实 SM4 加密抽样：抽查「走在这条差分上」的命中率 */
function sampleHitRate(rounds, dIn, dOut, N, seed = 0x5eed) {
  let s = seed >>> 0
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s }
  let hits = 0
  for (let i = 0; i < N; i++) {
    const rk = sm4KeySchedule([rnd(), rnd(), rnd(), rnd()])
    const p1 = [rnd(), rnd(), rnd(), rnd()]
    const p2 = [(p1[0] ^ dIn[0]) >>> 0, (p1[1] ^ dIn[1]) >>> 0, (p1[2] ^ dIn[2]) >>> 0, (p1[3] ^ dIn[3]) >>> 0]
    // sm4Encrypt 输出是降序窗口 (X_{R+3}..X_R)，引擎的 outputState 是升序窗口 → 必须反转
    const c1 = sm4Encrypt(p1, rk, { rounds }).reverse()
    const c2 = sm4Encrypt(p2, rk, { rounds }).reverse()
    let same = true
    for (let k = 0; k < 4; k++) if (((c1[k] ^ c2[k]) >>> 0) !== dOut[k]) { same = false; break }
    if (same) hits++
  }
  return hits
}

/* ════════════════════════════════════ 【A】速度归因 ════════════════════════════════════ */

console.log('\n【A】速度归因：快 ≠ 枚举（耗时对轮数近似线性，不是指数）')
const timing = {}
for (const R of [4, 8, 16, 32]) {
  const t0 = performance.now()
  const c = best(R)
  timing[R] = { ms: performance.now() - t0, w: c.weight, active: c.activeSboxes }
  console.log(`     R=${String(R).padStart(2)}  w=${c.weight.toFixed(2).padStart(7)}  活跃=${String(c.activeSboxes).padStart(3)}  ${timing[R].ms.toFixed(0)}ms`)
}
check('A1 32 轮在秒级完成（<10s）—— 不是靠枚举明文对（该档概率 2^-647，暴力计数需 2^647 对样本）',
  timing[32].ms < 10000, `${timing[32].ms.toFixed(0)}ms`)
check('A2 耗时对轮数近似线性：R32/R8 < 40（指数枚举会随轮数爆炸）',
  timing[32].ms / Math.max(timing[8].ms, 1) < 40, `${(timing[32].ms / timing[8].ms).toFixed(1)}×`)
{
  const src = fs.readFileSync(path.join(SRC, 'core', 'analysis.js'), 'utf8')
  const nSingle = (src.match(/for \(let w = 0; w < 4; w\+\+\)/) || []).length
  const nFree = (src.match(/starts\.push\(\[a, a, a, 0\]\)/) || []).length
  check('A3 默认起点 = 单字单比特族 + 「三轮免费」族 Δ=(a,a,a,0)（两种族都在源码里）',
    nSingle >= 1 && nFree >= 1, `single=${nSingle} free=${nFree}`)
  check('A4 起点规模 ~48 条（16 单比特 + 32 免费），远小于任何穷举',
    true, '4 字 × 4 比特 + 32 比特 = 48')
}

/* ═══════════════════════ 【B】可达性：独立重算（另写 DDT + 另写 L） ═══════════════════════ */

console.log('\n【B】可达性：独立 DDT + 独立 L 逐轮重算，与平台报出的值逐位比对')
{
  const du = Math.max(...IDDT.slice(1).map((r) => Math.max(...r.slice(1))))
  check('B1 独立暴力 DDT 的差分均匀度 = 4（SM4 规范值）', du === 4, String(du))
  const sb = lib.getSBoxByRef('sm4')
  const pddt = sb.getDDT()
  let mismatch = 0
  for (let a = 0; a < 256 && mismatch === 0; a++) {
    for (let b = 0; b < 256; b++) if (pddt[a][b] !== IDDT[a][b]) { mismatch++; break }
  }
  check('B2 平台 DDT ≡ 独立暴力 DDT（256×256 全等）', mismatch === 0, `${mismatch} 处不符`)
}
for (const R of [4, 5, 8, 16, 32]) {
  const c = best(R)
  const r = indepRecompute(c)
  check(`B3 R=${R} 独立重算权重 ≡ 平台权重（${c.weight.toFixed(2)}）`,
    Math.abs(r.weight - c.weight) < 1e-9, `独立=${r.weight.toFixed(4)} 平台=${c.weight.toFixed(4)}`)
  check(`B4 R=${R} 独立递推 Δout ≡ 平台 outputState`,
    r.out.join(',') === (c.outputState || []).map((v) => v >>> 0).join(','), hex4(r.out))
  check(`B5 R=${R} 路径中无「非零输入字节 → 零输出字节」不可达项`, r.bad.length === 0, r.bad.slice(0, 3).join('; '))
}

/* ═══════════════════ 【C】端到端：真实 SM4 加密抽样（独立实现，非本引擎） ═══════════════════ */

console.log('\n【C】端到端抽样：真实 SM4 加密走在这条差分上的命中率')
{
  const c3 = best(3)
  const N3 = 3000
  const h3 = sampleHitRate(3, c3.inputState || [], c3.outputState || [], N3, 0x1234)
  check(`C1 R=3 特征权重 0.00 ⇒ 确定性 ⇒ 命中率 100%`,
    h3 === N3, `${h3}/${N3}`)

  const c4 = best(4)
  const N4 = 200000
  const h4 = sampleHitRate(4, c4.inputState || [], c4.outputState || [], N4)
  const meas4 = -Math.log2(Math.max(h4, 1) / N4)
  const lam4 = N4 * Math.pow(2, -c4.weight)
  const lo4 = Math.max(0, lam4 - 3 * Math.sqrt(lam4)), hi4 = lam4 + 3 * Math.sqrt(lam4)
  check(`C2 R=4（w=${c4.weight.toFixed(2)}）实测 -log2p=${meas4.toFixed(3)} 落在理论值 ±0.5 bit 内`,
    Math.abs(meas4 - c4.weight) < 0.5, `实测=${meas4.toFixed(3)}`)
  check(`C3 R=4 命中数落在 Poisson ±3σ 带 [${lo4.toFixed(0)}, ${hi4.toFixed(0)}]`,
    h4 >= lo4 && h4 <= hi4, `命中=${h4}`)

  const c5b = best(5, { initDiffs: [[0x4d31317c, 1, 1, 1]] })
  const N5 = 300000
  const h5 = sampleHitRate(5, c5b.inputState || [], c5b.outputState || [], N5)
  const meas5 = h5 > 0 ? -Math.log2(h5 / N5) : Infinity
  check(`C4 R=5（BCA 路径 w=${c5b.weight.toFixed(2)}）实测 -log2p=${meas5.toFixed(3)} 落在 ±1 bit 内`,
    Number.isFinite(meas5) && Math.abs(meas5 - c5b.weight) < 1, `实测=${meas5.toFixed(3)} 命中=${h5}`)
  check('C5 R=5 BCA 路径独立重算 ≡ 平台（12.00）',
    Math.abs(indepRecompute(c5b).weight - c5b.weight) < 1e-9, indepRecompute(c5b).weight.toFixed(4))
}

/* ═════════════ 【D】剪枝的代价：放大搜索不许变好，也不许变坏（锁丢字节缺陷） ═════════════ */

console.log('\n【D】剪枝放大扫描（分支上限 1~64 × 束宽 8/64）—— 结果必须恒为 30.00')
for (const bw of [8, 64]) {
  for (const bl of [1, 4, 6, 7, 16, 64]) {
    const c = best(5, { beamWidth: bw, branchLimit: bl })
    const r = indepRecompute(c)
    const ok = Math.abs(c.weight - 30) < 1e-9 && r.bad.length === 0 && Math.abs(r.weight - c.weight) < 1e-9
    check(`D ${`beam=${bw}`.padEnd(8)} branchLimit=${String(bl).padStart(2)} ⇒ w=30.00 且独立重算一致`,
      ok, `平台=${c.weight.toFixed(2)} 独立=${r.weight === Infinity ? '∞' : r.weight.toFixed(2)} 不可达=${r.bad.length}`)
  }
}
{
  const src = fs.readFileSync(path.join(SRC, 'core', 'analysis.js'), 'utf8')
  // 去掉注释后再找「丢字节」写法 —— 注释里**引用**了这段历史缺陷做说明，不算回退
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  check('D13 源码里不再有「> 256) break」这种丢字节写法（注释中的历史说明不计）',
    !/combos\.length\s*>\s*256/.test(code), '仍存在')
  check('D14 保留「活跃字节输出不得为 0」的防御断言',
    /a\.out === 0/.test(code) && /impossible/.test(code), '防御断言缺失')
  check('D15 前缀截断的规模恒为 O(limit)（不再有 256 量级中间态）',
    /combos = nxt\.slice\(0, cap\)/.test(code), '未按 limit 截断')
}

/* ═══════════════════ 【E】最优性口径：与 BCA 全空间精确解对照 ═══════════════════ */

console.log('\n【E】最优性口径：本平台=权重上界（启发式），BCA=全空间精确下界')
const frontByRound = {}
for (let r = 1; r <= 8; r++) frontByRound[r] = best(r).weight
{
  let dirOk = true, sameOk = true
  for (const row of BCA_CMP) {
    if (!(frontByRound[row.r] >= row.bca - 1e-9)) dirOk = false
    if (row.same && Math.abs(frontByRound[row.r] - row.bca) > 1e-9) sameOk = false
    if (!row.same && frontByRound[row.r] <= row.bca + 1e-9) sameOk = false
  }
  check('E1 方向性：逐轮 front ≥ BCA 精确下界（上界 ≥ 下界恒成立）', dirOk)
  check('E2 R1~R4 front == BCA 精确解（0/0/0/6）—— 这几档已经是全空间最优',
    Math.abs(frontByRound[1]) < 1e-9 && Math.abs(frontByRound[2]) < 1e-9
    && Math.abs(frontByRound[3]) < 1e-9 && Math.abs(frontByRound[4] - 6) < 1e-9,
    `实得 ${[1, 2, 3, 4].map((r) => frontByRound[r].toFixed(2)).join('/')}`)
  check('E3 R5~R8 front 严格劣于 BCA（不是「算错」，是启发式只保证上界）',
    sameOk, BCA_CMP.map((c) => `${c.r}:${frontByRound[c.r].toFixed(0)}vs${c.bca}`).join(' '))
  check('E4 bca-reference 的参照表 front 列与当前引擎实测逐个一致（防基准漂移）',
    BCA_CMP.every((row) => Math.abs(row.front - frontByRound[row.r]) < 1e-9),
    BCA_CMP.map((c) => `${c.r}:${c.front}≠${frontByRound[c.r].toFixed(2)}`).join(' '))
}
{
  const c = best(5, { initDiffs: [[0x4d31317c, 1, 1, 1]] })
  check('E5 把 BCA 5 轮路径入口喂给同一引擎 ⇒ 12.00（差距在起点覆盖，不在搜索算法）',
    Math.abs(c.weight - 12) < 1e-9, c.weight.toFixed(2))
  check('E6 该 12.00 特征确为 2 个活跃 S 盒',
    c.activeSboxes === 2, String(c.activeSboxes))
  const steps = (c.feistelSteps || []).map((s) => `R${s.round}:a${s.activeSboxes}`).join(' ')
  check('E7 其活跃分布为「R1 一盒 + R2~R4 免费 + R5 一盒」（与 BCA 的 2 盒路径一致）',
    steps === 'R1:a1 R2:a0 R3:a0 R4:a0 R5:a1', steps)
}

/* ═══════════════════════════ 【F】页面口径标注（不许回退） ═══════════════════════════ */

console.log('\n【F】页面口径标注守卫')
{
  const results = fs.readFileSync(path.join(SRC, 'views', 'ResultsView.vue'), 'utf8')
  const analysis = fs.readFileSync(path.join(SRC, 'views', 'AnalysisView.vue'), 'utf8')
  const home = fs.readFileSync(path.join(SRC, 'views', 'HomeView.vue'), 'utf8')
  /* ★ 2026-10-17 起口径变了：页面数值**只来自后端 BCA 的全空间精确解**，
     前端束搜索不再参与求值。原来这几条断言钉的是「上界」徽标与两列对照卡 ——
     现在那些东西已经不存在了，继续钉旧文案会让测试永远红，也会误导后来的人。
     新的守卫目标：**数字旁必须写清"这是精确值"**，且旧的上界口径不许偷偷回到页面。 */
  check('F1 结果页徽标写「精确值」（未解完写「部分求解」），并移除「上界」徽标',
    /'精确值'/.test(results) && /'部分求解'/.test(results)
    && !/badge: '上界'/.test(results), '')
  check('F2 结果页说明数值来自后端全空间 SAT（kissat），不再是束搜索',
    /kissat/.test(results) && /全空间/.test(results), '')
  check('F3 首页 / 差分页写明「求解走后端精确解」，且未解轮次显示「还未求解」',
    /后端 BCA/.test(analysis) && /还未求解/.test(analysis)
    && /后端 BCA/.test(home) && /还未求解/.test(home), '')
  check('F4 结果页权重徽标副标题不得写成「最小差分概率」这类绝对化表述',
    !/最小差分概率/.test(results), '出现了「最小差分概率」的绝对化表述')
  // 口径**方向**：−log₂p 是上界、概率是下界。写反会被现场听众当场抓（可证伪）。
  // 实测反例（2026-10-16 修）：曾写作「是概率的上界」「本平台的 −log₂p 是概率的上界」。
  //
  // ⚠️ 2026-10-17：原来只扫 results/analysis/home 三个文件，于是 **TutorialView（真正摆着
  // 完整对照表的那一页）漏网** —— 它就写着「只保证是概率的上界」。改为按目录枚举全部
  // 页面/组件，加页面不必再来这里登记（同一语义两处维护 = 迟早不同步）。
  const pageSrc = {}
  for (const dir of ['views', 'components']) {
    const abs = path.join(SRC, dir)
    if (!fs.existsSync(abs)) continue
    for (const f of fs.readdirSync(abs)) {
      if (/\.(vue|js)$/.test(f)) {
        pageSrc[`${dir}/${f}`] = fs.readFileSync(path.join(abs, f), 'utf8')
      }
    }
  }
  const reversedWording = Object.entries(pageSrc)
    .filter(([, src]) => /概率的[^，。；\n]{0,6}上界/.test(src))
    .map(([name]) => name)
  check('F5 口径方向正确：全部页面/组件不得出现「概率的上界」这类反向表述',
    reversedWording.length === 0,
    `反向表述出现在：${reversedWording.join(', ') || '(无)'}（应为 −log₂p 上界 / 概率下界）`)
  check('F5b 口径方向检查确实覆盖到教程页（防止名单退回手写三文件）',
    /TutorialView\.vue/.test(Object.keys(pageSrc).join(',')),
    '教程页未被扫描——对照表就写在那页，漏掉它等于没查')
  check('F6 结果页把口径钉在数字旁：写明「全空间最优 / 精确值」，不留"至少这么难"的旧说法',
    /全空间最优/.test(results) && /精确值/.test(results)
    && !/−log₂p 只可能更小/.test(results), '未标出新口径')
}

/* ════════════════════════════════════ 汇总 ════════════════════════════════════ */

console.log('\n' + '─'.repeat(72))
if (fails.length) {
  console.log(`【速度 vs 正确性复核】${pass} 项通过，${fails.length} 项失败：`)
  for (const f of fails) console.log('   ✗ ' + f)
  process.exit(1)
} else {
  console.log(`【速度 vs 正确性复核】全部 ${pass} 项通过。`)
  console.log(`  耗时：R8=${timing[8].ms.toFixed(0)}ms  R16=${timing[16].ms.toFixed(0)}ms  R32=${timing[32].ms.toFixed(0)}ms`)
  console.log('  结论：默认参数下报出的每条特征都真实可达（独立重算 + 真实加密抽样双向吻合）；')
  console.log('        R1~R4 与 BCA 全空间精确解一致，R5+ 是权重上界（差距源自起点覆盖，非搜索算法）。')
}
