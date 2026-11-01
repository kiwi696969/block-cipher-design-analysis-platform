/**
 * SPN 单元束搜索引擎 —— AES-128 / PRESENT-64 的「完整算法」专用路径。
 *
 * 为什么需要它（而不是让通用图引擎去算）：
 *   通用图引擎的状态是**单个 32bit 字**（`blockBits ≤ 32`），而 AES 要 128bit、
 *   PRESENT 要 64bit。SM4 之所以能算，是因为它有 `sm4RoundProfile` 这条 4×32bit
 *   的专用路径 —— 同一个理由，这里给 AES / PRESENT 也开专用路径。
 *
 * 与 SM4 专用引擎的差别（写代码时最容易照抄错）：
 *   · SM4 是 Feistel：状态 = 4 个字，轮函数只动一个字；
 *   · AES / PRESENT 是 SPN：状态 = 16 个**独立单元**，每轮「全部单元过 S 盒 → 线性层」；
 *   · 线性层对差分与掩码是**两个不同的函数**（见 spnref.js 文件头）。
 *
 * 口径（与 SM4 那条路径保持一致，别在这里另立一套）：
 *   这里给出的是**束搜索的上界** —— 找到一条具体特征，其权重 ≥ 全空间最小权重。
 *   想拿精确下界要用 BCA（SAT 全空间）。
 */

import {
  MODE, SEARCH_MODEL, MODEL_SPEC, Characteristic, applyComplexityModel,
} from './analysis.js';
import { SPN_CIPHERS } from './spnref.js';

/** 单元状态 → 字符串键（去重用） */
const stateKey = (cells) => cells.join(',');

/** 单元状态的活跃位数 */
const cellBitsSet = (v) => {
  let n = 0;
  let x = v;
  while (x) { n += x & 1; x >>= 1; }
  return n;
};
const bitsOf = (cells) => cells.reduce((a, v) => a + cellBitsSet(v), 0);

/**
 * 取某个单元输入差分在 DDT / LAT 里的候选转移。
 * @returns {{b:number, p:number}[]} p = 概率（差分）或 corr²（线性），按 p 降序
 */
function transitionsOf(table, rowIdx, cellBits, mode, branchLimit) {
  const n = 1 << cellBits;
  const out = [];
  if (mode === MODE.DIFFERENTIAL) {
    const row = table[rowIdx];
    for (let b = 1; b < n; b++) {
      const cnt = row[b];
      if (cnt > 0) out.push({ b, p: cnt / n, cnt });
    }
  } else {
    const row = table[rowIdx];
    for (let b = 1; b < n; b++) {
      const c = row[b] / n;                       // 相关系数
      if (c !== 0) out.push({ b, p: c * c, corr: Math.abs(c) });
    }
  }
  out.sort((x, y) => (y.p - x.p) || (x.b - y.b));
  return branchLimit > 0 ? out.slice(0, branchLimit) : out;
}

/**
 * 一轮：S 盒层（逐单元枚举转移）→ 线性层。
 *
 * 逐单元枚举必须配「逐单元束宽」：16 个活跃单元各 4 个候选 = 4¹⁶ 种组合，
 * 直接笛卡尔积会炸。这里每处理完一个单元就把候选裁到 `perCellBeam` 条，
 * 相当于在轮内也做一次束搜索 —— 与 SM4 的 `enumTauBranches` 是同一手法。
 */
function oneRound(state, opts) {
  const {
    cipher, mode, table, cellBits, layer, branchLimit, perCellBeam, skipLayer = false,
  } = opts;
  let parts = [{
    cells: state.cells.slice(),
    weight: 0,
    active: 0,
    log: [],
  }];

  for (let i = 0; i < cipher.cells; i++) {
    const a = state.cells[i];
    if (!a) continue;
    const trans = transitionsOf(table, a, cellBits, mode, branchLimit);
    if (!trans.length) return [];            // 该单元无可行转移 → 整条路径死亡
    const next = [];
    for (const part of parts) {
      for (const t of trans) {
        const cells = part.cells.slice();
        cells[i] = t.b;
        next.push({
          cells,
          weight: part.weight - Math.log2(t.p),
          active: part.active + 1,
          log: part.log.concat([{ cell: i, from: a, to: t.b, p: t.p }]),
        });
      }
    }
    next.sort((x, y) => x.weight - y.weight);
    parts = next.slice(0, perCellBeam);
  }

  // 线性层（差分走 layerDiff，掩码走 layerMask —— 由调用方把函数传进来）
  // ★ 真实算法的「最后一轮」没有线性层：AES 第 10 轮无 MixColumns。
  //   只有到 cipher.rounds 那一轮才跳过，截断分析（如只算 4 轮）照样每轮都有。
  if (!skipLayer) {
    for (const part of parts) part.cells = layer(part.cells);
  }
  return parts;
}

/**
 * 起点集合：每个单元位置上「DDT/LAT 行最强」的若干种输入差分。
 *
 * ⚠️ 这份集合决定了搜索能不能找到最优 —— 与 SM4 那条「5 轮起偏高」的根因同一个道理：
 *    引擎再强也找不到没喂进来的入口。因此这里**按位置全覆盖**（16 个单元一个不落），
 *    而不是只挑一个位置。
 */
function buildStarts(cipher, table, mode, cellBits, variants) {
  const n = 1 << cellBits;
  const starts = [];
  for (let pos = 0; pos < cipher.cells; pos++) {
    const ranked = [];
    for (let a = 1; a < n; a++) {
      const tr = transitionsOf(table, a, cellBits, mode, 1);
      const best = tr.length ? tr[0].p : 0;
      if (best > 0) ranked.push({ a, best });
    }
    ranked.sort((x, y) => (y.best - x.best) || (x.a - y.a));
    for (const r of ranked.slice(0, variants)) {
      const cells = new Array(cipher.cells).fill(0);
      cells[pos] = r.a;
      starts.push({ cells, inputCells: cells.slice() });
    }
  }
  return starts;
}

/**
 * 主入口：AES-128 / PRESENT-64 的逐轮最优特征。
 *
 * @param {object} opts
 *   cipher        'aes' | 'present'
 *   mode          MODE.DIFFERENTIAL | MODE.LINEAR
 *   startRound/endRound  轮区间（区间前视为概率 1）
 *   beamWidth     层间束宽（默认取 cipher.defaults.beamWidth）
 *   branchLimit   每个活跃单元保留的转移数（默认取 cipher.defaults.branchLimit）
 *   perCellBeam   轮内逐单元束宽（默认 8）
 *   startVariants 每个单元位置的起点数（默认取 cipher.defaults.startVariants）
 *   initCells     用户显式指定的起始差分/掩码（16 个单元值）；给了就只用它
 * @returns {{best, perRound, chars, path, cipher, meta}}
 */
export function spnProfile(opts = {}) {
  const {
    cipher: cipherId = 'aes',
    mode = MODE.DIFFERENTIAL,
    startRound = 1,
    endRound = null,
    beamWidth = null,
    branchLimit = null,
    perCellBeam = 8,
    startVariants = null,
    initCells = null,
    model = SEARCH_MODEL.WEIGHT,
    lambda = 0.5,
    snr = 2,
    keyBitsPerSbox = null,
    onLog = () => {},
  } = opts;

  const cipher = SPN_CIPHERS[cipherId];
  if (!cipher) throw new Error(`spnProfile: 未知算法 ${cipherId}`);

  /* 三个搜索参数都有「按算法实测选出的默认值」（见 spnref.js 的 SPN_CIPHERS.defaults）。
     调用方显式给值则用调用方的 —— 这里的默认值不是调参目标，而是
     「在这台机器上跑出来既准又不慢」的实测值。 */
  const D = cipher.defaults || {};
  const beamW = Math.max(1, Math.round(beamWidth ?? D.beamWidth ?? 32));
  const branchL = Math.max(0, Math.round(branchLimit ?? D.branchLimit ?? 4));
  const startV = Math.max(1, Math.round(startVariants ?? D.startVariants ?? 3));
  // 攻击端每命中一个活跃单元要猜的密钥位 ≈ 单元位宽（字节盒 8bit / 半字节盒 4bit）
  const kbps = keyBitsPerSbox == null ? cipher.cellBits : keyBitsPerSbox;

  const spec = MODEL_SPEC[model] || MODEL_SPEC.weight;
  const isLinear = mode === MODE.LINEAR;
  const cellBits = cipher.cellBits;

  // S 盒对象（DDT / LAT 走 sbox.js 的唯一实现，不在这里另算一份）
  const sb = globalThis.__SBOX_LIB__?.getSBoxByRef(cipher.sboxKey);
  if (!sb) {
    throw new Error(`spnProfile: S 盒「${cipher.sboxKey}」未在库中（需先加载 S 盒库）`);
  }
  const table = isLinear ? sb.getLAT() : sb.getDDT();

  const r0 = Math.max(1, startRound | 0 || 1);
  const wantEnd = endRound != null ? (endRound | 0) : (opts.rounds || cipher.rounds);
  const totalRounds = Math.min(wantEnd, cipher.rounds);
  if (r0 > totalRounds) {
    return { best: null, perRound: [], chars: [], path: `${cipherId}-spn`, ok: false };
  }

  onLog('info', `引擎：${cipher.name} 专用 SPN 束搜索（${cipher.cells} 个 ${cellBits}bit 单元`
    + `，共 ${cipher.blockBits}bit，结构声明 ${cipher.rounds} 轮）`);
  onLog('info', `S 盒「${sb.name}」差分均匀度 ${sb.differentialUniformity().value}｜`
    + `线性度 ${sb.linearity().value}｜单盒最大${isLinear ? '相关' : '差分'}概率 `
    + `2^-${cellBits - Math.log2(isLinear ? sb.linearity().value : sb.differentialUniformity().value)}`);

  // 起点集合
  let starts;
  if (Array.isArray(initCells) && initCells.length === cipher.cells) {
    starts = [{ cells: initCells.map((v) => v & ((1 << cellBits) - 1)), inputCells: initCells.slice() }];
    onLog('info', `起点集合：使用界面指定的 1 个起点 ${initCells.map((v) => v.toString(16)).join('')}`);
  } else {
    starts = buildStarts(cipher, table, mode, cellBits, startV);
    onLog('info', `起点集合：${starts.length} 个（${cipher.cells} 个单元位置 × 每位置最强 ${startV} 种输入）`);
  }

  const layer = isLinear ? cipher.layerMask : cipher.layerDiff;
  const engineOpts = {
    cipher, mode, table, cellBits, layer, branchLimit: branchL, perCellBeam,
  };

  // 逐轮推进：beam 里每一条都是「完整 r 轮」的候选
  let beam = starts.map((s) => ({ cells: s.cells.slice(), weight: 0, active: 0, log: [], inputCells: s.inputCells }));
  const chars = [];
  const perRound = [];

  for (let r = r0; r <= totalRounds; r++) {
    const next = [];
    const skipLayer = r === cipher.rounds;
    for (const st of beam) {
      for (const round of oneRound(st, { ...engineOpts, skipLayer })) {
        const cells = round.cells;
        next.push({
          cells,
          weight: st.weight + round.weight,
          active: st.active + round.active,
          log: st.log.concat([{
            round: r,
            boxes: round.active,
            weight: round.weight,
            detail: round.log,
          }]),
          inputCells: st.inputCells,
        });
      }
    }
    if (!next.length) {
      onLog('warn', `第 ${r} 轮无可达转移（搜索在此终止）`);
      break;
    }
    // 按状态去重（同状态只留权重最小的那条）
    const uniq = new Map();
    for (const c of next) {
      const k = stateKey(c.cells);
      const prev = uniq.get(k);
      if (!prev || c.weight < prev.weight) uniq.set(k, c);
    }
    beam = [...uniq.values()].sort((a, b) => a.weight - b.weight).slice(0, beamW);

    const b = beam[0];
    const roundBoxes = b.log[b.log.length - 1].boxes;
    const cumBoxes = b.active;

    const ch = new Characteristic(mode);
    ch.steps = b.log.map((L) => ({
      label: `第 ${L.round} 轮：S 盒层 + 线性层`,
      round: L.round,
      mode,
      inMask: 0,
      outMask: 0,
      inWeight: 0,
      outWeight: bitsOf(L.detail.reduce((acc, d) => {
        const a = acc.slice(); a[d.cell] = d.to; return a;
      }, new Array(cipher.cells).fill(0))),
      prob: Math.pow(2, -L.weight),
      activeCount: L.boxes,
      activeSboxes: L.boxes,
      note: `${L.boxes} 个活跃单元，权重 ${L.weight.toFixed(2)}`,
    }));
    ch.inputState = b.inputCells.map((v) => v >>> 0);
    ch.outputState = b.cells.map((v) => v >>> 0);
    ch.rounds = r;
    ch.prob = Math.pow(2, -b.weight);
    ch.probLog2 = -b.weight;
    ch.weight = b.weight;
    ch.activeSboxes = cumBoxes;
    ch.activeBits = bitsOf(b.cells);
    ch.branchCount = 0;
    ch.nodesCovered = b.log.length;
    ch.startRound = r0;
    ch.endRound = r;
    ch.cipher = cipherId;      // ← 抽样验证靠它分流（empirical.js）
    ch.model = spec.id;
    ch.modelName = spec.name;
    ch.mapWeight = b.weight;
    ch.diffusionWeight = b.log.reduce((a, L) => a + L.boxes, 0);
    ch.dualScore = ch.weight + lambda * ch.diffusionWeight;
    ch.lambda = lambda;
    applyComplexityModel(ch, mode, r - r0 + 1, cipher.blockBits, cipher.cells, { snr, keyBitsPerSbox: kbps });
    chars.push(ch);

    perRound.push({
      round: r,
      inputWeight: bitsOf(b.inputCells),
      outputWeight: ch.activeBits,
      outputMask: 0,
      inputMask: 0,
      prob: Math.pow(2, -b.log[b.log.length - 1].weight),
      roundWeight: b.log[b.log.length - 1].weight,
      cumProb: ch.prob,
      weight: ch.weight,
      log2p: ch.probLog2,
      activeSboxes: roundBoxes,
      cumActive: cumBoxes,
      dataComplexity: ch.dataComplexity,
      timeComplexity: ch.timeComplexity,
      memoryComplexity: ch.memoryComplexity,
      keyGuesses: ch.keyGuesses,
      variables: cipher.cells,
      branch: 0,
      mapWeight: ch.mapWeight,
      roundMapWeight: b.log[b.log.length - 1].weight,
      diffusion: ch.diffusionWeight,
      dualScore: ch.dualScore,
      snr,
      steps: ch.steps,
      // 供结果页显示「逐轮活跃单元 / 状态」
      cellsIn: r === r0 ? b.inputCells.slice() : null,
      cellsOut: b.cells.slice(),
      activeCells: roundBoxes,
    });

    onLog('debug', `第 ${r} 轮：活跃单元 ${roundBoxes}（累计 ${cumBoxes}）｜`
      + `本轮 -log2 = ${b.log[b.log.length - 1].weight.toFixed(2)}｜累计 ${ch.weight.toFixed(2)}`);
  }

  const best = chars.length ? chars[chars.length - 1] : null;
  onLog('info', `搜索完成：${chars.length} 轮｜最优 -log2 = ${best ? best.weight.toFixed(2) : '—'}`
    + `｜累计活跃单元 ${best ? best.activeSboxes : 0}`);

  return {
    best,
    perRound,
    chars,
    path: `${cipherId}-spn`,
    ok: !!best,
    cipher: cipherId,
    meta: { cipher, mode, totalRounds, beamWidth: beamW, branchLimit: branchL, startVariants: startV, starts: starts.length },
  };
}
