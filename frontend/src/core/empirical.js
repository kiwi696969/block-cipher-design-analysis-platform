/**
 * 经验命中率验证：用**真实加密**抽样检验差分特征。
 *
 * 为什么需要它：引擎给出的 −log₂(p) 是理论概率（Markov 假设 + 查表得到）。
 * 这里反过来做——拿一条特征，随机抽一对明文，真的把它加密若干轮，
 * 数一数有多大比例的明密文对**恰好**走在预测的差分上。
 * 两边对得上，才说明「理论概率」不是纸面数字。
 *
 * 适用范围：只在 `startRound === 1` 且轮数较少时可行。
 * 因为概率随轮数指数衰减——32 轮的特征概率约 2^-647，
 * 任何可行样本量都不可能命中（这不是 bug，是密码学的意义所在）。
 * 所以本模块会对大轮数直接给出「不可行」判断，而不是假装跑了。
 */

import { sm4Encrypt, sm4KeySchedule } from './sm4ref.js'
import { SPN_CIPHERS } from './spnref.js'

/**
 * SPN 算法（AES / PRESENT）的抽样验证。
 *
 * 与 SM4 那条路径的关键差别：状态不是 4×32bit 字，而是 16 个独立单元
 * （AES 8bit、PRESENT 4bit），所以直接按单元比对，不做任何字节序翻转 ——
 * SM4 那条 `reverse()` 是国标末尾反序置换导致的，照抄到这里就是错的。
 *
 * 密钥每次抽样都换（每 4096 组换一次以免密钥扩展成为瓶颈）：差分传播与密钥无关，
 * 换密钥只是排除"单密钥巧合"，不改变期望命中率。
 */
function empiricalSpn(char, { cipherId, samplesCap, minSamples, maxBits, seed, onProgress }) {
  const rounds = char.rounds
  const weight = char.weight
  const prob = Math.pow(2, -weight)
  const C = SPN_CIPHERS[cipherId]
  const cellBits = C.cellBits
  const mask = (1 << cellBits) - 1

  if (weight > maxBits) {
    return {
      ok: true, feasible: false, rounds, weight, prob, samples: 0, hits: 0,
      reason: `理论权重 ${weight.toFixed(2)} bit（概率 2^${(-weight).toFixed(0)}），`
        + `需要约 10^${(weight / Math.log2(10)).toFixed(0)} 对样本才可能命中，远超可行范围。`
        + `本项在 ${maxBits} bit 以内才有统计意义 —— 这正是分组密码的安全性所在。`,
    }
  }

  const dIn = char.inputState.slice()
  const dOut = char.outputState.slice()
  if (dIn.every((v) => v === 0)) {
    return { ok: false, feasible: false, rounds, reason: '输入差分为全零，无法构造明文对。' }
  }

  const ideal = Math.ceil(20 / (prob || 1))
  const total = Math.max(minSamples, Math.min(samplesCap, ideal))
  const lambda = total * prob
  const t0 = performance.now()

  let s = seed >>> 0
  const rnd = () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s
  }

  let hits = 0
  let keyHex = null
  for (let i = 0; i < total; i++) {
    // 换密钥：AES 16 字节 / PRESENT 20 个 hex 位。
    // ⚠️ 明文必须**每对都重抽**：曾为省事每 16 对复用一个明文对，
    //    同一对的 16 次抽样结果完全相同 → 有效样本量掉到 1/16，
    //    命中率方差虚高，实测值频繁跳出 ±3√λ（看起来像"引擎概率算错"）。
    if ((i & 0x1ff) === 0) {
      const keyBytes = C.cellBits === 8 ? 16 : 10
      keyHex = Array.from({ length: keyBytes }, () => (rnd() & 0xff).toString(16).padStart(2, '0')).join('')
    }
    const p1 = Array.from({ length: C.cells }, () => rnd() & mask)
    const p2 = p1.map((v, k) => (v ^ dIn[k]) & mask)
    const c1 = C.encrypt(p1, keyHex, rounds)
    const c2 = C.encrypt(p2, keyHex, rounds)
    let same = true
    for (let k = 0; k < C.cells; k++) {
      if (((c1[k] ^ c2[k]) & mask) !== (dOut[k] & mask)) { same = false; break }
    }
    if (same) hits++
    if ((i & 0x3ff) === 0) onProgress(i + 1, total, hits)
  }

  const elapsed = performance.now() - t0
  const measured = hits / total
  const lo = Math.max(0, lambda - 3 * Math.sqrt(lambda))
  const hi = lambda + 3 * Math.sqrt(lambda)
  const feasible = lambda >= 5
  let verdict, level
  if (!feasible) {
    verdict = `理论命中数仅 ${lambda.toFixed(3)} 次，样本量不足以区分 —— 需要更多样本或更少轮数`
    level = 'weak'
  } else if (hits >= lo && hits <= hi) {
    verdict = `实测命中 ${hits} 次，理论期望 ${lambda.toFixed(1)} 次，落在 ±3√λ 区间内 —— 特征得到验证`
    level = 'good'
  } else if (hits < lo) {
    verdict = `实测命中 ${hits} 次，低于理论期望 ${lambda.toFixed(1)} 次的下界 ${lo.toFixed(1)} —— 偏离偏低`
    level = 'low'
  } else {
    verdict = `实测命中 ${hits} 次，高于理论期望 ${lambda.toFixed(1)} 次的上界 ${hi.toFixed(1)} —— 偏离偏高`
    level = 'high'
  }

  const hex = (cells) => cells.map((v) => (v & mask).toString(16)).join('')
  return {
    ok: true, feasible, rounds, weight, prob,
    samples: total, hits, measured, expected: prob, lambda,
    accept: [lo, hi], elapsedMs: elapsed,
    verdict, level,
    deltaIn: [hex(dIn)], deltaOut: [hex(dOut)],
    cipher: cipherId,
  }
}


/**
 * @param {object} char  feistelCharacteristicSearch 返回的最优特征
 * @param {object} opts
 *   samples    抽样对数上限（默认 500000）
 *   minSamples 抽样对数下限，避免小轮数时样本太少（默认 5000）
 *   maxBits    可接受的最大理论权重；超过则判定不可行（默认 30）
 *   seed       随机种子（同种子必同结果，便于回归测试）
 *   onProgress (done, total, hits) => void
 * @returns {object} 验证报告
 */
export function empiricalHitRate(char, opts = {}) {
  const {
    samples: samplesCap = 500000,
    minSamples = 5000,
    maxBits = 30,
    seed = 0x5eed,
    onProgress = () => {},
  } = opts

  const rounds = char.rounds
  const startRound = char.startRound ?? 1

  // 区间不从第 1 轮开始时，"起点状态"不是真实可构造的加密中间态 → 无法抽样
  if (startRound !== 1) {
    return {
      ok: false, feasible: false, rounds, startRound,
      reason: `特征区间从第 ${startRound} 轮开始，起点状态不是可构造的加密中间态，无法抽样验证。`
        + '请把起始轮改为 1 后重试。',
    }
  }

  const weight = char.weight
  const prob = Math.pow(2, -weight)

  // ★ 完整 AES / PRESENT：按 16 个单元的真实加密抽样（不走下面 4×32bit 那条）
  if (char.cipher === 'aes' || char.cipher === 'present') {
    return empiricalSpn(char, { cipherId: char.cipher, samplesCap, minSamples, maxBits, seed, onProgress })
  }

  if (weight > maxBits) {
    return {
      ok: true, feasible: false, rounds, weight, prob, samples: 0, hits: 0,
      reason: `理论权重 ${weight.toFixed(2)} bit（概率 2^${(-weight).toFixed(0)}），`
        + `需要约 10^${(weight / Math.log2(10)).toFixed(0)} 对样本才可能命中，远超可行范围。`
        + `本项在 ${maxBits} bit 以内才有统计意义 —— 这正是分组密码的安全性所在。`,
    }
  }

  const dIn = (char.inputState || []).map((v) => v >>> 0)
  const dOut = (char.outputState || []).map((v) => v >>> 0)
  // 比对目标是 sm4Encrypt 的真值，状态必须是 4 × 32bit 字。
  // 自定义结构（如手搭的 2 分支 Feistel）没有对应的前向加密，
  // 硬跑只会得出「命中 0 次」这种假结论 —— 宁可不给数字。
  if (dIn.length !== 4 || dOut.length !== 4) {
    return {
      ok: false, feasible: false, rounds,
      reason: '抽样验证只对 4 × 32bit 字状态的算法有意义（当前用它比对的是真实 SM4 加密）。'
        + '自定义结构的特征请以逐轮统计与中文解析为准。',
    }
  }
  if (dIn.every((v) => v === 0)) {
    return { ok: false, feasible: false, rounds, reason: '输入差分为全零，无法构造明文对。' }
  }

  // 目标：期望命中约 20 次；同时受上下限约束
  const ideal = Math.ceil(20 / (prob || 1))
  const total = Math.max(minSamples, Math.min(samplesCap, ideal))
  const lambda = total * prob
  const t0 = performance.now()

  let s = seed >>> 0
  const rnd = () => {
    // xorshift32：快、可重现，统计性质足够用于抽样
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s
  }

  let hits = 0
  for (let i = 0; i < total; i++) {
    const key = [rnd(), rnd(), rnd(), rnd()]
    const rk = sm4KeySchedule(key)
    const p1 = [rnd(), rnd(), rnd(), rnd()]
    const p2 = [p1[0] ^ dIn[0], p1[1] ^ dIn[1], p1[2] ^ dIn[2], p1[3] ^ dIn[3]]

    // sm4Encrypt 的输入是 (X0,X1,X2,X3)，但输出是**降序**的 (X_{R+3},…,X_R)
    // （因为标准在末尾做了一次反序置换）。引擎的 outputState 用的是升序窗口
    // (ΔX_R, ΔX_{R+1}, ΔX_{R+2}, ΔX_{R+3})，所以这里必须反转后再比对。
    // —— 这是一处实测踩到的坑：不反转则命中率恒为 0，看起来像"特征算错了"。
    const c1 = sm4Encrypt(p1, rk, { rounds }).reverse()
    const c2 = sm4Encrypt(p2, rk, { rounds }).reverse()

    let same = true
    for (let k = 0; k < 4; k++) {
      if (((c1[k] ^ c2[k]) >>> 0) !== dOut[k]) { same = false; break }
    }
    if (same) hits++
    if ((i & 0xfff) === 0) onProgress(i + 1, total, hits)
  }

  const elapsed = performance.now() - t0
  const measured = hits / total
  const expected = prob

  // 小概率下命中数近似服从 Poisson(λ)，用 λ ± 3√λ 作为可接受带
  const lo = Math.max(0, lambda - 3 * Math.sqrt(lambda))
  const hi = lambda + 3 * Math.sqrt(lambda)

  const feasible = lambda >= 5
  let verdict, level
  if (!feasible) {
    verdict = `理论命中数仅 ${lambda.toFixed(3)} 次，样本量不足以区分 —— 需要更多样本或更少轮数`
    level = 'weak'
  } else if (hits >= lo && hits <= hi) {
    verdict = `实测命中 ${hits} 次，理论期望 ${lambda.toFixed(1)} 次，落在 ±3√λ 区间内 —— 特征得到验证`
    level = 'good'
  } else if (hits < lo) {
    verdict = `实测命中 ${hits} 次，低于理论期望 ${lambda.toFixed(1)} 次的下界 ${lo.toFixed(1)} —— 偏离偏低`
    level = 'low'
  } else {
    verdict = `实测命中 ${hits} 次，高于理论期望 ${lambda.toFixed(1)} 次的上界 ${hi.toFixed(1)} —— 偏离偏高`
    level = 'high'
  }

  return {
    ok: true, feasible, rounds, weight, prob,
    samples: total, hits, measured, expected, lambda,
    accept: [lo, hi], elapsedMs: elapsed,
    verdict, level,
    deltaIn: dIn.map((v) => '0x' + v.toString(16).padStart(8, '0')),
    deltaOut: dOut.map((v) => '0x' + v.toString(16).padStart(8, '0')),
  }
}

/**
 * 为一个轮数区间做「逐轮命中率」曲线：1 轮、2 轮 … 直到不可行。
 * 每轮都重新搜一条特征（起点恒为第 1 轮），因此曲线是**真实轮数的真实特征**。
 * @returns Array<{rounds, weight, samples, hits, measured, expected, feasible}>
 */
export function hitRateCurve(maxRounds = 6, opts = {}) {
  const { search, samplesPerRound = 20000, maxBits = 26 } = opts
  const out = []
  for (let r = 1; r <= maxRounds; r++) {
    const char = search(r)
    if (!char) break
    const rep = empiricalHitRate(char, { samples: samplesPerRound, maxBits })
    out.push({ rounds: r, weight: char.weight, ...rep })
    if (!rep.feasible && char.weight > maxBits) break
  }
  return out
}
