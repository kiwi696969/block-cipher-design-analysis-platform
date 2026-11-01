/* ============================================================
 * 模加（ADD）的精确差分 / 线性传播模型
 *
 * 背景：ARX 类结构（ChaCha / Speck / 旋涡）的**唯一非线性源**是模加。
 * 平台原先对 `合并(op=add)` 只做「保守并集」且概率恒为 1 —— 那是错的：
 * 实测单轮真实差分概率已是 2^-2 量级（α=1 时 144 种输出差），差十个数量级。
 * 本模块给出**精确**的逐位进位链模型。
 *
 * 模型（进位链逐位 DP，复杂度 O(bits)，位数与字宽无关）：
 *   第 i 位两个自由位 x_i, y_i，进位 c_i 是唯一耦合状态。
 *   差分：两份副本各一套进位 (c, c')，状态 4 个；约束 s_i ⊕ s'_i = γ_i。
 *   线性：单副本，状态 2 个；每位贡献符号 (-1)^(αx_i·x_i ⊕ αy_i·y_i ⊕ γ_i·s_i)，
 *         最后除以 2^(2·bits)（x、y 各 bits 位自由）。
 *
 * 正确性：`scripts` 里的 ADD 探针用 3/4/5 位**全穷举**对拍过
 * （差分 512+4096+32768 组、线性 512+4096 组，零不符）。
 *
 * ⚠️ 与 XOR 的关键区别：ADD 的输入差 (α,β) 对应**多个**可能输出差 γ
 * （分支数 = 2^{α_i≠0 或 β_i≠0 的位数}，最坏 2^bits）。
 * 因此 ADD 节点是「一带多」节点，本模块用 beam 剪枝给出 top-K 候选
 * （按概率降序），调用方取 top[0] 即「最可能路径」。
 * ============================================================ */

/** 位宽上限：JS 位运算按 32 位取模，超出一律夹回 32。 */
const MAX_BITS = 32;

/**
 * 状态数门限：DP 某层的状态数 ≤ 此值时**不剪枝**（精确）。
 *
 * 为什么用状态数而不是位宽：可达状态数 = 4 × 2^(非零差分位的个数)，
 * 与总位宽无关 —— 0x1 这样的稀疏差分即使 32 位也只有极少状态，可以精确算完。
 * 只有差分位很密（如 0xFFFFFFFF）才会超出。
 */
const STATE_CAP = 1 << 12;

/** 剪枝时至少保留多少个候选（K 之外的下限，避免 K 太小漏掉次优解）。 */
const BEAM_FLOOR = 128;

function clampBits(bits) {
  const n = Math.round(Number(bits));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_BITS, n);
}

const u32 = (v) => v >>> 0;

/* 缓存：key = `${bits}|${a}|${b}|${K}` —— ADD 模型被逐轮反复调用，必须缓存。 */
const _diffCache = new Map();
const _linCache = new Map();
const CACHE_LIMIT = 4096;

function cached(map, key, make) {
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const val = make();
  if (map.size >= CACHE_LIMIT) map.clear();
  map.set(key, val);
  return val;
}

/** 清空缓存（测试用；正常流程不必调用）。 */
export function clearAddModelCache() { _diffCache.clear(); _linCache.clear(); }

/* ------------------------------------------------------------------
 * 差分：xdp+(α, β → γ)
 * ------------------------------------------------------------------ */

/**
 * 给定 (α, β, γ) 的精确差分概率。
 * @returns {number} 计数 / 2^(2·bits)，∈ [0, 1]
 */
export function addDiffProb(bits, a, b, g) {
  const n = clampBits(bits);
  const A = u32(a) & u32(maskOfNum(n)), B = u32(b) & u32(maskOfNum(n)), G = u32(g) & u32(maskOfNum(n));
  let dp = [1, 0, 0, 0]; // (c<<1)|c'
  for (let i = 0; i < n; i++) {
    const ai = (A >>> i) & 1, bi = (B >>> i) & 1, gi = (G >>> i) & 1;
    const nd = [0, 0, 0, 0];
    for (let c = 0; c < 2; c++) {
      for (let cp = 0; cp < 2; cp++) {
        const cur = dp[(c << 1) | cp];
        if (!cur) continue;
        for (let xi = 0; xi < 2; xi++) {
          for (let yi = 0; yi < 2; yi++) {
            const xip = xi ^ ai, yip = yi ^ bi;
            const s = xi ^ yi ^ c, sp = xip ^ yip ^ cp;
            if ((s ^ sp) !== gi) continue;
            const cn = (xi & yi) | (xi & c) | (yi & c);
            const cnp = (xip & yip) | (xip & cp) | (yip & cp);
            nd[(cn << 1) | cnp] += cur;
          }
        }
      }
    }
    dp = nd;
  }
  return (dp[0] + dp[1] + dp[2] + dp[3]) / Math.pow(2, 2 * n);
}

/**
 * 给定 (α, β) 的 top-K 输出差候选（按概率降序）。
 *
 * ⚠️ 剪枝口径（必须如实标注，否则会重蹈「prob=1 假值」的覆辙）：
 *   - DP 每层状态数 ≤ `STATE_CAP` → **不剪枝、精确全枚举**，返回数组带 `exact = true`；
 *   - 否则按前缀计数 beam 剪枝（至少 `BEAM_FLOOR` 个），返回数组带 `exact = false`
 *     —— 这个分支是**启发式**，不保证 top-K 是全局最优，调用方应据此标注口径。
 *   概率本身（`prob`）始终由精确 DP 求得，问题只可能出在「候选集是否漏了更优解」。
 *
 * @returns {Array<{gamma:number, prob:number, weight:number}>} 数组另带 `exact: boolean`
 */
export function addDiffTopK(bits, a, b, K = 8) {
  const n = clampBits(bits);
  const k = Math.max(1, Math.min(4096, K | 0 || 8));
  const A = u32(a) & u32(maskOfNum(n)), B = u32(b) & u32(maskOfNum(n));
  const key = `${n}|${A}|${B}|${k}`;
  return cached(_diffCache, key, () => {
    if (A === 0 && B === 0) {
      const r = [{ gamma: 0, prob: 1, weight: 0 }];
      r.exact = true;
      return r;
    }
    let exact = true;
    let layer = [{ c: 0, cp: 0, g: 0, cnt: 1 }];
    for (let i = 0; i < n; i++) {
      const ai = (A >>> i) & 1, bi = (B >>> i) & 1;
      const acc = new Map();
      for (const st of layer) {
        for (let xi = 0; xi < 2; xi++) {
          for (let yi = 0; yi < 2; yi++) {
            const xip = xi ^ ai, yip = yi ^ bi;
            const s = xi ^ yi ^ st.c, sp = xip ^ yip ^ st.cp;
            const gi = s ^ sp;
            const cn = (xi & yi) | (xi & st.c) | (yi & st.c);
            const cnp = (xip & yip) | (xip & st.cp) | (yip & st.cp);
            const g2 = st.g | (gi << i);
            const slot = (cn << 1) | cnp;
            let inner = acc.get(slot);
            if (!inner) { inner = new Map(); acc.set(slot, inner); }
            const hit = inner.get(g2);
            if (hit) hit.cnt += st.cnt;
            else inner.set(g2, { c: cn, cp: cnp, g: g2, cnt: st.cnt });
          }
        }
      }
      const all = [];
      for (const inner of acc.values()) for (const st of inner.values()) all.push(st);
      if (all.length > STATE_CAP) {
        all.sort((p, q) => q.cnt - p.cnt);
        layer = all.slice(0, Math.max(k, BEAM_FLOOR));
        exact = false;
      } else {
        layer = all;
      }
      if (!layer.length) break;
    }
    const out = new Map();
    for (const st of layer) out.set(st.g, (out.get(st.g) || 0) + st.cnt);
    const res = [...out.entries()]
      .map(([g, cnt]) => {
        const prob = cnt / Math.pow(2, 2 * n);
        return { gamma: u32(g), prob, weight: prob > 0 ? -Math.log2(prob) : Infinity };
      })
      .sort((p, q) => q.prob - p.prob)
      .slice(0, k);
    res.exact = exact;
    return res;
  });
}

/* ------------------------------------------------------------------
 * 线性：corr(αx, αy → γ)
 * ------------------------------------------------------------------ */

/**
 * 给定 (αx, αy, γ) 的精确线性相关度。
 * @returns {number} corr ∈ {0} ∪ ±2^-k
 */
export function addLinCorr(bits, ax, ay, g) {
  const n = clampBits(bits);
  const AX = u32(ax) & u32(maskOfNum(n)), AY = u32(ay) & u32(maskOfNum(n)), G = u32(g) & u32(maskOfNum(n));
  let dp = [1, 0];
  for (let i = 0; i < n; i++) {
    const axi = (AX >>> i) & 1, ayi = (AY >>> i) & 1, gi = (G >>> i) & 1;
    const nd = [0, 0];
    for (let c = 0; c < 2; c++) {
      const val = dp[c];
      if (!val) continue;
      for (let xi = 0; xi < 2; xi++) {
        for (let yi = 0; yi < 2; yi++) {
          const s = xi ^ yi ^ c;
          const sign = ((axi & xi) ^ (ayi & yi) ^ (gi & s)) ? -1 : 1;
          const cn = (xi & yi) | (xi & c) | (yi & c);
          nd[cn] += val * sign;
        }
      }
    }
    dp = nd;
  }
  return (dp[0] + dp[1]) / Math.pow(2, 2 * n);
}

/**
 * 给定 (αx, αy) 的 top-K 输出掩码候选（按 |corr| 降序）。
 *
 * 剪枝口径与 `addDiffTopK` 一致：状态数 ≤ `STATE_CAP` 时精确全枚举
 * （返回数组带 `exact = true`），否则 beam 启发式（`exact = false`）。
 *
 * @returns {Array<{gamma:number, corr:number, prob:number, weight:number}>}
 *          prob = corr²（引擎逐节点累乘的口径）；weight = −log₂corr²
 */
export function addLinTopK(bits, ax, ay, K = 8) {
  const n = clampBits(bits);
  const k = Math.max(1, Math.min(4096, K | 0 || 8));
  const AX = u32(ax) & u32(maskOfNum(n)), AY = u32(ay) & u32(maskOfNum(n));
  const key = `${n}|${AX}|${AY}|${k}`;
  return cached(_linCache, key, () => {
    if (AX === 0 && AY === 0) {
      const r = [{ gamma: 0, corr: 1, prob: 1, weight: 0 }];
      r.exact = true;
      return r;
    }
    let exact = true;
    let layer = [{ c: 0, g: 0, val: 1 }];
    for (let i = 0; i < n; i++) {
      const axi = (AX >>> i) & 1, ayi = (AY >>> i) & 1;
      const acc = new Map();
      for (const st of layer) {
        for (let xi = 0; xi < 2; xi++) {
          for (let yi = 0; yi < 2; yi++) {
            const s = xi ^ yi ^ st.c;
            const cn = (xi & yi) | (xi & st.c) | (yi & st.c);
            let inner = acc.get(cn);
            if (!inner) { inner = new Map(); acc.set(cn, inner); }
            for (let gbit = 0; gbit < 2; gbit++) {
              const sign = ((axi & xi) ^ (ayi & yi) ^ (gbit & s)) ? -1 : 1;
              const g2 = st.g | (gbit << i);
              const hit = inner.get(g2);
              if (hit) hit.val += st.val * sign;
              else inner.set(g2, { c: cn, g: g2, val: st.val * sign });
            }
          }
        }
      }
      const all = [];
      for (const inner of acc.values()) for (const st of inner.values()) all.push(st);
      if (all.length > STATE_CAP) {
        all.sort((p, q) => Math.abs(q.val) - Math.abs(p.val));
        layer = all.slice(0, Math.max(k, BEAM_FLOOR));
        exact = false;
      } else {
        layer = all;
      }
      if (!layer.length) break;
    }
    const merged = new Map();
    for (const st of layer) merged.set(st.g, (merged.get(st.g) || 0) + st.val);
    const denom = Math.pow(2, 2 * n);
    const res = [...merged.entries()]
      .map(([g, s]) => {
        const corr = s / denom;
        const prob = corr * corr;
        return { gamma: u32(g), corr, prob, weight: prob > 0 ? -Math.log2(prob) : Infinity };
      })
      .sort((p, q) => Math.abs(q.corr) - Math.abs(p.corr))
      .slice(0, k)
      .filter((o) => Math.abs(o.corr) > 0);
    if (!res.length) {
      // 剪枝把非零候选全丢了 → 退回「候选 γ = αx⊕αy」这个单点精确值，
      // 宁可给一个诚实的 0，也不伪造一个非零相关度。
      const g0 = u32(AX ^ AY);
      const c0 = addLinCorr(n, AX, AY, g0);
      res.push({ gamma: g0, corr: c0, prob: c0 * c0, weight: c0 ? -Math.log2(c0 * c0) : Infinity });
    }
    res.exact = exact;
    return res;
  });
}

/* ------------------------------------------------------------------
 * 工具
 * ------------------------------------------------------------------ */

/** n 位的掩码（n ≤ 32）。n = 32 时返回 0xFFFFFFFF。 */
export function maskOfNum(n) {
  const k = clampBits(n);
  return k >= 32 ? 0xFFFFFFFF : ((1 << k) - 1) >>> 0;
}

/** 32 位字宽的 maskOf，供引擎直接复用（避免各处各写一份）。 */
export const MASK32 = 0xFFFFFFFF;
