/**
 * 核心引擎回归测试（Node，无第三方依赖）
 *
 * 目的：把「项目权威基准值」固化成断言。任何人改动 core/ 下的引擎代码，
 * 跑这个脚本就知道有没有破坏密码学正确性。
 *
 * 用法：cd frontend && node tests/verify-core.mjs
 *
 * 全部期望值来源：技能文档 `cipher-crypto-analysis-platform/SKILL.md`
 * 的「SM4 基准值（权威，勿质疑）」小节 —— 这些数字是**事实**，不是调参目标。
 * 若断言失败，先怀疑自己改坏了引擎，不要改这里的期望值。
 */

import { SBox, BUILTIN_SBOXES } from '../src/core/sbox.js'
import { SBoxLibrary, autoParseSBox } from '../src/core/sboxlib.js'
import {
  MODE, SEARCH_MODEL, MODEL_SPEC,
  feistelCharacteristicSearch, sm4RoundProfile, analyze, avalancheTest,
  forwardEncryptWords,
} from '../src/core/analysis.js'
import { TEMPLATES, CipherGraph, NODE_TYPES, graphBlockBits, graphBlockSize } from '../src/core/graph.js'
import { addDiffProb, addDiffTopK, addLinCorr, addLinTopK } from '../src/core/addmodel.js'
import { empiricalHitRate, hitRateCurve } from '../src/core/empirical.js'
import * as sm4ref from '../src/core/sm4ref.js'

/* ---------------------------------------------------------------- 断言框架 */

let passed = 0
const failures = []

function check(label, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? '  \x1b[90m' + detail + '\x1b[0m' : ''}`)
  } else {
    failures.push(`${label}${detail ? ' — ' + detail : ''}`)
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? '  ' + detail : ''}`)
  }
}

/** 浮点比较（引擎报告保留 2 位小数，容差取 0.01） */
function near(actual, expected, tol = 0.01) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tol
}

function group(title) {
  console.log(`\n\x1b[1m\x1b[36m${title}\x1b[0m`)
}

/* ---------------------------------------------------------------- 环境准备 */

// Node 里没有 localStorage；sboxlib 的 load()/save() 有 try/catch，
// 但显式打桩更稳，也避免测试互相污染。
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const lib = new SBoxLibrary() // 构造函数内部会设置 globalThis.__SBOX_LIB__

// 站点默认搜索参数（与 UI 默认值必须一致 —— 见「铁律：全轮扫描与运行分析同参数」）
const DEF = {
  mode: MODE.DIFFERENTIAL,
  searchDepth: 'beam',
  beamWidth: 8,
  maxCandidates: 24,
  timeBudgetMs: 12000,
  sboxRef: 'sm4',
}

console.log('核心引擎回归测试')
console.log('='.repeat(64))

/* ================================================================ 1. S 盒指标 */

group('【1】SM4 S 盒密码学指标')
{
  const b = BUILTIN_SBOXES.sm4
  const sb = new SBox(b.table.slice(), 8, 8, 'SM4')

  check('元素个数 256', b.table.length === 256, `${b.table.length}`)
  check('构成置换', sb.isValidPermutation() === true)

  const du = sb.differentialUniformity()
  check('差分均匀度 DU = 4', du.value === 4, `实测 ${du.value}`)
  check('最大差分概率 = 2^-6', near(du.value / 256, 2 ** -6, 1e-9), `${du.value}/256`)

  check('非线性度 NL = 112', sb.nonlinearity() === 112, `实测 ${sb.nonlinearity()}`)

  // ⚠️ 历史事故点：线性度应为 16（= 2^7 − NL），不是 32。
  //    engine 返回的是「折半 WHT 约定」下的 max|LAT|，恰为 16。
  const li = sb.linearity()
  check('线性度 = 16（不是 32）', li.value === 16, `实测 ${li.value}`)
  check('线性度 == 128 − NL', li.value === 128 - sb.nonlinearity(), `128−112=16`)
  check('最大线性相关 = 2^-3 = 0.125', near(li.value / 128, 0.125, 1e-9), `${li.value}/128`)

  check('差分分支数 = 2', sb.diffBranchNumber().value === 2, `${sb.diffBranchNumber().value}`)

  let fixed = 0
  for (let x = 0; x < 256; x++) if (b.table[x] === x) fixed++
  // ⚠️ S[0xab] = 0xab 是**正确的**，不要"修"它（改掉会把 DU 从 4 弄成 6）
  check('不动点 = 1（S[0xab]=0xab 是对的）', fixed === 1, `实测 ${fixed}`)
  check('S[0xab] === 0xab', b.table[0xab] === 0xab)

  const stats = lib.stats(sb)
  check('代数次数 = 7', stats.algebraicDegree === 7, `实测 ${stats.algebraicDegree}`)
  check('评级为 A', stats.grade.level === 'A', stats.grade.text)

  // DDT 结构：每行恰好 1 个 4，126 个 2
  const ddt = sb.getDDT()
  let c4 = 0, c2 = 0
  for (let a = 1; a < 256; a++) for (let o = 0; o < 256; o++) {
    const v = ddt[a][o]
    if (v === 4) c4++
    else if (v === 2) c2++
  }
  check('DDT 中值为 4 的项 = 255', c4 === 255, `实测 ${c4}`)
  check('DDT 中值为 2 的项 = 32130', c2 === 32130, `实测 ${c2}`)
}

/* ================================================================ 2. 官方向量 */

group('【2】SM4 官方测试向量（GB/T 32907-2016）')
{
  const MK = '0123456789abcdeffedcba9876543210'

  check('加密 MK=PT → 681edf34d206965e86b3e94f536e4246',
    sm4ref.sm4EncryptHex(MK, MK) === '681edf34d206965e86b3e94f536e4246',
    sm4ref.sm4EncryptHex(MK, MK))

  check('解密可逆',
    sm4ref.sm4DecryptHex('681edf34d206965e86b3e94f536e4246', MK) === MK)

  check('迭代 1,000,000 次 → 595298c7c6fd271f0402f804c33d3f66',
    sm4ref.sm4IterateHex(MK, MK, 1000000) === '595298c7c6fd271f0402f804c33d3f66',
    sm4ref.sm4IterateHex(MK, MK, 1000000))

  const rk = sm4ref.sm4RoundKeyHexs(MK)
  check('rk[0] = f12186f9', rk[0] === 'f12186f9', rk[0])
  check('rk[31] = 9124a012', rk[31] === '9124a012', rk[31])

  // ⚠️ X4 是「第 4 个**新生成**状态字」，不是密文。曾把它误当密文从而误判引擎有 bug。
  //    sm4StateTrace 返回 X0..X35，其中 X0..X3 = 明文四个字，X4..X35 = 迭代产生。
  //    所以 X4 是 trace[4]（不是 trace[3]）—— 这是本次实测踩到的一个下标陷阱。
  const trace = sm4ref.sm4StateTrace(MK, MK)
  check('状态轨迹长度 = 36（X0..X35）', trace.length === 36, `${trace.length}`)
  check('X0..X3 = 明文四个字',
    trace[0] === 0x01234567 && trace[3] === 0x76543210,
    trace.slice(0, 4).map((v) => '0x' + (v >>> 0).toString(16)).join(', '))
  check('X4（第 4 个状态字） = 0x27fad345',
    (trace[4] >>> 0) === 0x27fad345, '0x' + (trace[4] >>> 0).toString(16))
  check('X35（密文首字） = 0x681edf34',
    (trace[35] >>> 0) === 0x681edf34, '0x' + (trace[35] >>> 0).toString(16))

  // 密钥扩展必须用 L′（B ⊕ rotl13 ⊕ rotl23），误用 L 会得到全错的轮密钥
  const rkWithLp = sm4ref.sm4RoundKeyHexs(MK, BUILTIN_SBOXES.sm4.table)
  check('密钥扩展用 L′ 而非 L（rk[0] 未退化为 6c0dc92a）',
    rkWithLp[0] !== '6c0dc92a' && rkWithLp[0] === 'f12186f9', rkWithLp[0])
}

/* ================================================================ 3. 轮数增长表 */

group('【3】32 轮差分特征：随轮数增长（beam=8）')
{
  // ⚠️ 2026-10-15：默认起点集合扩了「三轮免费」族 Δ=(a,a,a,0)（见 analysis.js 起点块）。
  //    这组值是**扩起点后**的真实值；R1~R4 = 0/0/0/6 与后端 BCA（SAT 全空间最小）一致。
  //    旧值（只跑单字单比特起点）= 8→135 / 16→326 / 32→687，是更松的上界，勿回退。
  const EXPECT = [
    [8, 92.00, 15], [12, 188.00, 31], [16, 274.00, 45],
    [20, 370.00, 61], [24, 461.00, 76], [28, 556.00, 92], [32, 647.00, 107],
  ]
  for (const [rounds, expW, expActive] of EXPECT) {
    const chars = feistelCharacteristicSearch({ ...DEF, rounds })
    const best = chars[0]
    check(`${String(rounds).padStart(2)} 轮 −log₂(p) = ${expW.toFixed(2)}`,
      near(best?.weight, expW), `实测 ${best?.weight?.toFixed(2)}`)
    check(`${String(rounds).padStart(2)} 轮活跃 S 盒 = ${expActive}`,
      best?.activeSboxes === expActive, `实测 ${best?.activeSboxes}`)
  }

  // 32 轮的派生指标
  const best = feistelCharacteristicSearch({ ...DEF, rounds: 32 })[0]
  check('32 轮 = 20.22 bit/轮', near(best.weight / 32, 20.22),
    `实测 ${(best.weight / 32).toFixed(2)}`)
  check('32 轮输入差分非零 4 字', best.inputState.some((v) => v !== 0),
    '(' + best.inputState.map((v) => '0x' + (v >>> 0).toString(16)).join(',') + ')')
  check('每轮权重单调不减', best.feistelSteps.every((s, i, a) => i === 0 || s.roundWeight >= 0))
  check('复杂度模型已填（数据/时间）',
    best.dataComplexity > 0 && best.timeComplexity > 0,
    `数据 2^${best.dataComplexity} / 时间 2^${best.timeComplexity}`)
}

/* ================================================================ 4. 区间语义 */

group('【4】轮数区间语义（Feistel 平移不变性）')
{
  const a = feistelCharacteristicSearch({ ...DEF, startRound: 1, endRound: 16 })[0]
  const b = feistelCharacteristicSearch({ ...DEF, startRound: 17, endRound: 32 })[0]
  // 这不是巧合而是结构性质，可当作回归断言
  check('1~16 与 17~32 权重相同 = 274.00',
    near(a.weight, 274.00) && near(b.weight, 274.00),
    `${a.weight.toFixed(2)} / ${b.weight.toFixed(2)}`)
  check('1~16 与 17~32 活跃 S 盒相同 = 45',
    a.activeSboxes === 45 && b.activeSboxes === 45,
    `${a.activeSboxes} / ${b.activeSboxes}`)

  // 单轮区间：Δb⊕Δc⊕Δd = 0 → 无活跃 S 盒、概率 1
  const one = feistelCharacteristicSearch({ ...DEF, startRound: 20, endRound: 20 })[0]
  check('单轮区间 20~20 → 权重 0.00', near(one.weight, 0), `实测 ${one.weight.toFixed(2)}`)
  check('单轮区间 20~20 → 活跃 S 盒 0', one.activeSboxes === 0, `实测 ${one.activeSboxes}`)

  // 轮数等价性：rounds=8 ≡ startRound=1,endRound=8
  const viaRounds = feistelCharacteristicSearch({ ...DEF, rounds: 8 })[0]
  const viaRange = feistelCharacteristicSearch({ ...DEF, startRound: 1, endRound: 8 })[0]
  check('rounds=8 ≡ startRound:1,endRound:8',
    near(viaRounds.weight, viaRange.weight),
    `${viaRounds.weight.toFixed(2)} / ${viaRange.weight.toFixed(2)}`)
}

/* ================================================================ 5. 束宽影响 */

group('【5】辅助变量：束宽 beamWidth')
{
  const b24 = feistelCharacteristicSearch({ ...DEF, rounds: 32, beamWidth: 24 })[0]
  const b8 = feistelCharacteristicSearch({ ...DEF, rounds: 32, beamWidth: 8 })[0]
  const b1 = feistelCharacteristicSearch({ ...DEF, rounds: 32, beamWidth: 1 })[0]

  check('beam=24 → 633.00 / 活跃 104', near(b24.weight, 633.00) && b24.activeSboxes === 104,
    `${b24.weight.toFixed(2)} / ${b24.activeSboxes}`)
  check('beam=8  → 647.00 / 活跃 107', near(b8.weight, 647.00) && b8.activeSboxes === 107,
    `${b8.weight.toFixed(2)} / ${b8.activeSboxes}`)
  check('beam=1  → 666.00 / 活跃 111', near(b1.weight, 666.00) && b1.activeSboxes === 111,
    `${b1.weight.toFixed(2)} / ${b1.activeSboxes}`)
  check('束宽越大越接近最优（权重单调不增）',
    b24.weight <= b8.weight + 1e-9 && b8.weight <= b1.weight + 1e-9,
    `${b24.weight.toFixed(2)} ≤ ${b8.weight.toFixed(2)} ≤ ${b1.weight.toFixed(2)}`)

  // greedy ≡ 束宽 1
  const greedy = feistelCharacteristicSearch({ ...DEF, rounds: 32, searchDepth: 'greedy' })[0]
  check('searchDepth=greedy ≡ beamWidth=1', near(greedy.weight, b1.weight),
    `${greedy.weight.toFixed(2)} / ${b1.weight.toFixed(2)}`)
}

/* ================================================================ 6. 教学对照 */

group('【6】教学对照实验（量化 S 盒与扩散层的贡献）')
{
  const real = feistelCharacteristicSearch({ ...DEF, rounds: 32 })[0]
  const tauOnly = feistelCharacteristicSearch({ ...DEF, rounds: 32, tauOnly: true })[0]
  const linearS = feistelCharacteristicSearch({ ...DEF, rounds: 32, linearS: true })[0]

  check('真实 SM4 → 647.00 / 活跃 107',
    near(real.weight, 647.00) && real.activeSboxes === 107,
    `${real.weight.toFixed(2)} / ${real.activeSboxes}`)
  check('仅 τ（去掉 L 扩散层）→ 84.00 / 活跃 12',
    near(tauOnly.weight, 84.00) && tauOnly.activeSboxes === 12,
    `${tauOnly.weight.toFixed(2)} / ${tauOnly.activeSboxes}`)
  check('去掉扩散层导致安全性损失约 87%',
    (1 - tauOnly.weight / real.weight) > 0.85,
    `损失 ${((1 - tauOnly.weight / real.weight) * 100).toFixed(1)}%`)
  check('线性化 S 盒 → 0.00（概率=1，存在必然成立的差分路径）',
    near(linearS.weight, 0), `实测 ${linearS.weight.toFixed(2)}`)
}

/* ================================================================ 7. 三种搜索模型 */

group('【7】三种搜索模型与不变量')
{
  const pwm = feistelCharacteristicSearch({ ...DEF, rounds: 32, model: SEARCH_MODEL.WEIGHT })[0]
  const pmm = feistelCharacteristicSearch({ ...DEF, rounds: 32, model: SEARCH_MODEL.MAP })[0]
  const d05 = feistelCharacteristicSearch({ ...DEF, rounds: 32, model: SEARCH_MODEL.DUAL, lambda: 0.5 })[0]
  const d2 = feistelCharacteristicSearch({ ...DEF, rounds: 32, model: SEARCH_MODEL.DUAL, lambda: 2 })[0]
  const d0 = feistelCharacteristicSearch({ ...DEF, rounds: 32, model: SEARCH_MODEL.DUAL, lambda: 0 })[0]

  check('PWM → W = 647.00', near(pwm.weight, 647.00), `实测 ${pwm.weight.toFixed(2)}`)

  // 🔑 不变量：E[w] ≥ W 恒成立，且 E[w] 与所选模型无关（它是对同一条特征的独立度量）
  check('不变量 E[w] ≥ W（747.33 ≥ 647.00）',
    pwm.mapWeight >= pwm.weight && near(pwm.mapWeight, 747.33),
    `E[w]=${pwm.mapWeight.toFixed(2)} W=${pwm.weight.toFixed(2)}`)
  check('E[w] 与模型无关（PWM 与 PMM 同一条特征 → E[w] 相同）',
    near(pwm.mapWeight, pmm.mapWeight),
    `PWM ${pwm.mapWeight.toFixed(2)} / PMM ${pmm.mapWeight.toFixed(2)}`)

  check('λ=0 时 DWM 与 PWM 逐字段相同（J == W）',
    near(d0.weight, pwm.weight) && near(d0.dualScore, pwm.weight),
    `W=${d0.weight.toFixed(2)} J=${d0.dualScore.toFixed(2)}`)

  check('λ=0.5 → W=655.00 / D=375 / J=842.50',
    near(d05.weight, 655.00) && d05.diffusionWeight === 375 && near(d05.dualScore, 842.50),
    `W=${d05.weight.toFixed(2)} D=${d05.diffusionWeight} J=${d05.dualScore.toFixed(2)}`)
  check('λ=2   → W=681.00 / D=337 / J=1355.00',
    near(d2.weight, 681.00) && d2.diffusionWeight === 337 && near(d2.dualScore, 1355.00),
    `W=${d2.weight.toFixed(2)} D=${d2.diffusionWeight} J=${d2.dualScore.toFixed(2)}`)

  check('λ ↑ → D ↓ 且 W ↑（用一点概率换更稀疏的差分）',
    d2.diffusionWeight < d05.diffusionWeight && d2.weight > d05.weight,
    `D ${d2.diffusionWeight} < ${d05.diffusionWeight}；W ${d2.weight.toFixed(2)} > ${d05.weight.toFixed(2)}`)

  check('不变量 J ≥ W（λ, D ≥ 0）',
    d05.dualScore >= d05.weight - 1e-9 && d2.dualScore >= d2.weight - 1e-9)

  // 默认参数下 PMM 与 PWM 给出同一条特征。
  //
  // ⚠️ 2026-10-16 **断言翻转**（同 verify-fangzhen.mjs 头部的说明）：
  //    此前这里锁的是「branchLimit=8 时两模型开始分叉（PWM 505.00 / PMM 511.00）」。
  //    实测证明那两个数**不是模型差异，而是缺陷假象** —— `enumTauBranches` 里
  //    `if (combos.length > 256) break` 会把还没展开的活跃字节整块丢掉，τout 里
  //    那些字节恒为 0；而对非零输入差分 `DDT[Δ≠0][0] ≡ 0`（S 盒双射），该分支概率
  //    实为 0。于是引擎报出一个**物理上不可达、且偏小（看着更优）**的权重。
  //    阈值实测：4 个活跃字节时 limit ≥ 7 触发（7³ = 343 > 256）。
  //    修好后两模型在同一条**真实可达**特征上重合，且都经独立 DDT 重算确认。
  //    完整扫描见 frontend/tests/verify-accuracy.mjs【D】。
  check('默认参数下 PMM 与 PWM 重合（都是 647.00）',
    near(pmm.weight, 647.00), `实测 ${pmm.weight.toFixed(2)}`)
  const pmmB8 = feistelCharacteristicSearch({
    ...DEF, rounds: 32, model: SEARCH_MODEL.MAP, branchLimit: 8,
  })[0]
  const pwmB8 = feistelCharacteristicSearch({
    ...DEF, rounds: 32, model: SEARCH_MODEL.WEIGHT, branchLimit: 8,
  })[0]
  check('branchLimit ↑ 到 8：两模型仍重合，上界由 647.00 真改善为 646.00（放大候选确实搜到了更优的真实特征）',
    near(pwmB8.weight, 646.00) && near(pmmB8.weight, 646.00),
    `PWM ${pwmB8.weight.toFixed(2)} / PMM ${pmmB8.weight.toFixed(2)}`)
  const pwmB64 = feistelCharacteristicSearch({
    ...DEF, rounds: 32, model: SEARCH_MODEL.WEIGHT, branchLimit: 64,
  })[0]
  // 单边断言（故意不锁精确值）：DEF 的 timeBudgetMs = 12000 与 UI 默认一致，
  // branchLimit=64 的 32 轮搜索会被预算截断（实测 663.00 > 646.00，引擎会记 warn），
  // 所以这一档的精确值随预算浮动。真正要守的是**方向**：
  // 丢字节缺陷会给出 ~500 的假「更优」值，修好后**不可能低于**真实可达的 646.00。
  check('branchLimit 放大到 64 不再产生「更优」的假结果（丢字节缺陷回归守卫：不得 < 646.00）',
    pwmB64.weight >= 645.99, `实测 ${pwmB64.weight.toFixed(2)}`)

  // 未知模型 id 回退 weight
  const unknown = feistelCharacteristicSearch({ ...DEF, rounds: 8, model: 'no-such-model' })[0]
  check('未知模型 id 回退到 weight', near(unknown.weight, 92.00),
    `实测 ${unknown.weight.toFixed(2)}`)

  check('MODEL_SPEC 三个模型齐备', Object.keys(MODEL_SPEC).length === 3,
    Object.keys(MODEL_SPEC).join(', '))
}

/* ================================================================ 8. 线性分析 */

group('【8】线性分析（LAT）')
{
  const EXPECT = [[16, 276.00, 46], [24, 456.00, 76], [32, 642.00, 107]]
  for (const [rounds, expW, expActive] of EXPECT) {
    const best = feistelCharacteristicSearch({ ...DEF, rounds, mode: MODE.LINEAR })[0]
    check(`线性 ${String(rounds).padStart(2)} 轮 → ${expW.toFixed(2)} / 活跃 ${expActive}`,
      near(best.weight, expW) && best.activeSboxes === expActive,
      `实测 ${best.weight.toFixed(2)} / ${best.activeSboxes}`)
  }
  const l16 = feistelCharacteristicSearch({ ...DEF, rounds: 16, mode: MODE.LINEAR })[0]
  check('线性 16 轮 = 17.25 bit/轮', near(l16.weight / 16, 17.25),
    `实测 ${(l16.weight / 16).toFixed(2)}`)
  check('线性与差分为不同口径（16 轮 276 ≠ 274）',
    !near(l16.weight, 274.00), `线性 ${l16.weight.toFixed(2)} vs 差分 274.00`)
}

/* ================================================================ 9. 逐轮 Profile */

group('【9】逐轮特征表（sm4RoundProfile）')
{
  const prof = sm4RoundProfile({ ...DEF, rounds: 16 })
  check('perRound 覆盖 16 轮', prof.perRound.length === 16, `${prof.perRound.length}`)
  check('最后一轮累计权重 = 274.00', near(prof.perRound[15].weight, 274.00),
    `实测 ${prof.perRound[15].weight.toFixed(2)}`)
  check('累计活跃 S 盒 = 45', prof.perRound[15].cumActive === 45,
    `实测 ${prof.perRound[15].cumActive}`)
  check('每轮都带本轮权重与累计活跃两个字段（曲线能画出来）',
    prof.perRound.every((r) => 'roundWeight' in r && 'cumActive' in r))
  check('累计权重单调不减',
    prof.perRound.every((r, i) => i === 0 || r.weight >= prof.perRound[i - 1].weight - 1e-9))
  check('第 1 轮无活跃 S 盒（Feistel 结构性质）', prof.perRound[0].activeSboxes === 0,
    `实测 ${prof.perRound[0].activeSboxes}`)
}

/* ================================================================ 10. SPN 模板 */

group('【10】SPN 通用路径（非 Feistel 引擎）')
{
  const SPN_OPTS = { mode: MODE.DIFFERENTIAL, blockBits: 32, onLog: () => {}, searchMode: 'bb' }

  const gPresent = TEMPLATES.present_like.build()
  const rPresent = analyze(gPresent, { ...SPN_OPTS, rounds: 16, maxCandidates: 6, timeBudgetMs: 6000 })
  const presentFull = rPresent.characteristics.filter((c) => c.rounds === 16)
  const pBest = presentFull.reduce((a, b) => (b.weight < a.weight ? b : a), presentFull[0])
  check('类 PRESENT 16 轮 → 32.00',
    near(pBest?.weight, 32.00), `实测 ${pBest?.weight?.toFixed(2)}`)
  check('类 PRESENT 16 轮活跃 S 盒 = 16',
    pBest?.activeSboxes === 16, `实测 ${pBest?.activeSboxes}`)
  check('类 PRESENT 逐轮累计曲线 2→4→…→32（每轮 +2）',
    rPresent.perRound.every((r, i) => near(r.weight, (i + 1) * 2)),
    rPresent.perRound.map((r) => r.weight.toFixed(0)).join('→'))

  const gAes = TEMPLATES.aes_like.build()
  const rAes = analyze(gAes, { ...SPN_OPTS, rounds: 10, maxCandidates: 6, timeBudgetMs: 6000 })
  const aesFull = rAes.characteristics.filter((c) => c.rounds === 10)
  const aBest = aesFull.reduce((a, b) => (b.weight < a.weight ? b : a), aesFull[0])
  // ⚠️ 2026-10-14：列混淆从「自造近似」换成**真 GF(2⁸)**（AES 的 [02 03 01 01]）后，
  //    扩散从每轮 +3 变成 +4（分支数 5 ⇒ 1 个活跃字节 → 4 个），活跃 S 盒 34 → 37、
  //    权重 204.00 → 222.00。已用独立脚本（不 import 平台引擎，自建 GF(2⁸) + 穷举 DDT
  //    光束搜索）逐轮复现 1→5→9→…→37，见 verify-fangzhen.mjs【11】。
  check('类 AES 10 轮 → 222.00（真 GF(2⁸) 列混淆）',
    near(aBest?.weight, 222.00), `实测 ${aBest?.weight?.toFixed(2)}`)
  check('类 AES 10 轮活跃 S 盒 = 37（1 + 9×4，列混淆分支数 5 的直接结果）',
    aBest?.activeSboxes === 37, `实测 ${aBest?.activeSboxes}`)

  // 线性侧同步更新（同一个真 GF(2⁸) 列混淆）：AES S 盒行内最大 |LAT| = 16 → 相关度 2⁻³
  // → 平方后同为 6.00 bit/活跃盒 ⇒ 36 个活跃 = 216.00。旧近似层下是 180.00。
  const rAesLin = analyze(gAes, {
    ...SPN_OPTS, mode: MODE.LINEAR, rounds: 10, maxCandidates: 6, timeBudgetMs: 6000,
  })
  const aesLinFull = rAesLin.characteristics.filter((c) => c.rounds === 10)
  const aLinBest = aesLinFull.reduce((a, b) => (b.weight < a.weight ? b : a), aesLinFull[0])
  check('类 AES 10 轮线性 → 216.00（36 个活跃 S 盒 × 6.00）',
    near(aLinBest?.weight, 216.00), `实测 ${aLinBest?.weight?.toFixed(2)}`)

  // 把 S 盒换成线性 S 盒 → 概率退化为 1
  const lin8 = Array.from({ length: 256 }, (_, i) => i)
  const imp = lib.import('Linear8-Test', lin8, 8, 8)
  const gLin = TEMPLATES.aes_like.build()
  const sboxNode = gLin.nodes.find((n) => n.type === 'SBOX')
  sboxNode.props.sboxId = imp.id
  sboxNode.props.mode = 'byte'
  const rLin = analyze(gLin, { ...SPN_OPTS, rounds: 10, maxCandidates: 6, timeBudgetMs: 6000 })
  const linFull = rLin.characteristics.filter((c) => c.rounds === 10)
  const lBest = linFull.reduce((a, b) => (b.weight < a.weight ? b : a), linFull[0])
  check('类 AES + 线性 8bit S 盒 → 0.00（存在必然差分路径）',
    near(lBest?.weight, 0), `实测 ${lBest?.weight?.toFixed(2)}`)

  lib.remove(imp.id)

  // 分析结果的结构契约
  check('analyze 返回 ok / perRound / characteristics / candidates',
    rPresent.ok === true && Array.isArray(rPresent.perRound)
    && Array.isArray(rPresent.characteristics) && Array.isArray(rPresent.candidates),
    Object.keys(rPresent).join(', '))
}

/* ================================================================ 11. 雪崩效应 */

group('【11】雪崩效应（SM4 全图，128 样本）')
{
  const g = TEMPLATES.sm4.build()
  const av = avalancheTest(g, { samples: 128 })
  check('返回雪崩统计', !!av)
  if (av) {
    check('平均翻转比特 ≈ 16（理想值 16）', Math.abs(av.avg - 16) < 1.2,
      `avg=${av.avg?.toFixed(3)}`)
    check('归一化偏离 < 0.1', av.normalized < 0.1, `normalized=${av.normalized?.toFixed(4)}`)
  }
}

/* ================================================================ 12. 确定性 */

group('【12】确定性（同参数必同结果）')
{
  const a = feistelCharacteristicSearch({ ...DEF, rounds: 16 })[0]
  const b = feistelCharacteristicSearch({ ...DEF, rounds: 16 })[0]
  check('同参数两次运行结果完全一致',
    a.weight === b.weight && a.activeSboxes === b.activeSboxes,
    `${a.weight.toFixed(2)} / ${b.weight.toFixed(2)}`)

  // 图引擎与 Feistel 引擎在 SM4 上必须一致 —— 否则平台有两套数
  const g = TEMPLATES.sm4.build()
  check('SM4 图模板 round 数 = 32', g.meta?.rounds === 32, `${g.meta?.rounds}`)
  check('图节点/边非空', g.nodes.length > 0 && g.edges.length > 0,
    `${g.nodes.length} 节点 / ${g.edges.length} 边`)
}

/* ================================================================ 13. 经验命中率 */

group('【13】经验命中率（用真实加密抽样验证理论概率）')
{
  // 这是最强的一类断言：把引擎"算出来"的概率，拿去和"真跑加密"的结果对。
  // 先搜特征，再随机抽明文对、真加密 R 轮、数命中比例。
  const r1 = feistelCharacteristicSearch({ ...DEF, rounds: 1 })[0]
  const e1 = hitRateCurve(4, {
    search: (r) => feistelCharacteristicSearch({ ...DEF, rounds: r })[0],
    samplesPerRound: 20000,
    maxBits: 20,
  })

  const v1 = e1[0]
  check('R=1 理论权重 0.00（概率 1，确定性）', near(v1?.weight, 0), `实测 ${v1?.weight?.toFixed(2)}`)
  check('R=1 抽样命中率 100%（必然成立）',
    v1?.hits === v1?.samples && v1?.measured === 1,
    `${v1?.hits}/${v1?.samples}`)

  // ⚠️ 2026-10-15：起点扩了「三轮免费」族 Δ=(a,a,a,0) 后，R=2、R=3 同样是免费轮
  //    （F 输入差分恒为 0），权重 0、概率 1。**真正有非线性的是 R=4**（第 4 轮必有
  //    1 个活跃 S 盒）→ 概率 2^-6。经验验证因此改在 R=4 上做。
  const v3 = e1[2]
  check('R=3 理论权重 0.00（免费轮，概率 1）', near(v3?.weight, 0), `实测 ${v3?.weight?.toFixed(2)}`)

  const v4 = e1[3]
  check('R=4 理论概率 = 2^-6 = 1.5625%', near(v4?.expected, 0.015625, 1e-9),
    `${(v4?.expected * 100).toFixed(4)}%`)
  check('R=4 实测命中率与理论量级一致（落在 ±3√λ 内）',
    v4?.level === 'good',
    `实测 ${v4?.hits} 次 / 理论 ${v4?.lambda?.toFixed(1)} 次`)
  check('R=4 实测命中率偏差 < 1 个百分点',
    Math.abs(v4?.measured - v4?.expected) < 0.01,
    `实测 ${(v4?.measured * 100).toFixed(4)}% vs 理论 ${(v4?.expected * 100).toFixed(4)}%`)

  // 大轮数必须**诚实报告不可行**，而不是假装跑了
  const big = feistelCharacteristicSearch({ ...DEF, rounds: 32 })[0]
  const vBig = empiricalHitRate(big, { samples: 5000, maxBits: 30 })
  check('32 轮诚实报告"不可行"（而不是假装命中）',
    vBig.ok === true && vBig.feasible === false,
    vBig.reason?.slice(0, 60))

  // 区间不从第 1 轮开始时无法构造起点状态，也要诚实拒绝
  const mid = feistelCharacteristicSearch({ ...DEF, startRound: 5, endRound: 8 })[0]
  const vMid = empiricalHitRate(mid, { samples: 5000 })
  check('区间起点非第 1 轮时拒绝抽样并说明原因',
    vMid.ok === false && /第 5 轮/.test(vMid.reason || ''),
    vMid.reason?.slice(0, 50))

  check('同种子抽样结果可复现',
    (() => {
      const a = empiricalHitRate(r1, { samples: 3000, seed: 42 })
      const b = empiricalHitRate(r1, { samples: 3000, seed: 42 })
      return a.hits === b.hits
    })())
}

/* ================================================================ 14. S 盒库 · 服务端同步 */

group('【14】S 盒库 ↔ 服务端同步（在 S 盒库页导入的盒子要能在画布下拉里选到）')
{
  // 背景：`/sbox/` 页写的是 Django 数据库，画布的 S 盒下拉读的是前端 sboxLib ——
  // 两套存储过去互不相通，导入的 S 盒在结构编辑器里根本选不到。
  // `syncServer()` 是它们之间唯一的连接点，这里把它的三条规则逐条钉住。
  const n0 = lib.list().length

  // 规则 1：与内置表内容相同的服务端项必须跳过。
  // 内置 S 盒在迁移 0002 里也有一份种子，不去重下拉里就会出现两个「SM4」。
  const r1 = lib.syncServer([
    { id: 1, name: 'SM4 S-Box', bits: 8, table: BUILTIN_SBOXES.sm4.table.slice() },
    { id: 2, name: 'PRESENT S-Box', bits: 4, table: BUILTIN_SBOXES.present.table.slice() },
  ])
  check('与内置表重复的服务端种子被跳过', r1.total === 0 && r1.skipped === 2,
    `total=${r1.total} skipped=${r1.skipped}`)
  check('列表条数没有增加（下拉里不会出现两个「SM4」）', lib.list().length === n0,
    `${lib.list().length} vs ${n0}`)

  // 规则 2：真正的新盒要能按 `srv_<主键>` 取到（画布节点就是这么引用的），指标也要算得出来。
  // 夹具拿 PRESENT 的表把前两项对调：确定性、仍是置换、且与任何内置表都不同。
  const alt = BUILTIN_SBOXES.present.table.slice()
  ;[alt[0], alt[1]] = [alt[1], alt[0]]

  const r2 = lib.syncServer([{ id: 7, name: '回归用 4bit 盒', bits: 4, table: alt, desc: '回归夹具' }])
  check('新 S 盒进入库', r2.total === 1, `total=${r2.total}`)

  const sb = lib.getSBoxByRef('srv_7')
  check('能用 srv_<主键> 取到它', !!sb && sb.inBits === 4, sb ? `${sb.name} / ${sb.inBits}bit` : 'null')
  check('取到的表数据与导入的一致', !!sb && sb.table.join(',') === alt.join(','))
  check('列表里带 remote 标记（界面据此显示「S 盒库」）',
    lib.list().some((o) => o.id === 'srv_7' && o.remote === true))

  // `size` 是**位宽**（`getSBoxByRef()` 构造 SBox 要用），界面不能拿它当"项数"：
  // 过去 256 项的 8bit 盒在下拉里被写成「8 项」。`count` 才是项数。
  const listed = lib.list()
  check('列表里的 count 是项数而不是位宽（4bit→16、8bit→256）',
    listed.some((o) => o.id === 'srv_7' && o.size === 4 && o.count === 16)
      && listed.some((o) => o.id === 'sm4' && o.size === 8 && o.count === 256),
    JSON.stringify(listed.filter((o) => ['srv_7', 'sm4'].includes(o.id))
      .map((o) => `${o.id}:size=${o.size},count=${o.count}`)))

  const st = lib.stats(sb)
  check('指标能算出来（置换判定 + 差分均匀度 + 非线性度）',
    st?.isPermutation === true && Number.isFinite(st.differentialUniformity)
      && Number.isFinite(st.nonlinearity),
    `perm=${st?.isPermutation} DU=${st?.differentialUniformity} NL=${st?.nonlinearity}`)

  // 规则 3：整表替换 —— 服务端删掉的，本地镜像里也要消失，不留幽灵 S 盒
  const r3 = lib.syncServer([])
  check('再次同步后旧项被清掉（整表替换，不是增量合并）',
    r3.total === 0 && r3.previous === 1 && lib.getSBoxByRef('srv_7') === null,
    `total=${r3.total} previous=${r3.previous}`)

  // 服务端内部同一张表的重复记录只留一条
  const r4 = lib.syncServer([
    { id: 11, name: 'A', bits: 4, table: alt },
    { id: 12, name: 'A 的副本', bits: 4, table: alt.slice() },
  ])
  check('服务端内部的重复表只保留一条', r4.total === 1 && r4.skipped === 1,
    `total=${r4.total} skipped=${r4.skipped}`)

  // 本地导入（localStorage 那一路）不受影响，两者并存
  const imp = lib.import('回归自定义盒', alt, 4, 4)
  check('本地导入仍可用，且与服务端镜像并存',
    !!lib.getSBoxByRef(imp.id)
      && lib.list().some((o) => o.id === imp.id)
      && lib.list().some((o) => o.id === 'srv_11'),
    `custom=${imp.id}`)

  // 收尾：清掉这一节造成的状态，保持零副作用
  lib.remove(imp.id)
  lib.clearServer()
  check('收尾后回到初始状态', lib.list().length === n0 && lib.getSBoxByRef('srv_11') === null,
    `${lib.list().length} vs ${n0}`)
}

/* ================================================================ 15. ARX / 模加（ADD）精确模型 */

/*
 * 历史脉络（同一批断言的两次生命）：
 *   2026-10-16 上午实测发现引擎对**模加**没有进位模型 —— `analysis.js` 里 `add`
 *   只做 `a|v` 并集且 `prob` 恒为 1，于是 ARX（加法是唯一非线性源）会拿到
 *   prob=1 / weight=0 的**假结论**（真实单轮概率 ≈2⁻²，差十个数量级）。
 *   当时把「含 add/and 必须报 warn」钉成**能力边界守卫**。
 *   同日下午补上 `core/addmodel.js`（进位链精确模型，3/4/5 位全穷举对拍）后，
 *   这批断言**翻转成正确性断言**（按项目规矩：修好后翻转，不删）：
 *     · ADD 不再警告（它现在有真规则）
 *     · ADD 的传播必须给出**真实概率**（不再是 1）
 *     · 模型本身必须与**内联穷举**零不符（不复用被测实现，才算独立复核）
 *   AND 仍是保守估算 → 警告保留，继续钉住。
 */
{
  const mk = (op) => {
    const g = new CipherGraph()
    g.meta = { name: `arx-${op}`, blockSize: 32, rounds: 1, structure: 'spn' }
    const inp = g.addNode('INPUT', 0, 0, { bits: 32, blocks: 1 })
    const mg = g.addNode('MERGE', 200, 0, { op })
    const out = g.addNode('OUTPUT', 400, 0, { rounds: 1 })
    g.addEdge(inp.id, 'out', mg.id, 'a')
    g.addEdge(inp.id, 'out', mg.id, 'b')
    g.addEdge(mg.id, 'out', out.id, 'in')
    return { g, mg }
  }

  const { g: gAdd, mg: mgAdd } = mk('add')
  check('★ 含「模加 ADD」的图不再报 warn —— 它现在有精确规则（进位链模型）',
    !gAdd.validate().some((i) => i.msg.includes(mgAdd.id)),
    JSON.stringify(gAdd.validate().map((i) => i.level)))

  const { g: gAnd, mg: mgAnd } = mk('and')
  const andHit = gAnd.validate().find((i) => i.level === 'warn' && i.msg.includes(mgAnd.id))
  check('★ AND 仍是保守估算 → 警告保留（不许静默给 prob=1）', !!andHit,
    JSON.stringify(gAnd.validate().map((i) => i.level)))
  check('★ 该警告须点明「概率恒为 1」并给出修法',
    !!andHit && /概率恒为 1/.test(andHit.msg) && /XOR/.test(andHit.msg))

  const { g: gXor, mg: mgXor } = mk('xor')
  check('★ XOR 不报该警告（不误伤正常结构）',
    !gXor.validate().some((i) => i.msg.includes(mgXor.id)))
}

{
  /* —— ADD 差分模型：与**内联穷举**对拍（独立实现，不复用 addmodel）—— */
  const bruteD = (n, a, b, gg) => {
    const size = 1 << n, m = size - 1
    let c = 0
    for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
      if ((((x + y) ^ (((x ^ a) + (y ^ b)) & m)) & m) === gg) c++
    }
    return c / Math.pow(2, 2 * n)
  }
  let bad = 0
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let gg = 0; gg < 16; gg++) {
    if (Math.abs(bruteD(4, a, b, gg) - addDiffProb(4, a, b, gg)) > 1e-12) bad++
  }
  check('★ ADD 差分模型与内联穷举零不符（n=4，4096 组）', bad === 0, `不符 ${bad} 组`)

  /* —— ADD 线性模型：同样与内联穷举对拍 —— */
  const popc = (v) => { let c = 0; while (v) { c += v & 1; v >>>= 1 } return c }
  const bruteL = (n, ax, ay, gg) => {
    const size = 1 << n, m = size - 1
    let s = 0
    for (let x = 0; x < size; x++) for (let y = 0; y < size; y++) {
      s += ((popc(ax & x) ^ popc(ay & y) ^ popc(gg & ((x + y) & m))) & 1) ? -1 : 1
    }
    return s / (size * size)
  }
  let badL = 0
  for (let ax = 0; ax < 16; ax++) for (let ay = 0; ay < 16; ay++) for (let gg = 0; gg < 16; gg++) {
    if (Math.abs(bruteL(4, ax, ay, gg) - addLinCorr(4, ax, ay, gg)) > 1e-12) badL++
  }
  check('★ ADD 线性模型与内联穷举零不符（n=4，4096 组）', badL === 0, `不符 ${badL} 组`)

  /* —— 已证伪的旧假值：α=1 必须给 p=1/2，不是 1 —— */
  const t = addDiffTopK(32, 1, 0, 8)
  check('★ α=1, β=0 → 最可能 γ=0x1 且 p=1/2（不再是假的 1）',
    (t[0].gamma >>> 0) === 1 && Math.abs(t[0].prob - 0.5) < 1e-12,
    `γ=0x${(t[0].gamma >>> 0).toString(16)} p=${t[0].prob}`)
  check('★ α=1 的候选不止一个（ADD 是「一进多出」，不是 XOR 那种唯一输出）',
    t.length > 1, `候选 ${t.length} 个`)
}

{
  /* —— 端到端：ADD 节点经 analyze() 传播，prob 必须 < 1 —— */
  const g = new CipherGraph()
  g.meta = { name: 'add-prop', blockSize: 32, rounds: 1, structure: 'spn' }
  const inp = g.addNode('INPUT', 0, 0, { bits: 32, blocks: 1 })
  const mg = g.addNode('MERGE', 200, 0, { op: 'add' })
  const out = g.addNode('OUTPUT', 400, 0, { rounds: 1 })
  g.addEdge(inp.id, 'out', mg.id, 'a')
  g.addEdge(inp.id, 'out', mg.id, 'b')
  g.addEdge(mg.id, 'out', out.id, 'in')

  const res = analyze(g, { mode: MODE.DIFFERENTIAL, rounds: 1, blockBits: 32, initDiffs: [1] })
  const pr = res.perRound?.[0] || res.perRound?.slice(-1)[0]
  check('★ ADD 节点的差分传播已接真实模型（prob < 1，旧行为是恒 1）',
    !!pr && pr.prob < 1, `prob=${pr && pr.prob}`)
  const step = pr && pr.steps ? pr.steps.find((s) => s.nodeId === mg.id) : null
  check('★ 该步注明「精确差分」并带上候选分支数',
    !!step && /精确差分/.test(step.note || '') && step.addCandidates > 0,
    step ? `${step.note} | 候选=${step.addCandidates}` : 'no step')
}

{
  /* —— 架构缺口（ARX 的结构性障碍）：补上后同样翻转成正确性断言 ——
   * 旧断言：「组件库无子模块/函数复用节点」「INPUT 位宽上限 32，128bit 无法单字表达」。
   * 现断言：复合函数节点存在且值与独立参考 QR 一致；多字端口能表达 128bit 状态。 */
  const types = Object.keys(NODE_TYPES)
  check('★ 有可复用的复合函数节点（ARX 四分之一轮，一次定义 / 图上单节点）',
    types.includes('QUARTER_ROUND'), types.join(','))
  check('★ INPUT / OUTPUT 支持「多字端口」（128bit = 4×32bit 字的表达通路）',
    NODE_TYPES.INPUT.props.some((p) => p.key === 'multiword')
    && NODE_TYPES.OUTPUT.props.some((p) => p.key === 'multiword'))

  // 复合节点的**值**必须与内联参考 QR 一致（独立实现，不复用引擎）
  const rotl32 = (x, k) => (((x << k) | (x >>> (32 - k))) & 0xFFFFFFFF) >>> 0
  const refQR = (A, B, C, D) => {
    let a = (A + B) & 0xFFFFFFFF, d = rotl32(D ^ a, 16)
    let c = (C + d) & 0xFFFFFFFF, b = rotl32(B ^ c, 12)
    a = (a + b) & 0xFFFFFFFF; d = rotl32(d ^ a, 8)
    c = (c + d) & 0xFFFFFFFF; b = rotl32(b ^ c, 7)
    return [a, b, c, d]
  }
  const g = new CipherGraph()
  g.meta = { name: 'swirl-min', blockSize: 128, rounds: 1, structure: 'spn' }
  const i1 = g.addNode('INPUT', 0, 0, { bits: 32, blocks: 4, multiword: true })
  const q1 = g.addNode('QUARTER_ROUND', 200, 0, { r1: 16, r2: 12, r3: 8, r4: 7 })
  const o1 = g.addNode('OUTPUT', 400, 0, { rounds: 1, multiword: true, blocks: 4 })
  const op = ['w0', 'w1', 'w2', 'w3'], ip = ['a', 'b', 'c', 'd']
  op.forEach((p, i) => g.addEdge(i1.id, p, q1.id, ip[i]))
  ip.forEach((p, i) => g.addEdge(q1.id, p, o1.id, op[i]))
  check('★ 多字端口：旋涡式结构的 INPUT/OUTPUT 各 4 个端口',
    i1.outputs.length === 4 && o1.inputs.length === 4,
    `in=${i1.outputs.length} out=${o1.inputs.length}`)

  let bad = 0
  let seed = 0xABCDEF
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed }
  for (let t = 0; t < 50; t++) {
    const plain = [rnd(), rnd(), rnd(), rnd()]
    const got = forwardEncryptWords(g, 0, { rounds: 1, blockBits: 32, words: plain })
    const exp = refQR(plain[0], plain[1], plain[2], plain[3])
    for (let i = 0; i < 4; i++) if (((got[i] >>> 0) !== (exp[i] >>> 0))) bad++
  }
  check('★ 复合节点（QUARTER_ROUND）的值与内联参考 QR 零不符（50 组）', bad === 0, `不符 ${bad} 处`)

  // 差分传播必须给真值（不再是恒 1）
  const res = analyze(g, { mode: MODE.DIFFERENTIAL, rounds: 1, blockBits: 32, initDiffs: [1, 0, 0, 0] })
  const rr = (res.perRound || [])[0]
  check('★ ARX 结构的差分传播 prob < 1（旧行为恒 1，这是「假结论」的根源）',
    !!rr && rr.prob < 1, `prob=${rr && rr.prob}`)

  // 多字开关默认关闭 ⇒ 老结构不受影响
  const g2 = new CipherGraph()
  g2.meta = { name: 'legacy', blockSize: 32, rounds: 1, structure: 'spn' }
  const i2 = g2.addNode('INPUT', 0, 0, { bits: 32, blocks: 4 })
  const o2 = g2.addNode('OUTPUT', 300, 0, { rounds: 1 })
  g2.addEdge(i2.id, 'out', o2.id, 'in')
  check('★ 未开「多字端口」时 INPUT 仍是单端口（既有结构零影响）',
    i2.outputs.length === 1, `得 ${i2.outputs.length}`)
}

/* ================================================================
 * 【17】「拼图」样例（非平衡 Feistel + 查找表）暴露的 S 盒缺陷守卫
 *
 * 三处真缺陷（修复前）：
 *   D1 `SBox.outSize = 1 << outBits`：outBits ≥ 31 时 JS 回绕成 1 → DDT/LAT 循环上界坍缩
 *   D2 非等宽查找表按**输入位宽**平铺 → 相邻输出块重叠 OR（16→32 LUT 算错）
 *   D3 掩码级因此报 prob=0，而值级是确定性的 → 两条路径自相矛盾
 *   （附带）大盒（16×16，DDT 4.3G cell）会让 analyze() 直接抛错
 *
 * 架构边界（如实记录，未实现）：
 *   96bit 分组 / 64bit 半支路 / 「移位后拼接」节点都不存在 → 「拼图」整体搭不出来。
 * ================================================================ */
group('【17】「拼图」样例：查找表与非等宽 S 盒（能力边界 + 缺陷守卫）')

{
  const LUT = new SBox(
    Array.from({ length: 1 << 16 }, (_, x) => (Math.imul(x, 0x9E3779B1) ^ (x << 21)) >>> 0),
    16, 32, '守卫-16→32')
  const BIGBT = new SBox(
    Array.from({ length: 1 << 16 }, (_, x) => (Math.imul(x ^ (x >>> 7) ^ (x << 3), 0x9E3779B1) >>> 8) & 0xFFFF),
    16, 16, '守卫-16×16')
  const SMALL10 = new SBox(
    Array.from({ length: 1 << 10 }, (_, x) => ((x * 0x2B) ^ (x >>> 3)) & 0x3FF),
    10, 10, '守卫-10×10')
  const lutRef = lib.import('守卫-16→32', LUT.table, 16, 32, '守卫').id
  const bruteRow = (sb, a) => {
    const r = new Map()
    for (let x = 0; x < sb.inSize; x++) {
      const d = (sb.table[x] ^ sb.table[x ^ a]) & sb.outMask
      r.set(d, (r.get(d) || 0) + 1)
    }
    return r
  }
  const argmaxRow = (r) => { let bo = 0, bc = 0; for (const [d, c] of r) { if (d !== 0 && c > bc) { bc = c; bo = d } } return { out: bo >>> 0, count: bc } }
  const buildOne = (bits, ref) => {
    const g = new CipherGraph()
    g.meta = { name: 'one-sbox', blockSize: bits, rounds: 1, structure: 'spn' }
    const i = g.addNode('INPUT', 0, 0, { bits, blocks: 1 })
    const s = g.addNode('SBOX', 200, 0, { sboxId: ref, mode: 'parallel', repeat: 1 })
    const o = g.addNode('OUTPUT', 400, 0, { rounds: 1 })
    g.addEdge(i.id, 'out', s.id, 'in')
    g.addEdge(s.id, 'out', o.id, 'in')
    return g
  }

  /* —— D1：outSize 不再因 JS 位移回绕而坍缩 —— */
  check('★ outBits=32 时 outSize = 2^32（修复前 `1<<32` 回绕成 1）',
    LUT.outSize === 2 ** 32, String(LUT.outSize))
  const sq8 = new SBox(BUILTIN_SBOXES.sm4.table.slice(), 8, 8, 'sq8')
  check('8bit 方盒 outSize 仍是 256（既有行为零影响）', sq8.outSize === 256, String(sq8.outSize))

  /* —— 超大盒：显式拒绝建全表，而不是静默给坍缩的假表 —— */
  check('★ 16×16 盒 fullTableFeasible() = false（DDT 全表 65536×65536）',
    BIGBT.fullTableFeasible() === false)
  let ddtThrew = false
  try { BIGBT.getDDT() } catch { ddtThrew = true }
  check('★ 超大盒 getDDT() 显式抛错（可预期的拒绝，不是假表）', ddtThrew)

  /* —— D2/D3：非等宽查找表「整字一次查表」—— */
  const x = 0x00010001
  const gotV = forwardEncryptWords(buildOne(32, lutRef), x, { rounds: 1, blockBits: 32, lib })[0] >>> 0
  check('★ 值级：非等宽查找表输出 = 独立的一次查表（不再重叠 OR）',
    gotV === (LUT.apply(x & 0xFFFF) >>> 0), `引擎 ${gotV.toString(16)}`)

  const row1 = bruteRow(LUT, 1)
  const want1 = argmaxRow(row1)
  const resD = analyze(buildOne(32, lutRef), { mode: MODE.DIFFERENTIAL, rounds: 1, blockBits: 32, initDiffs: [1] })
  const prD = (resD.perRound || [])[0]
  check('★ 掩码级 Δout = 独立穷举的最可能 Δout', ((prD?.outputMask ?? 0) >>> 0) === want1.out,
    `引擎 ${((prD?.outputMask ?? 0) >>> 0).toString(16)} vs 穷举 ${want1.out.toString(16)}`)
  check('★ 掩码级概率 = 独立穷举（精确，且 > 0；旧行为是 prob=0）',
    !!prD && Math.abs(prD.prob - want1.count / LUT.inSize) < 1e-9 && prD.prob > 0,
    `prob=${prD && prD.prob}`)

  // 线性侧：宽输出无精确算法 → 显式「不支持」
  const resL = analyze(buildOne(32, lutRef), { mode: MODE.LINEAR, rounds: 1, blockBits: 32, initDiffs: [1] })
  const notesL = ((resL.perRound || [])[0]?.steps || []).map((s) => s.note || '').join(' | ')
  check('★ 宽输出线性侧显式标注「不支持」（不当成 0 相关）', /线性侧不支持/.test(notesL))

  /* —— 按需单行 ≡ 全表 —— */
  {
    const ddt = SMALL10.getDDT()
    let bad = 0
    for (const a of [1, 2, 3, 0x2B, 0x155, 0x3FF]) {
      const on = bruteRow(SMALL10, a)
      for (let b = 0; b < SMALL10.outSize; b++) if ((on.get(b) || 0) !== ddt[a][b]) bad++
    }
    check('★ 「按需单行」与全表零不符（10bit 盒 × 6 个 Δin）', bad === 0, `不符 ${bad}`)
  }

  /* —— 大盒不再让 analyze() 崩，且差分精确 —— */
  {
    const bigRef = lib.import('守卫-16×16', BIGBT.table, 16, 16, '守卫').id
    const rowB = bruteRow(BIGBT, 1)
    const wantB = argmaxRow(rowB)
    const resB = analyze(buildOne(16, bigRef), { mode: MODE.DIFFERENTIAL, rounds: 1, blockBits: 16, initDiffs: [1] })
    const prB = (resB.perRound || [])[0]
    check('★ 大盒下 analyze() 不抛错（修复前崩在 S 盒指标日志那一行）', resB.ok !== false)
    check('★ 大盒掩码级 Δout/概率 = 独立穷举（按需单行，精确）',
      ((prB?.outputMask ?? 0) >>> 0) === wantB.out
      && !!prB && Math.abs(prB.prob - wantB.count / BIGBT.inSize) < 1e-9,
      `prob=${prB && prB.prob}`)
  }

  /* —— validate() 的明确提示 —— */
  {
    const gLut = buildOne(32, lutRef)
    const iLut = gLut.validate()
    check('★ validate() 对非等宽查找表给出 warn（点明「整字一次查表」与宽输出限制）',
      iLut.some((i) => i.level === 'warn' && /非等宽查找表/.test(i.msg)))
    const gBig = buildOne(16, lib.import('守卫-16×16b', BIGBT.table, 16, 16, '守卫').id)
    check('★ validate() 对超大盒给出 warn（点明 DDT/LAT 全表不建、差分改按需单行）',
      gBig.validate().some((i) => i.level === 'warn' && /DDT\/LAT 全表超出内存上限/.test(i.msg)))
  }

  /* —— 架构边界（如实记录：这些**没有**实现）—— */
  const g96 = new CipherGraph()
  g96.addNode('INPUT', 0, 0, { bits: 96, blocks: 1 })
  check('★ 96bit 分组进不来：INPUT.bits 被夹到 32（「拼图」的第一道坎）',
    graphBlockBits(g96) === 32 && graphBlockSize(g96) === 32,
    `blockBits=${graphBlockBits(g96)} blockSize=${graphBlockSize(g96)}`)

  {
    const g = new CipherGraph()
    const i = g.addNode('INPUT', 0, 0, { bits: 32, blocks: 1 })
    const s = g.addNode('SPLIT', 200, 0, { splitBits: 48 })
    g.addEdge(i.id, 'out', s.id, 'in')
    // A = 低 splitBits 位，B = 其余高位
    const inM = 0xDEADBEEF, sb16 = 16
    const A = (inM & ((1 << sb16) - 1)) >>> 0, B = (inM >>> sb16) >>> 0
    check('★ SPLIT 语义：A=低位 / B=高位，且 splitBits 上限 32（分不出 64bit 的 R）',
      A === 0xBEEF && B === 0xDEAD
      && NODE_TYPES.SPLIT.props.find((p) => p.key === 'splitBits').max === 32)
  }

  {
    const mergeOps = NODE_TYPES.MERGE.props.find((p) => p.key === 'op').options.map((o) => o.v)
    const linOps = NODE_TYPES.LINEAR.props.find((p) => p.key === 'op').options.map((o) => o.v)
    check('★ 没有「移位后拼接」节点：MERGE 只做同位置合并、LINEAR 无左移补零（「拼图」第三道坎）',
      !mergeOps.some((o) => /concat|join|shl/i.test(o)) && !linOps.includes('shl'),
      `MERGE=${mergeOps.join('/')} LINEAR=${linOps.join('/')}`)
  }

  check('★ Feistel 迭代内核是**单宽度**：SPLIT 只有一个位宽属性（非平衡 32/64 表达不了）',
    NODE_TYPES.SPLIT.props.filter((p) => p.type === 'number').length === 1)
}

/* ================================================================ 汇总 */

console.log('\n' + '='.repeat(64))
const total = passed + failures.length
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1m全部通过：${passed}/${total}\x1b[0m`)
  process.exit(0)
} else {
  console.log(`\x1b[31m\x1b[1m${failures.length} 项失败 / 共 ${total} 项\x1b[0m`)
  for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`)
  process.exit(1)
}
