/* ============================================================
 * 传播追踪器：差分 / 线性掩码沿图结构的逐节点传播
 * 每次执行记录活跃比特、概率、分支等中间量
 * ============================================================ */

import { SBox } from './sbox.js';
import { hw, hwN, maskOf, rotl, rotr, applyBitPermutation, makeRng, activeNibbles, nibble } from './gf2.js';
import { addDiffTopK, addLinTopK } from './addmodel.js';

export const MODE = {
  DIFFERENTIAL: 'differential',
  LINEAR: 'linear',
};

/* ============================================================
 * 搜索模型
 * ------------------------------------------------------------
 * 三种模型的差别不在「怎么算概率」（概率一律查 DDT / LAT），
 * 而在「用什么目标函数挑候选」。报告的 −log₂p 永远是所选特征的真实
 * 概率，模型只决定搜索器偏好哪一条特征。
 * ============================================================ */
export const SEARCH_MODEL = {
  WEIGHT: 'weight',   // 概率权重模型
  MAP: 'map',         // 概率映射模型
  DUAL: 'dual',       // 双权优化模型
};

/**
 * 模型元信息。界面、手册、CLI 统一从这里取名称与文案，
 * 避免多处硬编码导致「界面写的和引擎做的不一致」。
 */
export const MODEL_SPEC = {
  weight: {
    id: 'weight',
    name: '概率权重模型',
    short: 'PWM',
    formula: 'W = Σ −log₂ pᵢ',
    objective: 'weight',
    desc: '经典 Matsui 模型：每轮取概率最大的分支，最小化累计权重，'
        + '给出概率最优（差分概率最大）的特征。',
    note: '上界意义上的「最好情况」，给出攻击者可期待的最优特征。',
  },
  map: {
    id: 'map',
    name: '概率映射模型',
    short: 'PMM',
    formula: 'E[w] = Σ pᵢ·wᵢ / Σ pᵢ',
    objective: 'mapWeight',
    desc: '把每个活跃 S 盒的 DDT/LAT 行当作一张概率映射，按映射的'
        + '信息熵（概率加权期望权重）计分，并记录映射规模（可达差分个数）。',
    note: '比权重模型保守：反映差分「平均会分散成什么样」，'
        + '用于评估平均扩散与截断差分，而非最好情况。',
  },
  dual: {
    id: 'dual',
    name: '双权优化模型',
    short: 'DWM',
    formula: 'J = W + λ · D',
    objective: 'dualScore',
    desc: '同时优化概率权重 W 与扩散权重 D = Σ hw(Δᵢ)（差分在状态里'
        + '铺开的活跃比特数），按标量化目标 J 保留候选，λ 由辅助变量给定。',
    note: 'λ = 0 时严格退化为概率权重模型；λ 越大越偏好「差分稀疏」的'
        + '特征（活跃比特少 → 密钥恢复时可过滤的位数少）。',
  },
};

/** 模型 id → 排序键字段名 */
export function modelKey(model) {
  const spec = MODEL_SPEC[model] || MODEL_SPEC.weight;
  return spec.objective;
}

/**
 * 按选定模型对「一轮转移」打分。
 *
 * 三个分量都在这里一次算清，调用方只做累加，保证逐轮与汇总自洽：
 *   weight     本轮概率权重 −log₂ p（连乘进总概率，任何模型都用它报告 −log₂p）
 *   mapWeight  本轮概率映射的期望权重 Σ pᵢ(−log₂ pᵢ) / Σ pᵢ，恒 ≥ −log₂ p_max
 *   diffusion  本轮输出差分的 Hamming 重量 hw(Δ)，即扩散权重
 *   dualScore  weight + λ·diffusion
 *
 * @param {object} p
 *   prob        所选分支的概率
 *   mapWeight   本轮概率映射的期望权重（调用方算好时直接给定，优先于 row）
 *   mapSize     本轮映射的可达差分个数（映射规模 / 扩散度）
 *   row         本轮全部可达分支的概率数组（未给 mapWeight 时按它推算）
 *   outMask     本轮输出差分（算扩散权重）
 *   activeCount 本轮活跃 S 盒数
 *   model       模型 id
 *   lambda      双权系数
 */
export function scoreRound({
  prob, row = null, mapWeight = null, mapSize = 0, outMask = 0, activeCount = 0,
  model = SEARCH_MODEL.WEIGHT, lambda = 0.5,
} = {}) {
  const p = Math.max(prob, Number.MIN_VALUE);
  const weight = -Math.log2(p);

  // 概率映射：把该活跃 S 盒的 DDT/LAT 整行（含各自概率）拿来求期望权重。
  // 只给单个分布时按 Σ pᵢ(−log₂ pᵢ) / Σ pᵢ 算；调用方已按映射分布算好
  // （如「逐活跃字节熵之和」，字节相互独立时与联合分布严格相等）则直接采用。
  let mw = weight, size = mapSize || 0, entropy = 0;
  if (mapWeight != null) {
    mw = mapWeight;
  } else if (row && row.length) {
    let mass = 0, acc = 0;
    for (const q of row) {
      if (!(q > 0)) continue;
      mass += q;
      acc += q * (-Math.log2(q));
      size++;
    }
    if (mass > 0) {
      mw = acc / mass;
      for (const q of row) {
        if (!(q > 0)) continue;
        const r = q / mass;
        entropy += -r * Math.log2(r);
      }
    }
  }

  const diffusion = hw(outMask >>> 0);

  return {
    weight,
    mapWeight: mw,
    diffusion,
    dualScore: weight + lambda * diffusion,
    mapSize: size,
    entropy,
    activeCount,
  };
}

/**
 * 概率映射：对 τ 的每个活跃输入字节取 DDT/LAT 整行（全部可达输出）构成映射。
 *
 * 返回
 *   expected  该轮映射的期望权重 = Σ_bytes H(行分布)。
 *             字节之间相互独立 → 独立变量的联合熵 = 各熵之和，故此值对联合映射精确。
 *   size      可达输出差分的组合数 Π_bytes(该字节非零项数)，即「映射规模 / 扩散度」。
 *   maxProb   该轮最优分支概率 = Π_bytes(max q)，用于对照概率权重模型。
 */
function tauProbMap(sb, inputDiff, mode, linearS = false) {
  let expected = 0, size = 1, active = 0, best = 1;
  for (let i = 0; i < 4; i++) {
    const b = (inputDiff >>> (i * 8)) & 0xFF;
    if (b === 0) continue;
    active++;
    const row = [];
    if (linearS) {
      row.push(1);
    } else if (mode === MODE.DIFFERENTIAL) {
      const r = sb.getDDT()[b];
      for (let o = 1; o < sb.outSize; o++) if (r[o] > 0) row.push(r[o] / sb.inSize);
    } else {
      const r = sb.getLAT()[b];
      const half = 1 << (sb.inBits - 1);
      for (let o = 1; o < sb.outSize; o++) if (r[o] !== 0) { const c = r[o] / half; row.push(c * c); }
    }
    if (!row.length) continue;
    let mass = 0, acc = 0, mx = 0;
    for (const q of row) { mass += q; acc += q * (-Math.log2(q)); if (q > mx) mx = q; }
    if (mass > 0) expected += acc / mass;
    size *= row.length;
    best *= mx;
  }
  if (!active) return { expected: 0, size: 0, maxProb: 1, active: 0 };
  return { expected, size, maxProb: best, active };
}

/** 按模型取候选的排序键（升序 = 越优） */
export function modelScore(cand, model = SEARCH_MODEL.WEIGHT) {
  switch (modelKey(model)) {
    case 'mapWeight': return cand.mapWeight ?? cand.weight ?? 0;
    case 'dualScore': return cand.dualScore ?? cand.weight ?? 0;
    default: return cand.weight ?? 0;
  }
}

/** 逐节点传播结果 */
class TraceStep {
  constructor(node, round, mode, inMask, outMask, extra = {}) {
    this.nodeId = node.id;
    this.nodeType = node.type;
    this.label = node.def.label;
    this.round = round;
    this.mode = mode;
    this.inMask = inMask >>> 0;
    this.outMask = outMask >>> 0;
    this.inWeight = hwN(this.inMask, 32);
    this.outWeight = hwN(this.outMask, 32);
    this.prob = extra.prob ?? 1;
    this.corr = extra.corr ?? 0;
    this.bias = extra.bias ?? 0;
    this.note = extra.note || '';
    // ★ 「该步落在可精确建模范围之外」（宽输出线性侧）：结构化标记。
    //   光靠 note 里那句「线性侧不支持」是**显示层**；判语义要看这个布尔，
    //   否则调用方只能正则匹配中文文案（见 verify-pintu.mjs【2】）。
    this.unsupported = extra.unsupported ?? false;
    // 状态复制（避免后续节点污染）
    this.stateBefore = extra.stateBefore ?? 0;
    this.stateAfter = extra.stateAfter ?? 0;
  }
}

/** 一次完整特征（路径） */
export class Characteristic {
  constructor(mode) {
    this.mode = mode;
    this.steps = [];
    this.inputMask = 0;
    this.outputMask = 0;
    this.rounds = 0;
    this.prob = 1;         // 差分概率 或 线性相关平方
    this.probLog2 = 0;
    this.weight = 0;       // -log2(prob)，越小越好
    this.activeSboxes = 0;
    this.activeBits = 0;
    this.branchCount = 0;
    this.keyGuesses = 0;
    this.complexity = 0;
    this.dataComplexity = 0;
    this.timeComplexity = 0;
    this.memoryComplexity = 0;
    this.nodesCovered = 0;
  }

  push(step) {
    this.steps.push(step);
    if (step.prob > 0 && step.prob < 1) {
      this.prob *= step.prob;
    }
  }

  /**
   * 由逐轮步骤（steps / feistelSteps）回填派生统计量。
   * 保证 activeSboxes / prob / weight 与逐轮数据始终自洽，
   * 避免出现「逐轮都有活跃 S 盒、但汇总为 0」的不一致。
   */
  syncFromSteps() {
    const steps = (this.feistelSteps && this.feistelSteps.length)
      ? this.feistelSteps
      : this.steps;
    if (!steps || !steps.length) return this;

    // 活跃 S 盒累计（两种步骤对象的字段名都要兼容）
    this.activeSboxes = steps.reduce(
      (a, s) => a + (s.activeSboxes || s.activeCount || 0), 0);

    // 各轮差分概率连乘 → 总概率与权重
    let acc = 1, hasProb = false;
    for (const s of steps) {
      const pr = (typeof s.prob === 'number') ? s.prob : null;
      if (pr !== null && pr > 0 && pr < 1) { acc *= pr; hasProb = true; }
    }
    if (hasProb) {
      this.prob = acc;
      this.probLog2 = acc > 0 ? Math.log2(acc) : -Infinity;
      this.weight = -this.probLog2;
    }

    // 带宽：取最大的单步活跃位数（用于界面展示）
    const w = steps.map(s => s.outWeight || s.activeSboxes || 0).filter(v => v > 0);
    this.activeBits = w.length ? Math.max(...w) : 0;
    return this;
  }

  finalize() {
    this.probLog2 = this.prob > 0 ? Math.log2(this.prob) : -Infinity;
    this.weight = -this.probLog2;
    // 优先采用累加器（Feistel 搜索会显式设置 activeSboxes）
    if (!this.activeSboxes) {
      this.activeSboxes = this.steps.reduce(
        (a, s) => a + (s.activeSboxes || s.activeCount || 0), 0);
    }
    // steps 为空但已有 feistelSteps 时，回填活跃 S 盒累计
    if (!this.activeSboxes && this.feistelSteps && this.feistelSteps.length) {
      this.activeSboxes = this.feistelSteps.reduce(
        (a, s) => a + (s.activeSboxes || s.activeCount || 0), 0);
    }
    this.activeBits = this.steps.length ? Math.max(...this.steps.map(s => s.outWeight)) : 0;
  }
}

/** 从 S 盒对象按模式选取"最优转移" */
/**
 * ★ 按需计算差分表的一行：Δin = a 时，各 Δout 的计数（Map）。
 *
 * 为什么需要它：DDT 是 `inSize × outSize` 的全表。8bit 盒 65536 cell 无压力，但
 * 16bit 盒 = 65536×65536 ≈ 4.3G cell（Uint16 也要 8GB）—— 建表直接崩，`getDDT()` 已改为显式抛错。
 * 而**差分分析根本不需要全表**：只需要当前这条差分路径碰到的那几行。
 * 于是按需算一行，复杂度 O(inSize)（16bit 盒 = 65536 次），**结果精确**。
 * 这与 ARX 的 ADD 模型是同一个思路：不必预先物化整张表。
 */
function ddtRowOnDemand(sb, a) {
  const n = sb.inSize;
  const row = new Map();
  for (let x = 0; x < n; x++) {
    const d = (sb.table[x] ^ sb.table[x ^ a]) & sb.outMask;
    row.set(d, (row.get(d) || 0) + 1);
  }
  return row;
}

/**
 * 超出可精确建模范围时的显式占位 —— **绝不伪造数值**。
 * 目前只有一种触发：宽输出（outBits ≥ 31）的**线性侧**。线性侧要 max_γ |Σ_x (−1)^{αx·x⊕γ·S(x)}|，
 * 而 γ 遍历 2^outBits 个输出掩码；outBits=32 时无法枚举（这是 max-cut 式的组合问题，没有快速精确算法）。
 * 差分侧没有这个问题（按需单行即可精确），所以只在线性侧出现。
 */
function unsupportedWideOutput(sb) {
  return {
    out: 0, prob: 0, corr: 0, count: 0, unsupported: true,
    note: `S 盒「${sb.name}」(${sb.inBits}→${sb.outBits}) 输出位宽过大：线性侧无精确算法，已标注「不支持」`,
  };
}

function bestTransition(sb, mode, inputMask, opts = {}) {
  const n = sb.inSize;
  if (inputMask === 0) return { out: 0, prob: 1, corr: 1, count: n };
  const feasible = sb.fullTableFeasible();
  if (mode === MODE.DIFFERENTIAL) {
    // ── 差分侧：全表可行走缓存表；不可行走按需单行（都是**精确**的） ──
    if (!feasible) {
      const row = ddtRowOnDemand(sb, inputMask & (n - 1));
      let bo = 0, bc = 0, firstNzOut = 0;
      for (const [d, c] of row) {
        if (d === 0) continue;
        if (firstNzOut === 0) firstNzOut = d;
        if (c > bc) { bc = c; bo = d; }
      }
      if (bc === 0) return { out: 0, prob: 0, count: 0, exact: true, onDemand: true };
      return { out: bo >>> 0, prob: bc / n, count: bc, exact: true, onDemand: true };
    }
    const ddt = sb.getDDT();
    const row = ddt[inputMask & (n - 1)];
    let best = 0, bo = 0, bc = 0;
    for (let b = 1; b < sb.outSize; b++) {
      const c = row[b];
      if (c > bc) { bc = c; bo = b; best = c / n; }
    }
    if (bc === 0) {
      // 无有效差分转移：选择分支数最优
      for (let b = 1; b < sb.outSize; b++) {
        if (row[b] > 0) { bo = b; bc = row[b]; break; }
      }
    }
    return { out: bo, prob: bc / n, count: bc };
  } else {
    // ── 线性侧：宽输出无法枚举 γ ⇒ 显式「不支持」 ──
    if (!feasible) return unsupportedWideOutput(sb);
    const lat = sb.getLAT();
    const row = lat[inputMask & (n - 1)];
    let bestAbs = -1, bo = 0, bv = 0;
    for (let b = 1; b < sb.outSize; b++) {
      const v = Math.abs(row[b]);
      if (v > bestAbs) { bestAbs = v; bo = b; bv = row[b]; }
    }
    const half = 1 << (sb.inBits - 1);
    const corr = bv / half;
    return { out: bo, corr, prob: corr * corr, count: bv };
  }
}

/** 枚举 S 盒传播的所有候选（用于路径搜索） */
function allTransitions(sb, mode) {
  return mode === MODE.DIFFERENTIAL ? sb.diffTransitions() : sb.linTransitions();
}

/** 检查 S 盒是否为恒等（无扩散能力） */
function isIdentitySBox(sb) {
  for (let i = 0; i < sb.inSize; i++) if (sb.table[i] !== i) return false;
  return true;
}

/* ============================================================
 * 单轮 / 多轮特征搜索
 * ============================================================ */

/**
 * 按 S 盒应用模式，将整字拆为若干 S 盒实例并返回列表
 * @returns {Array<{index:number, inMask:number, shift:number, width:number}>}
 */
function splitSBoxInputs(sb, fullMask, mode, blockBits) {
  const parts = [];
  // ★ 非等宽（查找表）**不平铺**：扩展型映射的输出比输入宽，若仍按 inBits 步进，
  //   相邻两块的输出会互相**重叠 OR**（真缺陷：「拼图」样例的 16→32 LUT 就是这样算错的）。
  //   改为「整字一次查表」：索引取字的低 inBits 位，输出落在 bit 0 起。
  if (sb.inBits !== sb.outBits) {
    return [{
      index: 0, shift: 0, width: sb.inBits,
      inMask: (fullMask & maskOf(Math.min(blockBits, sb.inBits))) >>> 0,
    }];
  }
  if (mode === 'parallel') {
    // 整字视为若干个 inBits 宽的块
    const w = sb.inBits;
    const cnt = Math.ceil(blockBits / w);
    for (let i = 0; i < cnt; i++) {
      const shift = i * w;
      const m = (fullMask >>> shift) & maskOf(w);
      parts.push({ index: i, inMask: m, shift, width: w });
    }
  } else if (mode === 'nibble') {
    const cnt = Math.ceil(blockBits / 4);
    for (let i = 0; i < cnt; i++) {
      parts.push({ index: i, inMask: (fullMask >>> (i * 4)) & 0xF, shift: i * 4, width: 4 });
    }
  } else { // byte
    const cnt = Math.ceil(blockBits / 8);
    for (let i = 0; i < cnt; i++) {
      parts.push({ index: i, inMask: (fullMask >>> (i * 8)) & 0xFF, shift: i * 8, width: 8 });
    }
  }
  return parts;
}

/** 执行一次 S 盒节点传播 */
function propagateSBox(node, inMask, mode, blockBits) {
  const lib = globalThis.__SBOX_LIB__;
  const sb = lib.getSBoxByRef(node.props.sboxId);
  if (!sb) return { outMask: inMask, prob: 1, activeCount: 0, note: 'S盒未找到，直通' };

  const repeat = Math.max(1, node.props.repeat | 0);
  let cur = inMask >>> 0;
  let totalProb = 1;
  let activeCount = 0;
  let mapWeight = 0;         // 概率映射模型：各活跃 S 盒的映射期望权重之和
  let unsupported = false;   // 有活跃单元落在「可精确建模范围」之外（宽输出线性侧）
  let truncated = false;     // 输出比词宽大 → 高位被截断
  const nonSquare = sb.inBits !== sb.outBits;

  for (let r = 0; r < repeat; r++) {
    const parts = splitSBoxInputs(sb, cur, node.props.mode || 'parallel', blockBits);
    let out = 0;
    let activeLocal = 0;
    for (const p of parts) {
      // 位宽不匹配时截断到 S 盒输入位宽
      const lm = p.inMask & maskOf(Math.min(p.width, sb.inBits));
      if (lm === 0) continue;
      if (isIdentitySBox(sb)) { out |= (lm << p.shift); continue; }
      const t = bestTransition(sb, mode, lm);
      // 超出范围（宽输出线性侧）：不计入 prob（否则会给 0 → 权重 ∞ 的假值），如实标记
      if (t.unsupported) { unsupported = true; activeLocal++; continue; }
      if (sb.outBits > blockBits) truncated = true;
      out |= ((t.out & maskOf(sb.outBits)) << p.shift);
      totalProb *= t.prob;
      mapWeight += mapRowWeight(sb, lm, mode);
      activeLocal++;
    }
    cur = out >>> 0;
    activeCount += activeLocal;
  }
  const notes = [`${activeCount} 个活跃 S 盒`];
  if (nonSquare) notes.push(`非等宽查找表 ${sb.inBits}→${sb.outBits}（整字一次查表）`);
  if (truncated) notes.push(`⚠️ 输出 ${sb.outBits}bit > 词宽 ${blockBits}bit，高位会被截断`);
  if (unsupported) notes.push('⚠️ 含宽输出 S 盒，线性侧不支持（该特征不精确）');
  return {
    outMask: cur, prob: totalProb, activeCount, mapWeight,
    unsupported, truncated, nonSquare,
    note: notes.join('；'),
  };
}

/**
 * 单个 S 盒输入对应的「概率映射期望权重」= Σ pᵢ(−log₂ pᵢ) / Σ pᵢ
 * （即 DDT / LAT 该行非零项分布的 Shannon 熵）。
 * 恒 ≥ 该行最大概率对应的 −log₂ p_max，故映射模型不会比权重模型更"乐观"。
 */
function mapRowWeight(sb, inputMask, mode) {
  // ★ 超出全表上限时：差分侧按需单行仍能精确算熵；线性侧无精确算法 → 0（不伪造）
  if (!sb.fullTableFeasible()) {
    if (mode !== MODE.DIFFERENTIAL) return 0;
    const row = ddtRowOnDemand(sb, inputMask & (sb.inSize - 1));
    let mass = 0, acc = 0;
    for (const [d, c] of row) {
      if (d === 0) continue;
      const q = c / sb.inSize;
      mass += q; acc += q * (-Math.log2(q));
    }
    return mass > 0 ? acc / mass : 0;
  }
  const row = [];
  if (mode === MODE.DIFFERENTIAL) {
    const r = sb.getDDT()[inputMask & (sb.inSize - 1)];
    for (let o = 1; o < sb.outSize; o++) if (r[o] > 0) row.push(r[o] / sb.inSize);
  } else {
    const r = sb.getLAT()[inputMask & (sb.inSize - 1)];
    const half = 1 << (sb.inBits - 1);
    for (let o = 1; o < sb.outSize; o++) if (r[o] !== 0) { const c = r[o] / half; row.push(c * c); }
  }
  let mass = 0, acc = 0;
  for (const q of row) { mass += q; acc += q * (-Math.log2(q)); }
  return mass > 0 ? acc / mass : 0;
}

/* ============================================================
 * GF(2⁸) 列混淆：值级与掩码级**同源**（AES 的 [02 03 01 01] 循环矩阵）
 *
 * ⚠️ 这里修的是一处真缺陷（见 AGENTS.md §4.35）。从前 `mixColumns` 有
 * **两套互不相干**的实现，同一个 Δin 会得到三个不同答案：
 *   · 掩码级（`propagateLinear`）：把字节掩码**原样 OR 到下一个字节**，
 *     对「四字节都活跃且相等」的状态是恒等映射（`0xdadadada → 0xdadadada`）；
 *   · 值级（`forwardEncrypt`）：`(b<<1)|(b>>>7)` —— 8 位**循环左移**，
 *     不是 GF(2⁸) 的 xtime（溢出要按 x⁸+x⁴+x³+x+1 约减，XOR 0x1b）。
 *   连扩散都弱于 AES（分支数 3 而非 5），且「谁是真 AES 列混淆」两者都不是。
 *
 * 现在只有**一份**实现 `mixColumnsWord()`（真 GF(2⁸)），掩码级取它的
 * GF(2)-线性延拓（逐比特基向量叠加）—— 两者在 32 个基向量上必然一致。
 * ============================================================ */

/** GF(2⁸) 乘法，约减多项式 x⁸+x⁴+x³+x+1（0x11b），与 AES 一致 */
export function gf256Mul(a, b) {
  let p = 0;
  let x = a & 0xFF;
  let y = b & 0xFF;
  for (let i = 0; i < 8; i++) {
    if (y & 1) p ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xFF;
    if (hi) x ^= 0x1B;   // ← 溢出约减：这一步就是「真 xtime」与循环左移的分水岭
    y >>= 1;
  }
  return p & 0xFF;
}

/** AES 的 xtime：×2 并按 0x11b 约减（0x80 → 0x1b，不是循环左移的 0x01） */
export const gf256Xtime = (b) => gf256Mul(b & 0xFF, 2);

/** 一列（4 字节）的 AES 列混淆：out[i] = 02·a[i] ⊕ 03·a[i+1] ⊕ a[i+2] ⊕ a[i+3] */
function mixColumn4(a) {
  const t = (i) => gf256Xtime(a[i]);
  return [
    (t(0) ^ t(1) ^ a[1] ^ a[2] ^ a[3]) & 0xFF,
    (a[0] ^ t(1) ^ t(2) ^ a[2] ^ a[3]) & 0xFF,
    (a[0] ^ a[1] ^ t(2) ^ t(3) ^ a[3]) & 0xFF,
    (t(0) ^ a[0] ^ a[1] ^ a[2] ^ t(3)) & 0xFF,
  ];
}

/**
 * 对整个字做列混淆：每 4 字节为一列；不足 4 字节的尾列**零填充**成整列、
 * 算完截回。映射是 GF(2)-线性的，故对任何 ≤32bit 的字都良定义
 * （8bit 字退化成 xtime —— 正是 AES 里 MixColumns 作用在单字节上的形式）。
 *
 * 32bit（= 4 字节）时就是标准 AES MixColumns。分支数 5：
 * `0x00000001 → 0x03010102`（4 个活跃字节）。
 */
export function mixColumnsWord(w, blockBits) {
  const bytes = Math.max(1, Math.floor(blockBits / 8));
  let out = 0;
  for (let base = 0; base < bytes; base += 4) {
    const col = [0, 1, 2, 3].map((k) => {
      const idx = base + k;
      return idx < bytes ? ((w >>> (idx * 8)) & 0xFF) : 0;
    });
    const r = mixColumn4(col);
    for (let k = 0; k < 4; k++) {
      const idx = base + k;
      if (idx < bytes) out |= r[k] << (idx * 8);
    }
  }
  return out >>> 0;
}

/** 基向量结果按位宽缓存（掩码级要用 32 次基映射做线性延拓） */
const mcBasisCache = new Map();
function mcBasis(blockBits) {
  let t = mcBasisCache.get(blockBits);
  if (!t) {
    t = new Array(32).fill(0);
    for (let b = 0; b < Math.min(32, blockBits); b++) {
      t[b] = mixColumnsWord((1 << b) >>> 0, blockBits);
    }
    mcBasisCache.set(blockBits, t);
  }
  return t;
}

/** 掩码级列混淆：同一映射的 GF(2)-线性延拓（逐比特基向量 XOR 叠加） */
export function mixColumnsMask(mask, blockBits) {
  const basis = mcBasis(blockBits);
  const n = Math.min(32, blockBits);
  let o = 0;
  for (let b = 0; b < n; b++) if ((mask >>> b) & 1) o ^= basis[b];
  return o >>> 0;
}

/** 执行线性层节点传播（掩码按同样线性映射作用于比特位置） */
function propagateLinear(node, inMask, blockBits, direction = 1) {
  const op = node.props.op;
  const m = maskOf(blockBits);
  let out = inMask & m;
  switch (op) {
    case 'rotl':
      out = rotl(inMask, node.props.amount | 0, blockBits);
      break;
    case 'rotr':
      out = rotr(inMask, node.props.amount | 0, blockBits);
      break;
    case 'xorShift': {
      // 线性映射 x ^ (x << k) 为可逆的（当 k 合适），掩码按位映射
      const k = node.props.amount | 0;
      out = (inMask ^ ((inMask << k) & m)) & m;
      // 近似逆映射用于掩码传递
      if (direction < 0) {
        let acc = inMask;
        for (let i = 1; i <= 4; i++) {
          const shift = k * (1 << (i - 1));
          if (shift >= blockBits) break;
          acc ^= (acc >>> shift);
        }
        out = acc & m;
      }
      break;
    }
    case 'mixColumns': {
      // 真 GF(2⁸) 列混淆（AES 的 [02 03 01 01] 循环矩阵）。
      // 掩码级 = 值级映射 `mixColumnsWord` 的 GF(2)-线性延拓 —— 两处同源，
      // 不再有「差分分析说一个、真实加密说另一个」的分歧。
      out = mixColumnsMask(inMask, blockBits);
      break;
    }
    case 'bitPerm': {
      const pm = parseInt(node.props.mask || '0', 16) >>> 0;
      if (pm) out = applyBitPermutation(inMask, buildPermFromMask(pm, blockBits), blockBits);
      break;
    }
    default:
      out = inMask & m;
  }
  return { outMask: out >>> 0, prob: 1, note: op };
}

/** 由掩码构造位置换数组 */
function buildPermFromMask(pm, bits) {
  const p = [];
  const used = new Set();
  for (let i = 0; i < bits; i++) {
    const v = (pm >>> i) & 1;
    // 简单位旋转式置换
    p.push((i + (v ? 1 : 0) + bits - 1) % bits);
    used.add(p[i]);
  }
  // 修补重复
  const seen = new Set();
  for (let i = 0; i < bits; i++) {
    if (!seen.has(p[i])) { seen.add(p[i]); continue; }
    for (let j = 0; j < bits; j++) if (!seen.has(j)) { p[i] = j; seen.add(j); break; }
  }
  return p;
}

/* ---- SM4 专有：T 变换传播 (τ 后接 L) ---- */

/** SM4 L 变换：B ⊕ (B<<<2) ⊕ (B<<<10) ⊕ (B<<<18) ⊕ (B<<<24)，32bit */
export function sm4L(B) {
  B = B >>> 0;
  return (B ^ rotl(B, 2, 32) ^ rotl(B, 10, 32) ^ rotl(B, 18, 32) ^ rotl(B, 24, 32)) >>> 0;
}

/** SM4 L′ 变换（密钥扩展）：B ⊕ (B<<<13) ⊕ (B<<<23) */
export function sm4Lp(B) {
  B = B >>> 0;
  return (B ^ rotl(B, 13, 32) ^ rotl(B, 23, 32)) >>> 0;
}

/** L 的逆（掩码反向传播用，L 为可逆线性变换） */
export function sm4Linv(Y) {
  // L = I ⊕ R2 ⊕ R10 ⊕ R18 ⊕ R24 (R 为循环左移)
  // 逆通过逐次逼近求解：Y = B ⊕ B<<<2 ⊕ ... 
  let X = Y >>> 0;
  for (let i = 0; i < 16; i++) {
    const nx = (Y ^ rotl(X, 2, 32) ^ rotl(X, 10, 32) ^ rotl(X, 18, 32) ^ rotl(X, 24, 32)) >>> 0;
    if (nx === X) break;
    X = nx;
  }
  return X >>> 0;
}

/**
 * 计算 SM4 T 变换在给定输入差分下的最优输出差分及概率
 * T = L ∘ τ，其中 τ 为 4 个 SM4 S 盒（字节宽度）并行
 * 关键：L 是可逆线性层，因此输入差分 B 经 L 得输出差分；概率完全由 τ 决定
 */
export function sm4TTransition(inputDiff, mode = MODE.DIFFERENTIAL, opts = {}) {
  const { linearS = false, tauOnly = false, keyExt = false } = opts;
  const lib = globalThis.__SBOX_LIB__;
  const sb = lib ? lib.getSBoxByRef('sm4') : null;

  let prob = 1;
  let activeCount = 0;
  let tauOut = 0;
  let mapWeight = 0;        // 概率映射模型：4 个字节映射熵之和

  for (let i = 0; i < 4; i++) {
    const di = (inputDiff >>> (i * 8)) & 0xFF;
    const shift = i * 8;
    if (di === 0) continue;
    activeCount++;
    if (!linearS && sb) {
      // SM4 S 盒：差分均匀度 4，最大差分概率 4/256 = 2^-6
      const t = bestTransition(sb, mode, di);
      tauOut |= ((t.out & 0xFF) << shift);
      prob *= t.prob;
      mapWeight += mapRowWeight(sb, di, mode);
    } else {
      // 线性化对照实验：S 盒视为恒等，此时差分直通
      tauOut |= (di << shift);
    }
  }
  tauOut >>>= 0;

  let outMask = tauOut;
  if (!tauOnly) {
    outMask = keyExt ? sm4Lp(tauOut) : sm4L(tauOut);
  }
  return {
    outMask: outMask >>> 0, tauMask: tauOut, prob, activeCount, mapWeight,
    note: `SM4 ${keyExt ? "T′" : 'T'}: τ(${activeCount}活跃) → L${tauOnly ? '' : ''}`,
  };
}

/* ============================================================
 * Feistel / 广义 Feistel 迭代差分特征搜索
 * 针对 SM4：状态为 4 个 32bit 字 (X0,X1,X2,X3)
 *   X_{i+4} = X_i ⊕ T(X_{i+1} ⊕ X_{i+2} ⊕ X_{i+3} ⊕ rk_i)
 * 求解器追踪 4 字差分向量的逐轮演化
 * ============================================================ */

/**
 * Feistel 型结构的迭代差分/线性特征搜索
 *
 * 状态为 4 个 32bit 字 (X0,X1,X2,X3)，轮函数：
 *   X_{i+4} = X_i ⊕ T(X_{i+1} ⊕ X_{i+2} ⊕ X_{i+3} ⊕ rk_i)
 *
 * 差分以 4 字向量 (Δa,Δb,Δc,Δd) 表示，逐轮演化：
 *   F 输入差分 = Δb ⊕ Δc ⊕ Δd
 *   新状态     = (Δb, Δc, Δd, Δa ⊕ L(τ(Δb⊕Δc⊕Δd)))
 *
 * 权重 -log2(p) 累加；活跃 S 盒数 = τ 中非零输入字节数
 *
 * @returns {Array<Characteristic>}
 */
export function feistelCharacteristicSearch(opts) {
  const {
    mode = MODE.DIFFERENTIAL, wordBits = 32,
    sboxRef = 'sm4', useLp = false, linearS = false, tauOnly = false,
    onLog = () => {}, maxCandidates = 24, timeBudgetMs = 6000,
    searchDepth = 'greedy',     // greedy | beam | exact
    beamWidth = 6,
    initDiffs = null,
    /* —— 轮数区间 ——
     * 只给 rounds 时等价于「第 1 ~ rounds 轮」，与旧调用完全兼容；
     * 显式给 startRound / endRound 时以区间为准，轮数 = end − start + 1。
     * 第 startRound 轮之前的轮次视为「概率 1」，即特征覆盖区间 [start, end]。 */
    startRound = 1,
    endRound = null,
    rounds: roundsIn = null,
    /* —— 搜索模型 —— */
    model = SEARCH_MODEL.WEIGHT,
    lambda = 0.5,               // 双权优化模型的 λ（J = W + λ·D）
    branchLimit = null,         // 每轮每活跃字节保留的候选输出数
    /* —— 复杂度模型的辅助变量 —— */
    snr = 2,                    // 信噪比：数据复杂度 ≈ snr / p
    guessRounds = 4,            // 密钥恢复需要猜测的轮数（每轮 8 bit）
  } = opts;

  const r0 = Math.max(1, (startRound | 0) || 1);
  const r1 = Math.max(r0, endRound != null ? (endRound | 0)
    : (roundsIn != null ? r0 + ((roundsIn | 0) || 1) - 1 : 32));
  const rounds = r1 - r0 + 1;
  const spec = MODEL_SPEC[model] || MODEL_SPEC.weight;
  const sortKey = spec.objective;
  const bLimit = branchLimit != null ? Math.max(1, branchLimit | 0)
    : (searchDepth === 'exact' ? 6 : searchDepth === 'beam' ? 4 : 1);

  const t0 = performance.now();
  const lib = globalThis.__SBOX_LIB__;
  const sb = lib ? lib.getSBoxByRef(sboxRef) : null;
  if (!sb) { onLog('error', `S 盒 ${sboxRef} 未找到`); return []; }

  const L = useLp ? sm4Lp : sm4L;
  const Lname = useLp ? "L′" : 'L';

  const roundLabel = r0 === 1 ? `${rounds} 轮` : `第 ${r0}~${r1} 轮（跨 ${rounds} 轮）`;
  onLog('info', `Feistel 特征搜索：状态 = 4 × ${wordBits}bit 字 | 轮函数 F = τ(${sb.name}) → ${tauOnly ? '(跳过 L)' : Lname} 后异或 | 轮数 = ${roundLabel}`);
  onLog('info', `搜索模型：${spec.name}（${spec.short}）｜目标函数 ${spec.formula}｜策略 ${searchDepth} beam=${beamWidth} 分支上限=${bLimit}${sortKey === 'dualScore' ? ` λ=${lambda}` : ''}`);
  if (r0 > 1) onLog('info', `轮数区间：第 ${r0} 轮之前视为概率 1（特征只覆盖 [${r0}, ${r1}] 区间）`);
  onLog('debug', `差分演化式：Δ_{i+4} = Δ_i ⊕ ${tauOnly ? 'τ' : 'L(τ)'}(Δ_{i+1} ⊕ Δ_{i+2} ⊕ Δ_{i+3})`);
  if (tauOnly) onLog('warn', '「仅 τ」模式：跳过 L 线性扩散层，单字差分将只在字节内扩散（教学对照用）');
  if (linearS) onLog('warn', '「线性化 S 盒」模式：S 盒视为恒等映射，差分确定性直通（教学对照用）');

  const du = sb.differentialUniformity();
  const li = sb.linearity();
  const corrMax = li.value / (1 << (sb.inBits - 1));
  const pSboxMax = du.value / sb.inSize;
  const wPerActiveSbox = -Math.log2(pSboxMax);

  onLog('debug', `S 盒界：单活跃 S 盒最大差分概率 = ${du.value}/${sb.inSize} = 2^${Math.log2(pSboxMax).toFixed(2)}（即 ${wPerActiveSbox.toFixed(1)} bit 权重）`);
  onLog('debug', `最大线性相关 = ${corrMax} = 2^${Math.log2(corrMax).toFixed(2)}，线性逼近权重 = ${(-Math.log2(corrMax * corrMax)).toFixed(1)} bit/活跃S盒`);
  onLog('debug', `SM4 结构特性：L 变换带来强扩散，单字差分经 τ 后一般激活 3~4 个 S 盒`);

  const results = [];

  /* 概率映射缓存：fIn → { expected, size, maxProb, active }。
   * 映射只取决于 F 输入差分，与选了哪个分支无关，因此每轮每个候选只算一次；
   * 三种模型共用同一份映射，保证 ch.mapWeight 与模型无关、可跨模型对照。 */
  const mapCache = new Map();
  const getMap = (fIn) => {
    let m = mapCache.get(fIn);
    if (!m) { m = tauProbMap(sb, fIn, mode, linearS); mapCache.set(fIn, m); }
    return m;
  };

  // ---- 起点差分 ----
  // 默认起点 = 单字单比特（4 字 × 低 4 比特）+ 「三轮免费」族 Δ=(a,a,a,0)。
  //
  // 为什么要加免费族：SM4 轮函数输入差分为 ΔX₁⊕ΔX₂⊕ΔX₃，
  // 取 Δ=(a,a,a,0) 时第 1~3 轮的 F 输入恒为 0（概率 1、无活跃 S 盒），
  // 第 4 轮才必然出现 ≥1 个活跃 S 盒（可代数证明：欲 4 轮 F 输入全 0 需全零解）。
  // 因此 SM4 的最小活跃盒数 = 0/0/0/1/…（权重 0/0/0/6/…），
  // 与后端 BCA（对**整个输入差分空间**做 SAT 精确求解）的 R1~R4 = 0/0/0/6 完全一致。
  // 只用单字单比特起点会漏掉这条族，把 4 轮权重抬到 44.00（错的上界）。
  const starts = [];
  if (initDiffs && initDiffs.length) {
    for (const d of initDiffs) starts.push(d.slice());
  } else {
    // 单字单比特（其余字为 0）
    for (let w = 0; w < 4; w++) {
      for (let b = 0; b < Math.min(4, wordBits); b++) {
        const v = [0, 0, 0, 0];
        v[w] = 1 << b;
        starts.push(v);
      }
    }
    // 「三轮免费」族 Δ=(a,a,a,0)，a 取遍各比特位（覆盖 4 个字节位置）
    for (let b = 0; b < Math.min(32, wordBits); b++) {
      const a = 1 << b;
      starts.push([a, a, a, 0]);
    }
  }

  for (const start of starts) {
    if (performance.now() - t0 > timeBudgetMs) {
      onLog('warn', `达到时间预算 ${timeBudgetMs}ms，停止（已处理 ${starts.indexOf(start)}/${starts.length} 个起点）`);
      break;
    }

    // 束搜索：每层按【所选模型的目标函数】保留 beamWidth 条最优候选
    let beam = [{
      diffs: start.slice(),
      prob: 1,
      weight: 0,        // Σ −log₂ p（真实特征权重）
      mapWeight: 0,     // Σ 概率映射期望权重
      diffusion: 0,     // Σ hw(Δ)（扩散权重）
      dualScore: 0,     // W + λ·D
      mapSizeLog: 0,    // 累计映射规模 log₁₀(Π 可达差分个数)，取对数避免溢出
      activeSbox: 0,
      tracesteps: [],
    }];

    for (let r = r0; r <= r1; r++) {
      const next = [];
      for (const cand of beam) {
        const [d0, d1, d2, d3] = cand.diffs;
        const fIn = (d1 ^ d2 ^ d3) >>> 0;

        // 全零输入差分 → τ 输出零，该轮概率 1、无活跃 S 盒
        const branches = enumTauBranches(sb, fIn, mode, { limit: bLimit, linearS });

        // 概率映射：该轮 F 输入差分对应的整行映射（字节独立 → 熵可加）
        const map = getMap(fIn);

        for (const br of branches) {
          // tauOnly：跳过 L 线性扩散层，τ 输出直接作为轮函数输出
          const Lout = tauOnly ? (br.tauOut >>> 0) : (L(br.tauOut) >>> 0);
          const d4 = (d0 ^ Lout) >>> 0;
          const newDiffs = [d1, d2, d3, d4];
          const act = br.activeCount;

          const sc = scoreRound({
            prob: br.prob, outMask: d4, activeCount: act,
            model, lambda,
            mapWeight: map.expected,   // 整行熵之和（与所选分支无关）
            mapSize: map.size,
          });

          const step = {
            round: r,                 // 绝对轮号（区间起点不为 1 时也保持真实轮号）
            fIn,
            tauIn: fIn,
            tauOut: br.tauOut,
            Lout,
            activeSboxes: act,
            roundWeight: sc.weight,
            mapWeight: sc.mapWeight,
            diffusion: sc.diffusion,
            mapSize: sc.mapSize,
            branchIdx: br.index,
            diffBefore: cand.diffs.slice(),
            diffAfter: newDiffs.slice(),
            sboxIn: [0, 1, 2, 3].map(i => (fIn >>> (i * 8)) & 0xFF),
            sboxOut: [0, 1, 2, 3].map(i => (br.tauOut >>> (i * 8)) & 0xFF),
            prob: br.prob,
          };

          next.push({
            diffs: newDiffs,
            prob: cand.prob * br.prob,
            weight: cand.weight + sc.weight,
            mapWeight: cand.mapWeight + sc.mapWeight,
            diffusion: cand.diffusion + sc.diffusion,
            dualScore: cand.dualScore + sc.weight + lambda * sc.diffusion,
            mapSizeLog: cand.mapSizeLog + Math.log10(Math.max(1, sc.mapSize)),
            activeSbox: cand.activeSbox + act,
            tracesteps: cand.tracesteps.concat([step]),
          });
        }
      }
      // 排序键由模型决定：weight / mapWeight / dualScore，升序 = 越优
      next.sort((a, b) => (a[sortKey] - b[sortKey]) || (b.prob - a.prob));
      beam = next.slice(0, Math.max(1, beamWidth));
      if (!beam.length) break;
    }

    // 汇总该起点在各轮的最优特征
    for (const cand of beam) {
      const ch = new Characteristic(mode);
      ch.inputMask = (start[0] >>> 0);
      ch.inputState = start.slice();
      ch.outputMask = cand.diffs[3] >>> 0;
      ch.outputState = cand.diffs.slice();
      ch.rounds = rounds;
      ch.startRound = r0;
      ch.endRound = r1;
      ch.prob = cand.prob;
      ch.activeSboxes = cand.activeSbox;
      // 先挂上逐轮步骤，再 finalize/sync —— 保证汇总值与逐轮数据自洽
      ch.feistelSteps = cand.tracesteps;
      ch.feistelState = cand.diffs;
      ch.finalize();
      ch.syncFromSteps();       // 以逐轮数据为准回填（活跃 S 盒 / 权重）
      ch.bitsPerRound = ch.weight / rounds;
      ch.sboxRef = sboxRef;
      ch.useLp = useLp;
      ch.model = spec.id;
      ch.modelName = spec.name;
      // 模型附加量（由模型自己累加，供界面展示与模型间对照）
      ch.mapWeight = cand.mapWeight;
      ch.diffusionWeight = cand.diffusion;
      ch.dualScore = cand.dualScore;
      ch.mapSizeLog10 = cand.mapSizeLog;
      // 映射规模 = Π 各轮可达差分个数，量级可达 10^269，因此以对数形式报告
      ch.mapSize = cand.mapSizeLog <= 15 ? Math.round(Math.pow(10, cand.mapSizeLog)) : null;
      ch.lambda = lambda;
      applyFeistelComplexity(ch, mode, rounds, wordBits, { snr, guessRounds });
      results.push(ch);
    }
  }

  const uniq = [];
  const seen = new Set();
  // 候选表同样按模型目标排序（而非一律按 weight），否则「换了模型却看不到差别」
  for (const c of results.sort((a, b) => (a[sortKey] - b[sortKey]) || (a.weight - b.weight))) {
    const key = `${c.inputState.join(',')}:${c.outputState.join(',')}:${c.weight.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
    if (uniq.length >= maxCandidates) break;
  }

  if (uniq.length) {
    const b = uniq[0];
    onLog('success', `搜索完成：${uniq.length} 条候选 | 模型=${spec.name} | 区间=[${r0}, ${r1}] | 最优 Δin=(${b.inputState.map(v => '0x' + v.toString(16)).join(',')}) → Δout=(${b.outputState.map(v => '0x' + v.toString(16)).join(',')})`);
    onLog('info', `最优特征：-log2(p) = ${b.weight.toFixed(2)} | 概率 = 2^${b.probLog2.toFixed(2)} | 活跃 S 盒累计 = ${b.activeSboxes} | 平均 ${(b.weight / rounds).toFixed(2)} bit/轮`);
    onLog('debug', `模型量：映射期望权重 E[w] = ${b.mapWeight.toFixed(2)} | 扩散权重 D = ${b.diffusionWeight} bit | 映射规模 ≈ 10^${b.mapSizeLog10.toFixed(1)}${sortKey === 'dualScore' ? ` | J = ${b.dualScore.toFixed(2)}（λ=${lambda}）` : ''}`);
  }
  return uniq;
}

/**
 * Feistel 特征的复杂度模型
 * 数据复杂度 ≈ snr / p；密钥猜测量 = 8 × guessRounds bit（SM4 常用右 4 轮 ≈ 32 bit）
 */
function applyFeistelComplexity(ch, mode, rounds, wordBits = 32, opts = {}) {
  const { snr = 2, guessRounds = 4 } = opts;
  ch.snr = snr;
  ch.guessRounds = guessRounds;
  ch.dataComplexity = Math.ceil(snr / Math.max(ch.prob, Number.MIN_VALUE));
  const guessBits = Math.max(0, guessRounds | 0) * 8;
  ch.keyGuesses = guessBits;
  ch.timeComplexity = Math.pow(2, guessBits) * ch.dataComplexity;
  ch.memoryComplexity = Math.pow(2, Math.min(guessBits, 20));
  ch.effectiveRounds = rounds;
  return ch;
}

/** 枚举 τ 的候选输出（按概率降序） */
function enumTauBranches(sb, inputDiff, mode, opts = {}) {
  const { limit = 1, linearS = false } = opts;
  const outs = [];
  const activeBytes = [];
  for (let i = 0; i < 4; i++) {
    const b = (inputDiff >>> (i * 8)) & 0xFF;
    activeBytes.push({ idx: i, byte: b, active: b !== 0 });
  }
  const active = activeBytes.filter(x => x.active);
  if (active.length === 0) {
    return [{ tauOut: 0, prob: 1, activeCount: 0, index: 0 }];
  }

  // 对每个活跃字节求候选输出，做笛卡尔积（受 limit 约束）
  const perByte = active.map(ab => {
    if (linearS) return [{ out: ab.byte, prob: 1 }];
    if (mode === MODE.DIFFERENTIAL) {
      const ddt = sb.getDDT();
      const row = ddt[ab.byte];
      const cands = [];
      for (let o = 1; o < sb.outSize; o++) {
        if (row[o] > 0) cands.push({ out: o, prob: row[o] / sb.inSize });
      }
      cands.sort((x, y) => y.prob - x.prob);
      return cands.slice(0, Math.max(1, limit));
    } else {
      const lat = sb.getLAT();
      const row = lat[ab.byte];
      const half = 1 << (sb.inBits - 1);
      const cands = [];
      for (let o = 1; o < sb.outSize; o++) {
        if (row[o] !== 0) {
          const cr = row[o] / half;
          cands.push({ out: o, prob: cr * cr, corr: cr });
        }
      }
      cands.sort((x, y) => y.prob - x.prob);
      return cands.slice(0, Math.max(1, limit));
    }
  });

  /* 组合：对「每字节候选」做笛卡尔积，只保留概率最高的 limit 条完整组合。
   *
   * ⚠️ 这里曾经是「拼一层、`if (combos.length > 256) break;`」——
   *    候选数乘积一旦超过 256 就直接 break，**把后面还没展开的活跃字节整块丢掉**，
   *    于是 τout 里那些字节恒为 0。而对非零输入差分，`DDT[Δ≠0][0] ≡ 0`
   *    （S 盒是双射：S(x)⊕S(x⊕Δ)=0 ⇔ Δ=0），所以这种分支的概率实为 **0**。
   *    症状：把界面的「分支上限」调大（范围 0~64），反而报出**物理上不可达、
   *    而且更小（看着更优）**的权重 —— 像是"搜得更深找到了更好的特征"，
   *    实为丢字节。阈值实测：4 个活跃字节时 limit ≥ 7 即触发
   *    （3 层前缀 7³ = 343 > 256）。见 tests/verify-accuracy.mjs【D】。
   *
   * 正确做法：逐字节只保留**概率最高的 limit 条前缀**，不做 break。
   *    该截断对「全体候选里概率最高的 limit 条完整组合」是**精确**的：
   *    若某前缀之前已有 limit 条不劣于它的前缀，则它派生的任一完整组合，
   *    也必有 limit 条不劣于它（同后缀）的组合 ⇒ 它不可能进入 top-limit。
   *    故按 limit 截断前缀不会丢掉最优解，且规模恒为 O(limit)。
   */
  const cap = Math.max(1, limit);
  let combos = [{ assigns: [], prob: 1 }];
  for (let i = 0; i < active.length; i++) {
    const nxt = [];
    for (const c of combos) {
      for (const cand of perByte[i]) {
        nxt.push({ assigns: c.assigns.concat([{ idx: active[i].idx, out: cand.out }]), prob: c.prob * cand.prob });
      }
    }
    nxt.sort((x, y) => y.prob - x.prob);
    combos = nxt.slice(0, cap);
  }

  for (const c of combos) {
    let tauOut = 0, prob = c.prob, impossible = false;
    for (const a of c.assigns) {
      // 防御断言：活跃字节的输出绝不允许为 0 —— 0 输出的分支概率恒为 0，
      // 一旦出现就说明组合被截断了（本函数的历史缺陷），宁可不输出也不报假特征。
      if (a.out === 0) { impossible = true; break; }
      tauOut |= ((a.out & 0xFF) << (a.idx * 8));
    }
    if (impossible) continue;
    if (prob <= 0) continue;
    outs.push({ tauOut: tauOut >>> 0, prob, activeCount: active.length, index: outs.length });
  }
  outs.sort((a, b) => b.prob - a.prob);
  return outs.slice(0, cap);
}

/** 生成 SM4 逐轮特征表（用于 UI 图表与日志） */
export function sm4RoundProfile(opts = {}) {
  const { mode = MODE.DIFFERENTIAL, startRound = 1, endRound = null, rounds: roundsIn = 32, ...rest } = opts;
  const r0 = Math.max(1, (startRound | 0) || 1);
  const r1 = Math.max(r0, endRound != null ? (endRound | 0) : r0 + (Math.max(1, roundsIn | 0) - 1));
  const chars = feistelCharacteristicSearch({
    mode, startRound: r0, endRound: r1, ...rest,
  });
  if (!chars.length) return { perRound: [], chars };
  const best = chars[0];
  const perRound = [];
  let acc = 1;
  for (let r = r0; r <= r1; r++) {
    const st = best.feistelSteps?.[r - r0];
    if (st) acc *= st.prob;
    perRound.push({
      round: r,
      prob: acc,
      log2p: acc > 0 ? Math.log2(acc) : -Infinity,
      weight: acc > 0 ? -Math.log2(acc) : Infinity,
      activeSboxes: st ? (st.activeSboxes || 0) : 0,
      roundWeight: st ? (st.roundWeight || 0) : 0,
      tauOut: st ? st.tauOut : 0,
      Lout: st ? st.Lout : 0,
      state: st ? st.diffAfter : [0, 0, 0, 0],
      inputDiff: st ? st.fIn : 0,
    });
  }
  let cum = 0;
  for (const pr of perRound) { cum += pr.activeSboxes; pr.cumActive = cum; }
  return { perRound, chars, best };
}

/* ============================================================
 * 通用 Feistel 分支迭代 —— 真正遍历**用户自己搭的图**
 * ============================================================ */

/**
 * 判断从 (nodeId, portId) 这个输出端口出发，能不能走到非线性节点。
 * 用来在图里认出「哪条支路是轮函数 F」——即该进 S 盒的那一支。
 */
function portFeedsNonlinear(graph, nodeId, portId) {
  const seen = new Set();
  const stack = [];
  for (const e of graph.outEdges(nodeId)) {
    if (e.fromPort === portId) stack.push(e.to);
  }
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = graph.getNode(id);
    if (!n) continue;
    if (n.type === 'SBOX' || n.type === 'TTRANS') return true;
    for (const e of graph.outEdges(id)) stack.push(e.to);
  }
  return false;
}

/**
 * 对**用户自己搭的 Feistel 图**做迭代差分 / 线性特征搜索。
 *
 * 与 `sm4RoundProfile()` 的根本区别：那个是 **SM4 专用**引擎 ——
 * 状态写死为 4 × 32bit 字、轮函数写死为 L∘τ，**完全不看图**。
 * 本函数把图当成真正的轮函数，按两条分支迭代：
 *
 *   · 图上取一个 SPLIT 节点 = 状态分割点，它的两个输出端口就是左右两半；
 *   · 一轮 = 把 (L, R) 直接注入这两个端口，沿图传播到 OUTPUT；
 *       - 进入非线性那一支的是 R（= 轮函数 F 的输入），
 *       - OUTPUT 上的掩码 A = L ⊕ F(R)；
 *   · 交换：L ← R，R ← A。
 *
 * 于是「分割 — 分支 — 交叉」在传播层是真的：右半才进 F、结果与左半异或、
 * 然后交换；而不是把整个字或起来再或一遍。
 *
 * 为什么不像 SPLIT 节点自己的位切分那样直接塞 64bit？
 * 因为 JS 位运算只有 32 位，一个 64bit 分组塞不进一个词。改成
 * 「迭代引擎拥有状态分割权、把两半分别注入端口」，任何位宽都成立。
 *
 * 要求图里同时有 INPUT / SPLIT / OUTPUT；缺任何一个就返回带 `reason`
 * 的空结果，调用方据此回退到通用传播。
 */
export function feistelGraphProfile(graph, opts = {}) {
  const {
    mode = MODE.DIFFERENTIAL,
    blockBits = 32,
    startRound = 1,
    endRound = null,
    rounds: roundsIn = 16,
    model = SEARCH_MODEL.WEIGHT,
    lambda = 0.5,
    snr = 2,
    onLog = () => {},
    initDiffs = null,   // 界面「起始差分 / 掩码」（四字向量数组）
  } = opts;

  const spec = MODEL_SPEC[model] || MODEL_SPEC.weight;
  const r0 = Math.max(1, (startRound | 0) || 1);
  const r1 = Math.max(r0, endRound != null ? (endRound | 0) : r0 + (Math.max(1, roundsIn | 0) - 1));
  const totalRounds = r1 - r0 + 1;

  const inputNode = graph?.nodes?.find((n) => n.type === 'INPUT');
  const splitNode = graph?.nodes?.find((n) => n.type === 'SPLIT');
  const outNode = graph?.nodes?.find((n) => n.type === 'OUTPUT');
  if (!inputNode || !outNode) {
    return { perRound: [], chars: [], best: null, reason: '图里缺少「输入明文」或「输出密文」节点' };
  }
  if (!splitNode) {
    return {
      perRound: [], chars: [], best: null,
      reason: 'Feistel 结构需要「分支/分块」节点把状态切成左右两半',
    };
  }

  const wordBits = Math.max(1, Math.min(32, blockBits || 32));
  const branchBits = Math.max(1, Math.min(32, (splitNode.props?.splitBits | 0) || wordBits));

  // 认出哪条支路进 F：进非线性那一支是 R，另一支是 L
  const feedsA = portFeedsNonlinear(graph, splitNode.id, 'a');
  const feedsB = portFeedsNonlinear(graph, splitNode.id, 'b');
  const fPort = (feedsB || !feedsA) ? 'b' : 'a';
  const lPort = fPort === 'b' ? 'a' : 'b';

  const order = graph.topoOrder();
  const sboxCount = graph.nodes.filter((n) => n.type === 'SBOX' || n.type === 'TTRANS').length;

  onLog('info', `Feistel 图迭代：状态 = 2 × ${branchBits}bit 分支（A←左半 / B←右半）｜`
    + `轮函数 F 沿图传播（${graph.nodes.length} 节点 / ${graph.dataEdges().length} 数据连线）｜第 ${r0}~${r1} 轮`);
  if (fPort === 'a') {
    onLog('warn', '这张图把左半（端口 A）接进了非线性支路 —— 已按「进 F 的那一支算右半」处理');
  }
  if (sboxCount === 0) {
    onLog('warn', '图里没有任何 S 盒 / T 变换节点 —— 轮函数是纯线性的，权重必然为 0');
  }

  // 起点：单比特差分置于右半，左半为 0（经典 Feistel 起点）。
  // 用户在「起始差分 / 掩码」里显式给了起点时优先 —— 通用图路径从前一律忽略它。
  const explicit = pickExplicitInit(initDiffs, branchBits);
  if (explicit && explicit.mask === 0) {
    return { perRound: [], chars: [], best: null, reason: '「起始差分」为全零，无法构成特征' };
  }
  if (explicit) {
    onLog('info', `起始差分：用户指定 R=0x${explicit.mask.toString(16)}、L=0`
      + `${explicit.extra ? `（其余 ${explicit.extra} 个非零字被忽略）` : ''}`);
  }
  const R0 = explicit ? explicit.mask : 1;
  let L = 0;
  let R = R0;
  let cumProb = 1;
  let cumActive = 0;
  let cumMapWeight = 0;
  let cumDiffusion = 0;

  const perRound = [];
  const allSteps = [];

  for (let r = r0; r <= r1; r++) {
    const state = new Map();
    // ★ 状态直接注入 SPLIT 的两个端口 —— 这就是「分割-分支」语义
    state.set(splitNode.id + '|' + lPort, L >>> 0);
    state.set(splitNode.id + '|' + fPort, R >>> 0);
    state.set(splitNode.id, (L | R) >>> 0);      // 供不区分端口的消费者兜底
    state.set(inputNode.id, (L | R) >>> 0);      // 直接挂在 INPUT 上的支路也拿得到状态

    const body = propagateGraphOnce({
      graph, order, state, mode, blockBits: wordBits, round: r,
      skip: new Set([splitNode.id]),
    });

    const A = (state.get(outNode.id) ?? 0) >>> 0;                 // = L ⊕ F(R)
    const Rin = (state.get(splitNode.id + '|' + fPort) ?? R) >>> 0;
    const rw = -Math.log2(Math.max(body.prob, Number.MIN_VALUE));

    cumProb *= body.prob;
    cumActive += body.activeSboxTotal;
    cumMapWeight += body.mapWeight;
    cumDiffusion += hwN(A, wordBits);
    allSteps.push(...body.steps);

    perRound.push({
      round: r,
      prob: body.prob,          // ← 本轮概率（normalizePerRound / syncFromSteps 认这个字段）
      cumProb,
      roundWeight: rw,
      weight: cumProb > 0 ? -Math.log2(cumProb) : Infinity,
      log2p: cumProb > 0 ? Math.log2(cumProb) : -Infinity,
      activeSboxes: body.activeSboxTotal,
      cumActive,
      currActive: body.activeSboxTotal,
      inputMask: Rin,
      outputMask: A,
      // ⚠️ `state` 是「本轮**结束**」的状态：逐轮表的列名就叫「输出状态」，
      //    SPN 路径塞的也是轮末状态（`st.diffAfter`）。从前这里塞的是轮**首**状态，
      //    同一列两种语义，且最后一行对不上特征的输出差分。轮首状态留在 stateIn。
      state: [Rin, A],
      stateIn: [L >>> 0, R >>> 0],
      mapWeight: cumMapWeight,
      roundMapWeight: body.mapWeight,
      diffusion: cumDiffusion,
    });

    onLog('debug', `第 ${r} 轮：L=0x${(L >>> 0).toString(16)} R=0x${(R >>> 0).toString(16)}`
      + ` → F(R) 激活 ${body.activeSboxTotal} 个 S 盒 → A=L⊕F(R)=0x${A.toString(16)}`
      + ` ｜累计 -log₂p=${(cumProb > 0 ? -Math.log2(cumProb) : Infinity).toFixed(3)}`);

    // 交换：新左半 = 旧右半，新右半 = 轮输出
    L = Rin;
    R = A;
  }

  const ch = new Characteristic(mode);
  ch.steps = allSteps;
  ch.feistelSteps = perRound;
  ch.inputState = [0, R0 >>> 0];
  ch.outputState = [L >>> 0, R >>> 0];
  ch.inputMask = R0 >>> 0;
  ch.outputMask = R >>> 0;
  ch.rounds = totalRounds;
  ch.startRound = r0;
  ch.endRound = r1;
  ch.prob = cumProb;
  ch.activeSboxes = cumActive;
  ch.nodesCovered = allSteps.length;
  ch.branchCount = 0;
  ch.finalize();
  ch.model = spec.id;
  ch.modelName = spec.name;
  ch.mapWeight = cumMapWeight;
  ch.diffusionWeight = cumDiffusion;
  ch.dualScore = ch.weight + lambda * cumDiffusion;
  ch.lambda = lambda;
  ch.bitsPerRound = ch.weight / Math.max(totalRounds, 1);
  applyComplexityModel(ch, mode, totalRounds, wordBits, sboxCount, { snr });

  onLog('success', `Feistel 图迭代完成：−log₂p = ${ch.weight.toFixed(2)} ｜活跃 S 盒累计 = ${cumActive}`
    + ` ｜平均 ${ch.bitsPerRound.toFixed(2)} bit/轮`);

  return { perRound, chars: [ch], best: ch };
}

/** 置换节点（PERM）掩码传播 */
function propagatePerm(node, inMask, blockBits) {
  let out = inMask >>> 0;
  const shift = node.props.shift | 0;
  if (shift) {
    const bytes = Math.max(1, Math.floor(blockBits / 8));
    const s = shift % bytes;
    let o = 0;
    for (let i = 0; i < bytes; i++) {
      const src = (i - s + bytes * 2) % bytes;
      const b = (inMask >>> (src * 8)) & 0xFF;
      o |= (b << (i * 8));
    }
    out = o & maskOf(blockBits);
  }
  if (node.props.reverse) {
    const m = maskOf(blockBits);
    out = reverseBits(out & m, blockBits);
  }
  return { outMask: out >>> 0, prob: 1 };
}

function reverseBits(x, bits) {
  let r = 0;
  for (let i = 0; i < bits; i++) if ((x >>> i) & 1) r |= (1 << (bits - 1 - i));
  return r >>> 0;
}

/* ============================================================
 * 图传播内核（analyze 与 feistelGraphProfile 共用）
 * ============================================================ */

/**
 * 取「某节点的某个输出端口」上的掩码。
 *
 * 多输出节点（SPLIT）把每个分支写进 `state['节点|端口']`；
 * 单输出节点只写 `state[节点]`。这里先查端口槽、再退回整节点掩码 ——
 * 于是「不区分端口的老图」与「分支/交叉的新图」都能取到正确的值。
 *
 * ⚠️ 修复的是一个真实缺陷：从前取输入掩码写的是
 *    `inMask |= state.get(e.from)`，**端口完全不参与**，
 *    于是 SPLIT 写下的 `|a` / `|b` 两个槽只写不读（全项目无消费者），
 *    「右半进 F、与左半异或」在传播层退化成「整个字过一遍再或回来」。
 */
function outMaskAt(state, nodeId, portId) {
  if (portId) {
    const v = state.get(`${nodeId}|${portId}`);
    if (v !== undefined) return v >>> 0;
  }
  return (state.get(nodeId) ?? 0) >>> 0;
}

/**
 * 模加（ADD）节点的差分 / 线性传播 —— 走 `addmodel.js` 的精确进位链模型。
 *
 * ⚠️ 这里替换的是一段**静默给错值**的旧行为：从前 `合并(op=add)` 只做
 * 「输入掩码并集」且 `prob` 恒为 1，于是 ARX（加法是唯一非线性源）会拿到
 * `prob=1 / weight=0` 的假结论 —— 实测单轮真实概率已是 2^-2 量级（α=1 时
 * 144 种输出差），与「概率 1」差十个数量级。
 *
 * ADD 与 XOR 的本质区别：XOR 是「一进一出」（Δx⊕Δy 唯一决定 Δz），
 * ADD 是「一进多出」（(α,β) 对应一族可能的 γ）。所以这里取**最可能**的 γ，
 * 并把分支数与「候选集是否精确」一并带回，供上层如实标注口径。
 *
 * @returns {{outMask:number, prob:number, note:string, addCandidates:number,
 *            addExact:boolean, addTop:Array}}
 */
function propagateAdd(a, b, mode, blockBits) {
  const A = a >>> 0, B = b >>> 0;
  if (mode === MODE.LINEAR) {
    const top = addLinTopK(blockBits, A, B, 8);
    const best = top[0] || { gamma: 0, corr: 0, prob: 0 };
    const corrTxt = best.corr ? `corr=${best.corr > 0 ? '' : '-'}2^-${(-Math.log2(Math.abs(best.corr))).toFixed(2)}` : 'corr=0';
    return {
      outMask: best.gamma >>> 0,
      prob: best.prob,
      note: `模加 ADD（精确线性）· ${top.length} 个候选，取 |corr| 最大 γ=0x${(best.gamma >>> 0).toString(16)} ${corrTxt}`
        + (top.exact ? '' : '｜候选集为启发式，未必全局最优'),
      addCandidates: top.length,
      addExact: !!top.exact,
      addTop: top,
    };
  }
  const top = addDiffTopK(blockBits, A, B, 8);
  const best = top[0] || { gamma: 0, prob: 0, weight: Infinity };
  const wTxt = Number.isFinite(best.weight) ? `p=2^-${best.weight.toFixed(2)}` : 'p=0';
  return {
    outMask: best.gamma >>> 0,
    prob: best.prob,
    note: `模加 ADD（精确差分）· ${top.length} 个候选差，取最可能 γ=0x${(best.gamma >>> 0).toString(16)} ${wTxt}`
      + (top.exact ? '' : '｜候选集为启发式，未必全局最优'),
    addCandidates: top.length,
    addExact: !!top.exact,
    addTop: top,
  };
}

/**
 * 沿图执行一次完整传播（= 一轮）。
 *
 * 抽成独立函数的原因：`analyze()`（单趟 / SPN 迭代）与
 * `feistelGraphProfile()`（分支状态迭代）必须用**完全相同**的节点语义，
 * 否则两条路径会各自漂移 —— 历史上 SPN 与 Feistel 就是各算各的。
 *
 * @returns {{steps: Array, prob: number, activeSboxTotal: number, mapWeight: number}}
 */
function propagateGraphOnce({ graph, order, state, mode, blockBits, round, skip = null }) {
  const steps = [];
  let prob = 1;
  let activeSboxTotal = 0;
  let roundMapWeight = 0;

  for (const node of order) {
    if (node.type === 'INPUT' || node.type === 'ROUND') continue; // 容器 / 入口不承载数据流
    if (skip && skip.has(node.id)) continue; // 由迭代引擎直接注入的节点（如 Feistel 的 SPLIT）

    const inEdges = graph.inEdges(node.id);
    if (inEdges.length === 0) continue;

    // ★ 端口感知：按**来源端口**取掩码，而不是把来源节点的整个输出或进来
    const ins = inEdges.map((e) => outMaskAt(state, e.from, e.fromPort));

    // ⚠️ 合并节点的语义由它**自己声明**（`合并运算`：xor / add / and）。
    //    差分域里 XOR 是唯一的线性运算，必须真的按位异或：
    //      A = L ⊕ F(R)  与  A = L | F(R)
    //    在第 3 轮起就分道扬镳 —— 或运算会把「被异或抵消掉的差位」继续留在状态里，
    //    于是后续轮次凭空多出活跃 S 盒（实测：双鱼图 8 轮被抬成 84 bit/14 个，
    //    真值 66 bit/11 个）。
    //    `add` / `and` 在差分域没有精确映射，保守地按「并集」处理（进位上窜 / 位依赖）。
    //    其余节点（多入线）仍按「拼接」语义取并集。
    let inMask;
    if (node.type === 'MERGE' && (node.props.op || 'xor') === 'xor') {
      inMask = ins.reduce((a, v) => (a ^ v) >>> 0, 0);
    } else {
      inMask = ins.reduce((a, v) => (a | v) >>> 0, 0);
    }

    let res;
    switch (node.type) {
      case 'TTRANS':
        res = sm4TTransition(inMask, mode, {
          linearS: !!node.props.linearS,
          tauOnly: !!node.props.tauOnly,
          keyExt: !!node.props.keyExt,
        });
        break;
      case 'SBOX':
        res = propagateSBox(node, inMask, mode, blockBits);
        break;
      case 'LINEAR':
        res = propagateLinear(node, inMask, blockBits, 1);
        break;
      case 'PERM':
        res = propagatePerm(node, inMask, blockBits);
        break;
      case 'XORKEY':
        // 密钥加对差分/线性传播无影响（独立轮密钥假设）
        res = { outMask: inMask, prob: 1, note: '密钥加（无贡献）' };
        break;
      case 'SPLIT': {
        // ⚠️ `>>> 32` 在 JS 里等价于「不移位」（移位量按 32 取模），
        //    因此 splitBits 必须夹到 31 以内；= 32 时 B 支路按空处理。
        const sb = Math.max(1, Math.min(32, node.props.splitBits | 0 || blockBits));
        const a = (inMask & maskOf(sb)) >>> 0;
        const b = sb >= 32 ? 0 : ((inMask >>> sb) & maskOf(Math.max(0, blockBits - sb))) >>> 0;
        state.set(node.id + '|a', a);
        state.set(node.id + '|b', b);
        res = { outMask: (a | b) >>> 0, prob: 1, note: `分块 A=${sb}bit` };
        break;
      }
      case 'MERGE': {
        const op = node.props.op || 'xor';
        // ★ 模加：走精确进位链模型（不再是「并集 + 概率 1」的假值）
        if (op === 'add' && ins.length >= 2) {
          res = propagateAdd(ins[0], ins[1], mode, blockBits);
        } else {
          res = { outMask: inMask, prob: 1, note: `合并(${op})` };
        }
        break;
      }
      case 'QUARTER_ROUND': {
        /* ★ 复合函数节点：内部 4 步（2×ADD + 2×ROT + 2×ROT）就地展开。
         * 两次 ADD 走精确进位链模型，ROTL/⊕ 是线性运算 → 掩码级精确。
         * 这是「一次定义、图上单节点」的复用机制，替代把 4 步平铺成 8 个节点。 */
        const r1 = clampShift(node.props.r1, 16), r2 = clampShift(node.props.r2, 12);
        const r3 = clampShift(node.props.r3, 8), r4 = clampShift(node.props.r4, 7);
        const pv = (pid) => {
          const e = inEdges.find((x) => x.toPort === pid);
          return e ? outMaskAt(state, e.from, e.fromPort) : 0;
        };
        let qa = pv('a'), qb = pv('b'), qc = pv('c'), qd = pv('d');
        let qProb = 1, qExact = true, qCand = 0;
        const qNotes = [];
        const addStep = (x, y, tag) => {
          const top = mode === MODE.LINEAR
            ? addLinTopK(blockBits, x, y, 8)
            : addDiffTopK(blockBits, x, y, 8);
          const best = top[0] || { gamma: 0, prob: 0, weight: Infinity };
          qProb *= best.prob;
          qExact = qExact && !!top.exact;
          qCand = Math.max(qCand, top.length);
          const w = mode === MODE.LINEAR
            ? (best.prob > 0 ? -Math.log2(best.prob) : Infinity)
            : best.weight;
          qNotes.push(`${tag} −log₂p=${Number.isFinite(w) ? w.toFixed(2) : '∞'}`);
          return best.gamma >>> 0;
        };
        qa = addStep(qa, qb, 'A+=B');
        qd = rotl((qd ^ qa) >>> 0, r1, blockBits);
        qc = addStep(qc, qd, 'C+=D');
        qb = rotl((qb ^ qc) >>> 0, r2, blockBits);
        qa = addStep(qa, qb, 'A+=B');
        qd = rotl((qd ^ qa) >>> 0, r3, blockBits);
        qc = addStep(qc, qd, 'C+=D');
        qb = rotl((qb ^ qc) >>> 0, r4, blockBits);
        state.set(`${node.id}|a`, qa >>> 0); state.set(`${node.id}|b`, qb >>> 0);
        state.set(`${node.id}|c`, qc >>> 0); state.set(`${node.id}|d`, qd >>> 0);
        res = {
          outMask: (qa | qb | qc | qd) >>> 0,
          prob: qProb,
          note: `ARX 四分之一轮（复合函数，2 次 ADD 走精确模型）· ${qNotes.join('，')}`
            + (qExact ? '' : '｜候选集为启发式'),
          activeCount: 0,          // ARX 无 S 盒；非线性由 ADD 承担，权重记在 prob 里
          addCandidates: qCand,
          addExact: qExact,
        };
        break;
      }
      case 'OUTPUT': {
        const ports = node.inputs;
        if (ports.length > 1) {
          for (const p of ports) {
            const e = inEdges.find((x) => x.toPort === p.id);
            state.set(`${node.id}|${p.id}`, e ? outMaskAt(state, e.from, e.fromPort) : 0);
          }
          res = { outMask: ins.reduce((a, x) => (a | x) >>> 0, 0), prob: 1, note: '输出汇聚（多字）' };
        } else {
          res = { outMask: inMask, prob: 1, note: '输出汇聚' };
        }
        break;
      }
      default:
        res = { outMask: inMask, prob: 1 };
    }

    state.set(node.id, res.outMask);
    prob *= (res.prob ?? 1);
    activeSboxTotal += res.activeCount || 0;

    const step = new TraceStep(node, round, mode, inMask, res.outMask, {
      prob: res.prob, note: res.note, unsupported: res.unsupported,
    });
    step.activeCount = res.activeCount || 0;
    step.mapWeight = res.mapWeight || 0;
    if (res.addCandidates != null) {
      step.addCandidates = res.addCandidates;
      step.addExact = res.addExact;
    }
    roundMapWeight += step.mapWeight;
    if (mode === MODE.LINEAR) {
      step.corr = Math.sqrt(Math.max(res.prob ?? 1, 0));
    }
    steps.push(step);
  }

  return { steps, prob, activeSboxTotal, mapWeight: roundMapWeight };
}

/* ============================================================
 * 主入口：对整个图执行传播，生成特征与逐轮统计
 * ============================================================ */

/**
 * @param {CipherGraph} graph
 * @param {object} opts
 *   mode: 'differential' | 'linear'
 *   rounds: 分析轮数
 *   blockBits: 参与运算的位宽
 *   onLog: (level, msg, data) => void
 *   searchMode: 'greedy' | 'bb' (分支限界) | 'exhaustive'
 *   maxCandidates: 分支限界剪枝阈值
 */
export function analyze(graph, opts = {}) {
  const {
    mode = MODE.DIFFERENTIAL,
    rounds = 16,
    blockBits = 32,
    onLog = () => {},
    searchMode = 'bb',
    maxCandidates = 12,
    timeBudgetMs = 8000,
    /* —— 轮数区间：第 startRound 轮之前视为概率 1 —— */
    startRound = 1,
    endRound = null,
    /* —— 搜索模型（决定计分口径与最优特征取舍） —— */
    model = SEARCH_MODEL.WEIGHT,
    lambda = 0.5,
    /* —— 复杂度模型辅助变量 —— */
    snr = 2,
    keyBitsPerSbox = 4,
    /* —— 界面「起始差分 / 掩码」：四字向量的数组（见 params.js parseInitDiffs）——
     * 从前只有 Feistel 迭代引擎读它，通用图路径把输入框当摆设（填了不生效）。 */
    initDiffs = null,
  } = opts;

  const spec = MODEL_SPEC[model] || MODEL_SPEC.weight;
  const sortKey = spec.objective;
  const r0 = Math.max(1, (startRound | 0) || 1);

  const t0 = performance.now();
  const log = (level, msg, data) => onLog(level, msg, data);

  log('info', `初始化分析引擎 | 模式=${mode === MODE.DIFFERENTIAL ? '差分' : '线性'} | 轮数=${rounds} | 位宽=${blockBits}`);
  log('info', `搜索模型=${spec.name}（${spec.formula}）｜区间起点=第 ${r0} 轮${endRound != null ? `｜区间终点=第 ${endRound} 轮` : ''}`);
  log('info', `图结构：${graph.nodes.length} 节点 / ${graph.edges.length} 连接 | 算法：${graph.meta.name}`);

  const issues = graph.validate();
  for (const it of issues) log(it.level === 'error' ? 'error' : 'warn', `[校验] ${it.msg}`);
  if (issues.some(i => i.level === 'error')) {
    log('error', '图结构存在致命错误，分析中止');
    return { ok: false, issues, characteristics: [], candidates: [], perRound: [], best: null, elapsedMs: 0 };
  }

  // 统计 S 盒使用情况
  const sboxNodes = graph.nodes.filter(n => n.type === 'SBOX');
  log('info', `检测到 ${sboxNodes.length} 个非线性（S 盒）节点`);
  const lib = globalThis.__SBOX_LIB__;
  for (const n of sboxNodes) {
    const sb = lib.getSBoxByRef(n.props.sboxId);
    if (!sb) continue;
    // ★ 大盒（16bit 等）的 DDT/LAT 全表建不起来（上限见 sbox.js 的 SBOX_TABLE_CAP）——
    //   不能在这里崩，如实说明「指标不可用、差分侧按需单行仍精确」。
    if (!sb.fullTableFeasible()) {
      log('warn', `S盒「${sb.name}」(${sb.inBits}→${sb.outBits}) 过大，DDT/LAT 全表不建：`
        + '差分侧按需单行计算（仍精确），四项指标与线性侧不可用');
      continue;
    }
    const du = sb.differentialUniformity();
    const li = sb.linearity();
    log('debug', `S盒「${sb.name}」(${sb.inBits}→${sb.outBits}) 差分均匀度=${du.value} (Δ=${du.inputDiff.toString(16)}→${du.outputDiff.toString(16)}) 线性度=${li.value} 非线性度=${sb.nonlinearity()}`);
  }

  // 拓扑顺序
  const order = graph.topoOrder();
  const inputNode = graph.nodes.find(n => n.type === 'INPUT');
  if (!inputNode) { log('error', '未找到输入节点'); return { ok: false, issues, characteristics: [], candidates: [], perRound: [], best: null, elapsedMs: 0 }; }

  const order_idx = new Map(order.map((n, i) => [n.id, i]));
  const roundNode = graph.nodes.find(n => n.type === 'ROUND');
  const declaredRounds = roundNode ? (roundNode.props.rounds | 0) : rounds;
  const wantEnd = endRound != null ? (endRound | 0) : rounds;
  if (wantEnd > declaredRounds) {
    log('warn', `请求分析到第 ${wantEnd} 轮，但结构只声明了 ${declaredRounds} 轮，已截断到 ${declaredRounds} 轮`);
  }
  if (r0 > declaredRounds) {
    log('error', `起始轮 ${r0} 超过结构声明的 ${declaredRounds} 轮，分析中止`);
    return { ok: false, issues, characteristics: [], candidates: [], perRound: [], best: null, elapsedMs: 0 };
  }
  const totalRounds = Math.min(wantEnd, declaredRounds);

  /* ---- 起始差分：用户显式指定时优先（从前通用图路径忽略这个输入框） ----
   * 界面收的是「四字向量的数组」（feistelCharacteristicSearch 的状态是 4×32bit）。
   * 通用图只有一个状态字，故只取向量里**第一个非零字**；若还有别的非零字，
   * 记一条 warn 明说被忽略 —— 不静默丢。 */
  const explicitInit = pickExplicitInit(initDiffs, inputNode.props.bits | 0);
  if (initDiffs != null && !explicitInit) {
    log('warn', '「起始差分」内容无法识别（应为四字向量，如 0x10000000,0,0,0），已改用默认单比特起点');
  } else if (explicitInit) {
    if (explicitInit.mask === 0) {
      log('error', '「起始差分」为全零 —— 全零差分不构成特征，分析中止');
      return { ok: false, issues, characteristics: [], candidates: [], perRound: [], best: null, elapsedMs: 0 };
    }
    log('info', `起始差分：用户指定 0x${explicitInit.mask.toString(16)}`
      + `（通用图是单字状态，取四字向量里的第一个非零字`
      + `${explicitInit.extra ? `；其余 ${explicitInit.extra} 个非零字被忽略` : ''}）`);
  }

  // 结果容器
  const perRound = [];
  const allChars = [];

  // 对每一轮执行一次贪心传播 + 记录统计
  const state = new Map(); // nodeId -> mask
  let carriedMask = null;  // 上一轮输出掩码（用于 SPN 迭代特征）
  let carriedWords = null; // ★ 多字结构：上一轮输出的 n 个字（ARX 迭代把整状态接回）
  // 迭代特征的累计量：SPN 每轮的转移概率/活跃 S 盒要跨轮累积，
  // 否则 r 轮特征只会反映最后一轮（曾导致 16 轮算出 2.00 而非 32.00）
  let cumProb = 1;
  let cumActive = 0;
  let cumBranch = 0;
  let cumMapWeight = 0;   // Σ 概率映射期望权重
  let cumDiffusion = 0;   // Σ 扩散权重 hw(Δ)

  for (let r = r0; r <= totalRounds; r++) {
    // 重置状态
    state.clear();
    let branchTotal = 0;

    // 初始注入：用户指定的起始差分优先，否则按图结构挑单比特起点
    const initMask = explicitInit ? explicitInit.mask : pickInputMask(inputNode, graph, r, mode);

    // SPN 类结构：每轮把上一轮输出重新注入输入端（迭代特征）
    // 找到输入节点的直接后继，作为"轮入口"
    const entryMask = (r > 1 && carriedMask !== null) ? carriedMask : initMask;
    // ★ INPUT 多字端口：逐字注入（侧信道），支撑 ARX 的 128bit = 4×32bit 状态。
    //   第 1 轮用界面的「起始差分」四字向量；之后各轮用上一轮的字结果（整状态接回）。
    const inPorts = inputNode.outputs;
    if (inPorts.length > 1) {
      const mBits = maskOf(blockBits);
      const explicitWords = (r === r0 && Array.isArray(initDiffs) && initDiffs.length >= inPorts.length)
        ? initDiffs.slice(0, inPorts.length).map((x) => (Number(x) >>> 0) & mBits)
        : null;
      const ws = explicitWords
        || (carriedWords && carriedWords.length === inPorts.length
          ? carriedWords.map((x) => (x >>> 0) & mBits)
          : deriveWordsFromSeed(entryMask, inPorts.length, mBits));
      inPorts.forEach((p, i) => state.set(`${inputNode.id}|${p.id}`, ws[i] >>> 0));
      state.set(inputNode.id, ws[0] >>> 0);
      if (r === r0) {
        log('info', `多字状态：${inPorts.length} 个字（每字 ${inputNode.props.bits | 0} bit）`
          + `，起始差分 ${ws.map((w) => `0x${(w >>> 0).toString(16)}`).join(', ')}`);
      }
    } else {
      state.set(inputNode.id, entryMask);
    }

    // ★ 端口感知的图传播内核：与 Feistel 分支迭代路径共用同一份节点语义。
    //    从前这一段是内联的「inMask |= state.get(e.from)」—— 端口不参与，
    //    SPLIT 的两个分支槽只写不读。现在统一走 propagateGraphOnce。
    const body = propagateGraphOnce({ graph, order, state, mode, blockBits, round: r });
    const steps = body.steps;
    const prob = body.prob;
    const activeSboxTotal = body.activeSboxTotal;
    const roundMapWeight = body.mapWeight;

    // 收集输出掩码
    const outNode = graph.nodes.find(n => n.type === 'OUTPUT');
    const outMask = outNode ? (state.get(outNode.id) ?? 0) : 0;
    // ★ 多字结构：本轮的字结果留给下一轮（ARX 的迭代是「整状态接回」，不是只接一个字）
    if (outNode && outNode.inputs.length > 1) {
      carriedWords = outNode.inputs.map((p) => outMaskAt(state, outNode.id, p.id));
    }

    const ch = new Characteristic(mode);
    ch.steps = steps;
    ch.inputMask = initMask;
    ch.outputMask = outMask;
    // ★ 结果页「输入 / 输出差分」读的是**数组**形式（SM4 / Feistel 路径是 4×32bit 字）。
    //   通用图是单字状态 —— 从前这两个字段从不被填，结果页与中文解析里
    //   恒显示「(未记录)」，看起来像引擎没算出输出差分。
    ch.inputState = [entryMask >>> 0];
    ch.outputState = [outMask >>> 0];
    ch.rounds = r;
    // 跨轮累积（迭代特征）：Δ 路径为 1..r 轮串联
    cumProb *= prob;
    cumActive += activeSboxTotal;
    cumBranch += branchTotal;
    const roundDiffusion = hwN(outMask, blockBits);
    cumMapWeight += roundMapWeight;
    cumDiffusion += roundDiffusion;
    ch.prob = cumProb;
    ch.activeSboxes = cumActive;
    ch.branchCount = cumBranch;
    ch.nodesCovered = steps.length;
    ch.finalize();
    ch.startRound = r0;
    ch.endRound = r;
    ch.model = spec.id;
    ch.modelName = spec.name;
    ch.mapWeight = cumMapWeight;
    ch.diffusionWeight = cumDiffusion;
    ch.dualScore = ch.weight + lambda * cumDiffusion;
    ch.lambda = lambda;
    applyComplexityModel(ch, mode, r - r0 + 1, blockBits, sboxNodes.length,
      { snr, keyBitsPerSbox });
    allChars.push(ch);

    perRound.push({
      round: r,
      inputWeight: hwN(initMask, blockBits),
      outputWeight: hwN(outMask, blockBits),
      outputMask: outMask,
      inputMask: initMask,
      prob: prob,
      roundWeight: -Math.log2(Math.max(prob, Number.MIN_VALUE)),
      cumProb: cumProb,
      weight: ch.weight,
      log2p: ch.probLog2,
      activeSboxes: activeSboxTotal,
      cumActive: cumActive,
      dataComplexity: ch.dataComplexity,
      timeComplexity: ch.timeComplexity,
      memoryComplexity: ch.memoryComplexity,
      keyGuesses: ch.keyGuesses,
      variables: steps.length,
      branch: branchTotal,
      mapWeight: cumMapWeight,
      roundMapWeight,
      diffusion: cumDiffusion,
      dualScore: ch.dualScore,
      snr,
      steps,
    });

    log('debug', `第 ${r} 轮：Δin=0x${initMask.toString(16)} → Δout=0x${outMask.toString(16)} | 本轮 -log2(p)=${(-Math.log2(Math.max(prob, Number.MIN_VALUE))).toFixed(3)} | 累计 -log2(p)=${ch.weight.toFixed(3)} | 活跃S盒累计=${cumActive} | 映射权重=${cumMapWeight.toFixed(3)} | 扩散权重=${cumDiffusion} | 数据复杂度=2^${Math.log2(Math.max(ch.dataComplexity,1)).toFixed(1)}`);

    // 携带本轮的输出掩码进入下一轮（迭代特征）
    carriedMask = outMask >>> 0;
  }

  // 多候选路径搜索（分支限界）
  let candidates = [];
  if (searchMode === 'bb' || searchMode === 'exhaustive') {
    log('info', `启动${searchMode === 'bb' ? '分支限界 (Matsui)' : '穷举'}路径搜索，候选上限 ${maxCandidates}`);
    candidates = searchBestCharacteristics(graph, {
      mode, rounds: totalRounds, blockBits, log,
      maxCandidates, timeBudgetMs, exhaustive: searchMode === 'exhaustive',
    });
    log('info', `搜索完成，获得 ${candidates.length} 条候选特征路径`);
  }

  // 「最优特征」必须是**完整轮数**的那条。
  // 注意：权重随轮数单调递增，若在全部轮数里取最小权重，会永远选中 1 轮特征。
  const fullRoundChars = allChars.filter(c => c.rounds === totalRounds);
  const best = bestOf(fullRoundChars.length ? fullRoundChars : allChars, model);
  const t1 = performance.now();

  log('info', `分析完成，耗时 ${(t1 - t0).toFixed(2)} ms`);
  if (best) {
    log('info', `最优特征：-log2(p) = ${best.weight.toFixed(4)} | 概率 = 2^${best.probLog2.toFixed(2)} | 数据复杂度 ≈ 2^${Math.log2(Math.max(best.dataComplexity,1)).toFixed(2)}`);
  }

  return {
    ok: true,
    issues,
    perRound,
    characteristics: allChars,
    candidates,
    best,
    elapsedMs: t1 - t0,
    meta: {
      mode, totalRounds, blockBits,
      declaredRounds, sboxCount: sboxNodes.length,
      startRound: r0, endRound: totalRounds,
      rounds: totalRounds - r0 + 1,
      model: spec.id, modelName: spec.name, modelShort: spec.short,
      lambda, snr, sortKey,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      variables: graph.variables.length,
      graph,
    },
  };
}

/** 依据结构选择输入端初始掩码 */
function pickInputMask(inputNode, graph, round, mode) {
  const bits = inputNode.props.bits | 0;
  const structure = graph.meta.structure;
  if (structure === 'feistel') {
    // Feistel：单比特差分置于右半
    const half = Math.floor(bits / 2);
    return (1 << Math.min(half, 31)) >>> 0;
  }
  // SPN：低比特单点差分（实践中常用最低位/最高位）
  return 1;
}

/**
 * 把界面的「起始差分 / 掩码」落到**单字**的通用图上。
 *
 * 输入是 `parseInitDiffs()` 的产物：`[[a,b,c,d], ...]`（Feistel 的状态是 4×32bit 字）。
 * 通用图只维护一个状态字，所以：
 *   · 取**第一个起点**的向量（通用图每轮只跑一个起点）；
 *   · 向量里取**第一个非零字**作为起始掩码 —— 其余非零字计入 `extra`，
 *     由调用方记一条 warn，不静默丢弃。
 *
 * @returns {{mask: number, extra: number}|null} null = 无可用的显式起点
 */
function pickExplicitInit(initDiffs, bits) {
  if (!Array.isArray(initDiffs) || !initDiffs.length) return null;
  const first = initDiffs[0];
  const vec = Array.isArray(first) ? first : [first];
  const nz = vec.map((v) => (v >>> 0)).filter((v) => v !== 0);
  if (!nz.length) return { mask: 0, extra: 0 };
  return { mask: (nz[0] & maskOf(bits)) >>> 0, extra: nz.length - 1 };
}

/**
 * 取最优特征。排序键随模型变化：
 *   概率权重模型 → weight；概率映射模型 → mapWeight；双权优化模型 → dualScore。
 * 缺少对应字段时退回 weight，保证任何调用路径都不会失效。
 */
function bestOf(list, model = SEARCH_MODEL.WEIGHT) {
  if (!list.length) return null;
  const k = modelKey(model);
  const val = (c) => (typeof c[k] === 'number' ? c[k] : c.weight);
  return list.reduce((a, b) => (val(b) < val(a) ? b : a));
}

/* ============================================================
 * 复杂度模型：数据复杂度 / 时间复杂度 / 密钥猜测数
 * 参照经典差分/线性攻击复杂度公式
 * ============================================================ */

export function applyComplexityModel(ch, mode, rounds, blockBits, sboxCount, opts = {}) {
  const n = blockBits;
  const p = Math.max(ch.prob, Number.MIN_VALUE);
  const w = -Math.log2(p);

  // 数据复杂度：差分 ≈ c/p；线性 ≈ c/(corr^2)  （Matsui 定理）
  // 引入信噪比修正系数 c（辅助变量，通常 1~8）
  const SNR = opts.snr ?? 2;
  ch.snr = SNR;
  const data = SNR / p;
  // 密钥恢复阶段需要额外计数基数：可由「每活跃 S 盒换算成多少猜测比特」控制
  const keyBitsPerSbox = opts.keyBitsPerSbox ?? 4;
  const guessedBits = Math.min(sboxCount * keyBitsPerSbox, n);
  ch.keyGuesses = guessedBits;
  ch.dataComplexity = Math.ceil(data);

  // 时间复杂度：2^(guessBits) × data
  ch.timeComplexity = Math.pow(2, guessedBits) * ch.dataComplexity;
  // 内存复杂度：存储计数器表
  ch.memoryComplexity = Math.pow(2, Math.min(guessedBits, 24));

  // 有效攻击轮数评估
  ch.effectiveRounds = rounds;
  ch.bitsPerRound = w / Math.max(rounds, 1);

  return ch;
}

/* ============================================================
 * 分支限界搜索最优特征（Matsui 算法思想）
 * 以 S 盒活跃数下界剪枝，寻找 -log2(p) 最小的路径
 * ============================================================ */

export function searchBestCharacteristics(graph, opts) {
  const { mode, rounds, blockBits, log, maxCandidates = 12, timeBudgetMs = 8000, exhaustive = false } = opts;
  const lib = globalThis.__SBOX_LIB__;
  const order = graph.topoOrder().filter(n => n.type !== 'ROUND');
  const inputNode = graph.nodes.find(n => n.type === 'INPUT');
  const outNode = graph.nodes.find(n => n.type === 'OUTPUT');
  if (!inputNode || !outNode) return [];

  const t0 = performance.now();
  const results = [];

  // 计算每个 S 盒节点的最优/最差转移概率，用于下界估计
  const sboxNodes = order.filter(n => n.type === 'SBOX' || n.type === 'TTRANS');
  const bounds = sboxNodes.map(n => {
    if (n.type === 'TTRANS') {
      // SM4 S 盒：差分均匀度 4 / 线性度 32
      const sb = lib.getSBoxByRef('sm4');
      const du = sb.differentialUniformity();
      const li = sb.linearity();
      const corr = li.value / (1 << (sb.inBits - 1));
      return {
        minWeight: mode === MODE.DIFFERENTIAL ? -Math.log2(du.value / sb.inSize) : -Math.log2(corr * corr),
        table: mode === MODE.DIFFERENTIAL ? sb.diffTransitions() : sb.linTransitions(),
        sb, isT: true,
      };
    }
    const sb = lib.getSBoxByRef(n.props.sboxId);
    if (!sb) return { minWeight: 0, table: null };
    // ★ 大盒（如 16×16，DDT 全表 4.3G cell）算不出**全局**差分均匀度/线性度 →
    //   不给下界（0 = 不设限），并说明原因；绝不为了凑一个数去建全表。
    if (!sb.fullTableFeasible()) {
      log('warn', `S盒「${sb.name}」(${sb.inBits}→${sb.outBits}) 过大，无法计算全局下界估计（本轮跳过）`);
      return { minWeight: 0, table: null, sb, noBound: true };
    }
    if (mode === MODE.DIFFERENTIAL) {
      const du = sb.differentialUniformity();
      const minW = -Math.log2(du.value / sb.inSize);
      return { minWeight: minW, table: sb.diffTransitions(), sb };
    } else {
      const li = sb.linearity();
      const corr = li.value / (1 << (sb.inBits - 1));
      const minW = -Math.log2(Math.max(corr * corr, 1e-9));
      return { minWeight: minW, table: sb.linTransitions(), sb };
    }
  });

  const totalMinWeight = bounds.reduce((a, b) => a + b.minWeight, 0);
  log('debug', `路径搜索下界估计：单轮最小 -log2(p) ≥ ${totalMinWeight.toFixed(4)}（基于各 S 盒最大 DDT/LAT 值）`);

  // 候选初值：若干个单比特输入差分
  const initMasks = [];
  const inputBits = inputNode.props.bits | 0;
  const structure = graph.meta.structure;
  if (structure === 'feistel') {
    const wb = graph.meta.wordBits || Math.floor(inputBits / 2);
    // Feistel/SM4：单比特差分置于某个 32bit 字内
    for (let i = 0; i < Math.min(4, wb); i++) initMasks.push((1 << i) >>> 0);
    for (let i = 0; i < Math.min(4, wb); i++) initMasks.push((1 << (8 + i)) >>> 0);
  } else {
    for (let i = 0; i < Math.min(inputBits, 6); i++) initMasks.push(1 << i);
  }
  // 若数据量允许，加入 2 比特差分
  if (exhaustive) {
    for (let i = 0; i < Math.min(inputBits, 6); i++)
      for (let j = i + 1; j < Math.min(inputBits, 6); j++)
        initMasks.push((1 << i) | (1 << j));
  }

  const BUDGET_PER_START = Math.max(1, Math.floor(maxCandidates / initMasks.length));

  for (const init of initMasks) {
    if (performance.now() - t0 > timeBudgetMs) { log('warn', `路径搜索超出时间预算 ${timeBudgetMs}ms，提前终止（已探索 ${initMasks.indexOf(init)}/${initMasks.length} 个起点）`); break; }

    // 对每个起点做贪心 + 局部替换的束搜索
    const beam = [{ mask: init, prob: 1, weight: 0, steps: [], state: new Map([[inputNode.id, init]]) }];
    const beamWidth = exhaustive ? 8 : 4;

    for (let r = 1; r <= rounds; r++) {
      const nextBeam = [];
      for (const cand of beam) {
        if (performance.now() - t0 > timeBudgetMs) break;
        const state = new Map(cand.state);
        const steps = cand.steps.slice();
        let prob = cand.prob;
        let branch = 0;

        for (const node of order) {
          if (node.type === 'INPUT') continue;
          const inEdges = graph.inEdges(node.id);
          if (inEdges.length === 0) continue;
          // 与主内核一致：按来源端口取掩码（端口必须参与），
          // 且合并节点按自己声明的运算（xor 才是真的异或，见 propagateGraphOnce 的注释）
          const ins = inEdges.map((e) => outMaskAt(state, e.from, e.fromPort));
          const inMask = (node.type === 'MERGE' && (node.props.op || 'xor') === 'xor')
            ? ins.reduce((a, v) => (a ^ v) >>> 0, 0)
            : ins.reduce((a, v) => (a | v) >>> 0, 0);

          let activeSboxLocal = 0;
          let res;
          if (node.type === 'TTRANS') {
            res = sm4TTransition(inMask, mode, {
              linearS: !!node.props.linearS,
              tauOnly: !!node.props.tauOnly,
              keyExt: !!node.props.keyExt,
            });
            activeSboxLocal = res.activeCount || 0;
          } else if (node.type === 'SBOX') {
            const sb = lib.getSBoxByRef(node.props.sboxId);
            if (!sb) { res = { outMask: inMask, prob: 1, activeCount: 0 }; }
            else {
              // 关键：枚举该 S 盒节点所有有效转移，生成分支
              const parts = splitSBoxInputs(sb, inMask, node.props.mode || 'parallel', blockBits);
              const active = parts.filter(p => (p.inMask & maskOf(Math.min(p.width, sb.inBits))) !== 0);
              if (active.length > 1 && !exhaustive) {
                // 简化为贪心（避免组合爆炸），仅在 exhaustive 模式枚举
                res = propagateSBox(node, inMask, mode, blockBits);
              } else {
                const t = bestTransition(sb, mode, active[0]?.inMask ?? 0);
                if (t.unsupported) {
                  // 宽输出线性侧：不把 prob 记成 0（否则权重会变成 ∞ 的假值），如实标注不精确
                  res = { outMask: inMask, prob: 1, activeCount: active.length, unsupported: true, note: t.note };
                } else {
                  const out = (t.out & maskOf(sb.outBits)) << (active[0]?.shift ?? 0);
                  res = { outMask: out >>> 0, prob: t.prob, activeCount: active.length, note: `${active.length} 活跃` };
                }
              }
            }
            prob *= res.prob;
            branch += Math.max(0, (res.activeCount || 0) - 1);
          } else if (node.type === 'LINEAR') {
            res = propagateLinear(node, inMask, blockBits, 1);
          } else if (node.type === 'PERM') {
            res = propagatePerm(node, inMask, blockBits);
          } else if (node.type === 'SPLIT') {
            // 与主内核一致：两个分支分别落到各自的端口槽上
            const sb = Math.max(1, Math.min(32, node.props.splitBits | 0 || blockBits));
            const a = (inMask & maskOf(sb)) >>> 0;
            const b = sb >= 32 ? 0 : ((inMask >>> sb) & maskOf(Math.max(0, blockBits - sb))) >>> 0;
            state.set(node.id + '|a', a);
            state.set(node.id + '|b', b);
            res = { outMask: (a | b) >>> 0, prob: 1, note: `分块 A=${sb}bit` };
          } else {
            res = { outMask: inMask, prob: 1 };
          }
          state.set(node.id, res.outMask);
          const st = new TraceStep(node, r, mode, inMask, res.outMask, { prob: res.prob, note: res.note, unsupported: res.unsupported });
          st.activeCount = res.activeCount || 0;
          steps.push(st);
        }

        const outMask = state.get(outNode.id) ?? 0;
        const w = prob > 0 ? -Math.log2(prob) : Infinity;
        nextBeam.push({ mask: init, prob, weight: w, steps, state, outMask, round: r, branch });
      }

      // 束宽裁剪：保留 weight 最小的 beamWidth 条
      nextBeam.sort((a, b) => (a.weight - b.weight) || (b.branch - a.branch));
      beam.length = 0;
      beam.push(...nextBeam.slice(0, beamWidth));
    }

    for (const b of beam.slice(0, BUDGET_PER_START)) {
      const ch = new Characteristic(mode);
      ch.steps = b.steps;
      ch.inputMask = init;
      ch.outputMask = b.outMask;
      ch.rounds = rounds;
      ch.prob = b.prob;
      ch.branchCount = b.branch;
      ch.nodesCovered = b.steps.length;
      ch.finalize();
      applyComplexityModel(ch, mode, rounds, blockBits, sboxNodes.length);
      results.push(ch);
    }
  }

  // 去重 + 排序
  const uniq = [];
  const seen = new Set();
  for (const c of results.sort((a, b) => a.weight - b.weight)) {
    const key = `${c.inputMask}:${c.outputMask}:${c.rounds}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
    if (uniq.length >= maxCandidates) break;
  }
  return uniq;
}

/** 计算输入掩码到输出掩码的整体特征的 Hamming 距离（雪崩性指标） */
export function avalancheTest(graph, opts = {}) {
  const { round = graph.meta.rounds, samples = 256 } = opts;
  const inputNode = graph.nodes.find(n => n.type === 'INPUT');
  if (!inputNode) return null;
  const bits = inputNode.props.bits | 0;
  const rng = makeRng(0xC0FFEE);
  const flipCounts = new Array(bits).fill(0);
  const lib = globalThis.__SBOX_LIB__;

  // 快速前向计算：以"掩码扩散"近似雪崩（逐位差分传播）
  for (let b = 0; b < bits; b++) {
    let totalOut = 0;
    for (let s = 0; s < samples; s++) {
      // 随机明文差异 + 单位比特差分
      const base = rng() & maskOf(bits);
      const diff = ((1 << b) | (rng() & maskOf(bits) & ((1 << Math.min(3, bits)) - 1))) >>> 0;
      const out1 = forwardEncrypt(graph, base, { rounds: round, blockBits: bits, lib });
      const out2 = forwardEncrypt(graph, (base ^ diff) >>> 0, { rounds: round, blockBits: bits, lib });
      totalOut += hwN(out1 ^ out2, bits);
    }
    flipCounts[b] = totalOut / samples;
  }
  const avg = flipCounts.reduce((a, b) => a + b, 0) / bits;
  const ideal = bits / 2;
  const maxDev = Math.max(...flipCounts.map(c => Math.abs(c - ideal)));
  return {
    bits, round, samples, flipCounts, avg, ideal,
    maxDeviation: maxDev,
    normalized: maxDev / ideal,
    verdict: maxDev / ideal < 0.1 ? '优（雪崩效应良好）' : maxDev / ideal < 0.25 ? '中（存在弱扩散比特）' : '差（扩散不充分）',
  };
}

/**
 * 前向加密（真实值实现，用于雪崩测试 / 值级对拍）。
 *
 * ⚠️ 这里修的第二处缺陷：从前它**只把图跑一趟**，`rounds` 参数收下就丢，
 * 于是 `avalancheTest` 传 `rounds = 32`（SM4）实际只算了一轮 ——
 * 「雪崩」看起来很好，其实与轮数无关。现在按 `rounds` 迭代：
 * 每一轮把整张图从头跑一遍，输出接回输入。
 *
 * `rounds = null` 时取图上 `ROUND` 容器声明的迭代轮数（无该节点则 1 轮）。
 *
 * ★ 多字状态（ARX）：INPUT 开启「多字端口」时，明文种子按确定性 PRNG 派生
 *   n 个字，迭代时把上一轮的 n 个字接回（而不是只接第一个字）。
 *   返回**字数组**，供 128bit 结构逐字对拍。
 */
export function forwardEncryptWords(graph, plaintext, { rounds = null, blockBits = 32, lib, words: initWords = null } = {}) {
  const order = graph.topoOrder().filter(n => n.type !== 'ROUND');
  const m = maskOf(blockBits);
  const roundNode = graph.nodes.find(n => n.type === 'ROUND');
  const declared = roundNode ? (roundNode.props.rounds | 0) : 1;
  const total = Math.max(1, (rounds != null ? (rounds | 0) : declared) || 1);
  let cur = plaintext & m;
  // 多字结构：调用方可直接给 n 个字（独立对拍用）；不给则首轮由种子派生
  let words = (Array.isArray(initWords) && initWords.length)
    ? initWords.map((x) => (Number(x) >>> 0) & m)
    : null;
  for (let round = 1; round <= total; round++) {
    const out = forwardOnce(graph, order, cur, { blockBits, lib, m, round, prevWords: words });
    cur = out.value;
    words = out.words;
  }
  return words && words.length ? words : [cur & m];
}

/** 单字返回版（保持既有调用方语义不变）：多字结构下取 W0。 */
export function forwardEncrypt(graph, plaintext, opts = {}) {
  const w = forwardEncryptWords(graph, plaintext, opts);
  return (w[0] ?? 0) >>> 0;
}

/** 由单字种子确定性派生 n 个状态字（确定性 = 可复现；多字输入的兜底来源）。 */
function deriveWordsFromSeed(seed, n, m) {
  const rng = makeRng((seed >>> 0) || 0x9E3779B9);
  const out = [(seed >>> 0) & m];
  for (let i = 1; i < n; i++) out.push(rng() & m);
  return out;
}

/**
 * 单趟前向计算：沿拓扑序把整张图跑一遍（`round` 供轮密钥派生用）。
 * 返回 `{ value, words }`：`words` 仅在 OUTPUT 多端口时有值。
 */
function forwardOnce(graph, order, plaintext, { blockBits, lib, m, round, prevWords = null }) {
  const state = new Map();
  const inputNode = graph.nodes.find(n => n.type === 'INPUT');
  if (inputNode) {
    const ports = inputNode.outputs;
    if (ports.length > 1) {
      const ws = (prevWords && prevWords.length === ports.length)
        ? prevWords
        : deriveWordsFromSeed(plaintext, ports.length, m);
      ports.forEach((p, i) => state.set(`${inputNode.id}|${p.id}`, ws[i] & m));
      state.set(inputNode.id, ws[0] & m);
    } else {
      state.set(inputNode.id, plaintext & m);
    }
  }

  for (const node of order) {
    if (node.type === 'INPUT') continue;
    const inEdges = graph.inEdges(node.id);
    if (!inEdges.length) continue;
    let v = 0;
    for (const e of inEdges) v |= outMaskAt(state, e.from, e.fromPort);
    v &= m;
    /** 按**目的端口**取输入值（QUARTER_ROUND 这类多端口节点必需） */
    const portVal = (pid) => {
      const e = inEdges.find((x) => x.toPort === pid);
      return e ? (outMaskAt(state, e.from, e.fromPort) & m) : 0;
    };

    switch (node.type) {
      case 'TTRANS': {
        const sb = lib ? lib.getSBoxByRef('sm4') : null;
        let tau = 0;
        for (let i = 0; i < 4; i++) {
          const b = (v >>> (i * 8)) & 0xFF;
          const sub = (node.props.linearS || !sb) ? b : sb.apply(b);
          tau |= ((sub & 0xFF) << (i * 8));
        }
        tau >>>= 0;
        if (node.props.tauOnly) { state.set(node.id, tau); break; }
        state.set(node.id, (node.props.keyExt ? sm4Lp(tau) : sm4L(tau)) >>> 0);
        break;
      }
      case 'SBOX': {
        const sb = lib ? lib.getSBoxByRef(node.props.sboxId) : null;
        if (!sb) { state.set(node.id, v); break; }
        const repeat = Math.max(1, node.props.repeat | 0);
        let cur = v;
        for (let r = 0; r < repeat; r++) {
          const parts = splitSBoxInputs(sb, cur, node.props.mode || 'parallel', blockBits);
          let out = 0;
          for (const p of parts) {
            const val = (cur >>> p.shift) & maskOf(p.width);
            const sub = sb.apply(val & maskOf(sb.inBits));
            out |= ((sub & maskOf(sb.outBits)) << p.shift);
          }
          cur = out & m;
        }
        state.set(node.id, cur);
        break;
      }
      case 'LINEAR': {
        let out = v;
        if (node.props.op === 'rotl') out = rotl(v, node.props.amount | 0, blockBits);
        else if (node.props.op === 'rotr') out = rotr(v, node.props.amount | 0, blockBits);
        else if (node.props.op === 'xorShift') out = (v ^ ((v << (node.props.amount | 0)) & m)) & m;
        else if (node.props.op === 'mixColumns') {
          // 与掩码级共用同一份真 GF(2⁸) 实现（从前这里用的是 8 位循环左移，
          // 连 xtime 都不是 —— 见文件上方 GF(2⁸) 段落的说明）
          out = mixColumnsWord(v, blockBits);
        }
        state.set(node.id, out & m);
        break;
      }
      case 'PERM': {
        let out = v;
        const bytes = Math.max(1, Math.floor(blockBits / 8));
        const s = (node.props.shift | 0) % bytes;
        if (s) {
          let o = 0;
          for (let i = 0; i < bytes; i++) o |= (((v >>> (((i - s + bytes * 2) % bytes) * 8)) & 0xFF) << (i * 8));
          out = o & m;
        }
        if (node.props.reverse) out = reverseBits(out, blockBits);
        state.set(node.id, out & m);
        break;
      }
      case 'SPLIT': {
        // 与主内核一致：splitBits 夹到 31 以内（`>>> 32` 等价于不移位）
        const sb = Math.max(1, Math.min(32, node.props.splitBits | 0 || blockBits));
        state.set(node.id + '|a', (v & maskOf(sb)) >>> 0);
        state.set(node.id + '|b', (sb >= 32 ? 0 : (v >>> sb)) & m);
        state.set(node.id, v);
        break;
      }
      case 'MERGE': {
        const ins = inEdges.map((e) => outMaskAt(state, e.from, e.fromPort));
        let o = ins.reduce((a, b) => a ^ b, 0) & m;
        if (node.props.op === 'add') o = ins.reduce((a, b) => (a + b) & m, 0);
        if (node.props.op === 'and') o = ins.reduce((a, b) => a & b, m);
        state.set(node.id, o & m);
        break;
      }
      case 'XORKEY': {
        // 轮密钥由「变量名 + 轮次」确定性派生（可复现）。
        // 界面「独立轮密钥 = 是」（默认）→ 每轮不同；
        // 「否（固定复用）」→ 传 round 0，各轮同一把 —— 这正是 AES 那种
        // 「整状态异或一个固定常量」的加常量层语义（从前这个属性没有消费者）。
        const k = keySchedule(node.props.keyVar || 'k0',
          node.props.independent === 'no' ? 0 : round);
        state.set(node.id, (v ^ k) & m);
        break;
      }
      case 'QUARTER_ROUND': {
        const r1 = clampShift(node.props.r1, 16), r2 = clampShift(node.props.r2, 12);
        const r3 = clampShift(node.props.r3, 8), r4 = clampShift(node.props.r4, 7);
        let a = portVal('a'), b = portVal('b'), c = portVal('c'), d = portVal('d');
        a = (a + b) & m; d = rotl((d ^ a) & m, r1, blockBits) & m;
        c = (c + d) & m; b = rotl((b ^ c) & m, r2, blockBits) & m;
        a = (a + b) & m; d = rotl((d ^ a) & m, r3, blockBits) & m;
        c = (c + d) & m; b = rotl((b ^ c) & m, r4, blockBits) & m;
        state.set(`${node.id}|a`, a & m); state.set(`${node.id}|b`, b & m);
        state.set(`${node.id}|c`, c & m); state.set(`${node.id}|d`, d & m);
        state.set(node.id, (a | b | c | d) & m);
        break;
      }
      case 'OUTPUT': {
        const ports = node.inputs;
        if (ports.length > 1) {
          for (const p of ports) state.set(`${node.id}|${p.id}`, portVal(p.id));
          state.set(node.id, v & m);
        } else {
          state.set(node.id, v & m);
        }
        break;
      }
      default:
        state.set(node.id, v & m);
    }
  }
  const outNode = graph.nodes.find(n => n.type === 'OUTPUT');
  if (!outNode) return { value: 0, words: null };
  const outPorts = outNode.inputs;
  if (outPorts.length > 1) {
    const words = outPorts.map((p) => outMaskAt(state, outNode.id, p.id) & m);
    return { value: (words[0] ?? 0) & m, words };
  }
  return { value: (state.get(outNode.id) ?? 0) & m, words: null };
}

/** 循环移位量夹到 [1,31]（0 或 ≥bits 无意义；默认值用于属性缺失时）。 */
function clampShift(v, dflt) {
  const k = Math.round(Number(v));
  if (!Number.isFinite(k)) return dflt;
  return Math.max(1, Math.min(31, k));
}

/**
 * 由「密钥变量名 + 轮次」派生确定性伪随机轮密钥。
 * `round = 0` 表示所有轮复用同一把（界面「独立轮密钥 = 否」）。
 */
function keySchedule(name, round = 0) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const rng = makeRng((h ^ 0x5A5A5A5A ^ Math.imul(round | 0, 0x9E3779B1)) >>> 0);
  return rng();
}
