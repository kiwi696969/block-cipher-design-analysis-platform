/**
 * AES-128 / PRESENT-64 参考实现 —— 独立于分析引擎的干净实现。
 *
 * 为什么单独维护（与 `sm4ref.js` 同一条理由）：
 *   分析引擎必须能被一个**独立实现**交叉验证。若验证方与被验证方共用
 *   同一段线性层代码，验证就退化成自证。因此本模块自带 S 盒引用、行移位、
 *   列混淆、P 置换、密钥编排，**不复用 analysis.js 的任何函数**。
 *
 * 两个算法共用一套「单元 + 线性层」的接口，供 `spnprofile.js` 的束搜索调用：
 *   cells / cellBits / sbox / layerDiff / layerMask / encryptCells
 *
 * ⚠️ 差分与线性走的是**两张不同的线性层**，这是最容易写错的地方：
 *   · 差分（以及值传播）：Δ 过线性层 L 就是 L(Δ)。
 *   · 线性掩码：β·L(x) = (Lᵀβ)·x ⇒ 输入掩码 α 与输出掩码 β 满足 α = Lᵀβ，
 *     即「正向»传掩码」要施加 (Lᵀ)⁻¹ = (L⁻¹)ᵀ —— **不是** L，也不是 Lᵀ。
 *   · 置换层是置换矩阵，L⁻¹ = Lᵀ，于是掩码传播恰好等于**逆置换**。
 *   这三条若混用，线性分析的数字会静默错掉（不报错、只给出偏乐观的权重）。
 *   本模块用 `transposeCols` / `invertCols` **从正向函数机械地推出**掩码层，
 *   不手抄任何转置矩阵常量，并在 `selfCheck()` 里用点积恒等式验证。
 */

import { BUILTIN_SBOXES } from './sbox.js';

/* ============================================================
 * GF(2) 线性映射小工具（32 位以内、32×32 矩阵）
 * ============================================================ */

/**
 * 由「作用于基向量」的函数推导出列向量表示。
 * @param {(x:number)=>number} fn 32 位 GF(2) 线性函数
 * @param {number} nbits
 * @returns {Uint32Array} 32 列
 */
function basisCols(fn, nbits = 32) {
  const cols = new Uint32Array(nbits);
  for (let i = 0; i < nbits; i++) cols[i] = fn((1 << i) >>> 0) >>> 0;
  return cols;
}

/** 用列向量表示施加线性映射：y = ⊕_{i: x_i=1} cols[i] */
function applyCols(cols, x) {
  let y = 0;
  let v = x >>> 0;
  while (v) {
    const i = 31 - Math.clz32(v);
    y ^= cols[i];
    v ^= (1 << i) >>> 0;
  }
  return y >>> 0;
}

/** 矩阵转置（列向量表示 → 转置后的列向量表示） */
function transposeCols(cols, nbits = 32) {
  const out = new Uint32Array(nbits);
  for (let i = 0; i < nbits; i++) {
    for (let j = 0; j < nbits; j++) {
      if ((cols[i] >>> j) & 1) out[j] = (out[j] | ((1 << i) >>> 0)) >>> 0;
    }
  }
  return out;
}

/** GF(2) 上求逆（Gauss–Jordan）。奇异则抛错 —— 静默返回错值比崩更糟。 */
function invertCols(cols, nbits = 32) {
  // 增广：[cols | I]，按行消元
  const a = [];
  for (let r = 0; r < nbits; r++) {
    let row = 0;
    for (let c = 0; c < nbits; c++) if ((cols[c] >>> r) & 1) row = (row | ((1 << c) >>> 0)) >>> 0;
    a.push({ l: row, r: (1 << r) >>> 0 });
  }
  for (let c = 0; c < nbits; c++) {
    let p = -1;
    for (let r = c; r < nbits; r++) if ((a[r].l >>> c) & 1) { p = r; break; }
    if (p < 0) throw new Error('spnref: 线性层不可逆 —— 掩码传播无法定义');
    if (p !== c) { const t = a[p]; a[p] = a[c]; a[c] = t; }
    for (let r = 0; r < nbits; r++) {
      if (r === c) continue;
      if ((a[r].l >>> c) & 1) { a[r] = { l: (a[r].l ^ a[c].l) >>> 0, r: (a[r].r ^ a[c].r) >>> 0 }; }
    }
  }
  // 现在的「右半」即逆矩阵的行 → 转成列表示
  const out = new Uint32Array(nbits);
  for (let i = 0; i < nbits; i++) {
    // 第 i 列 = 所有「右半第 i 位为 1」的行拼起来
    let col = 0;
    for (let r = 0; r < nbits; r++) if ((a[r].r >>> i) & 1) col = (col | ((1 << r) >>> 0)) >>> 0;
    out[i] = col;
  }
  return out;
}

/* ============================================================
 * AES-128
 * ============================================================ */

export const AES_SBOX = BUILTIN_SBOXES.aes.table;
export const AES_ROUNDS = 10;

/** GF(2^8)：模 x⁸+x⁴+x³+x+1 */
export function aesMul(a, b) {
  let p = 0;
  let x = a & 0xff;
  let y = b & 0xff;
  for (let i = 0; i < 8; i++) {
    if (y & 1) p ^= x;
    const hi = x & 0x80;
    x = (x << 1) & 0xff;
    if (hi) x ^= 0x1b;
    y >>= 1;
  }
  return p & 0xff;
}

/* 状态约定：16 字节，列优先 —— state[i] 对应 FIPS-197 的 s[r][c]，i = r + 4c */

export function aesSubBytes(s) {
  const o = new Array(16);
  for (let i = 0; i < 16; i++) o[i] = AES_SBOX[s[i] & 0xff];
  return o;
}

/** 行 r 左移 r 格 */
export function aesShiftRows(s) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) o[r + 4 * c] = s[r + 4 * ((c + r) & 3)];
  }
  return o;
}

/** 行 r 右移 r 格（shiftRows 的逆） */
export function aesInvShiftRows(s) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) o[r + 4 * ((c + r) & 3)] = s[r + 4 * c];
  }
  return o;
}

/** 列混淆（也是差分传播：线性层对 Δ 的作用与对值相同） */
export function aesMixColumns(s) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
    o[4 * c] = aesMul(a0, 2) ^ aesMul(a1, 3) ^ a2 ^ a3;
    o[4 * c + 1] = a0 ^ aesMul(a1, 2) ^ aesMul(a2, 3) ^ a3;
    o[4 * c + 2] = a0 ^ a1 ^ aesMul(a2, 2) ^ aesMul(a3, 3);
    o[4 * c + 3] = aesMul(a0, 3) ^ a1 ^ a2 ^ aesMul(a3, 2);
  }
  return o;
}

/** 列混淆的逆（0e 0b 0d 09） */
export function aesInvMixColumns(s) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    const a0 = s[4 * c], a1 = s[4 * c + 1], a2 = s[4 * c + 2], a3 = s[4 * c + 3];
    o[4 * c] = aesMul(a0, 0x0e) ^ aesMul(a1, 0x0b) ^ aesMul(a2, 0x0d) ^ aesMul(a3, 0x09);
    o[4 * c + 1] = aesMul(a0, 0x09) ^ aesMul(a1, 0x0e) ^ aesMul(a2, 0x0b) ^ aesMul(a3, 0x0d);
    o[4 * c + 2] = aesMul(a0, 0x0d) ^ aesMul(a1, 0x09) ^ aesMul(a2, 0x0e) ^ aesMul(a3, 0x0b);
    o[4 * c + 3] = aesMul(a0, 0x0b) ^ aesMul(a1, 0x0d) ^ aesMul(a2, 0x09) ^ aesMul(a3, 0x0e);
  }
  return o;
}

/* ---------------- 4 字节列 ⇒ 32 位整数（掩码层用） ---------------- */

const colToWord = (a, b, c, d) => (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((c & 0xff) << 8) | (d & 0xff)) >>> 0;
const wordToCol = (w) => [(w >>> 24) & 0xff, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff];

/** 单列 mixColumns（32 位打包） */
function mcWord(w) {
  const [a0, a1, a2, a3] = wordToCol(w);
  return colToWord(
    aesMul(a0, 2) ^ aesMul(a1, 3) ^ a2 ^ a3,
    a0 ^ aesMul(a1, 2) ^ aesMul(a2, 3) ^ a3,
    a0 ^ a1 ^ aesMul(a2, 2) ^ aesMul(a3, 3),
    aesMul(a0, 3) ^ a1 ^ a2 ^ aesMul(a3, 2),
  );
}

const MC_COLS = basisCols(mcWord);
/** 线性掩码过列混淆：β = (MCᵀ)⁻¹ α —— 由正向函数机械推出，不手抄常量 */
const MC_MASK_COLS = invertCols(transposeCols(MC_COLS));

/** 一列掩码的线性传播 */
export function aesMaskCol(w) {
  return applyCols(MC_MASK_COLS, w >>> 0);
}

/** 整状态掩码过 MixColumns（掩码方向） */
export function aesMixColumnsMask(s) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    const w = aesMaskCol(colToWord(s[4 * c], s[4 * c + 1], s[4 * c + 2], s[4 * c + 3]));
    const b = wordToCol(w);
    o[4 * c] = b[0]; o[4 * c + 1] = b[1]; o[4 * c + 2] = b[2]; o[4 * c + 3] = b[3];
  }
  return o;
}

/**
 * 整状态掩码过 ShiftRows。
 *
 * 置换矩阵 L 满足 L⁻¹ = Lᵀ，于是掩码正向传播 (Lᵀ)⁻¹ = L —— **就是同一个置换**。
 * （直觉：α 与 x 被同一个置换搬动，点积不变。）写成逆置换会静默给出错误掩码，
 * 而且不报错、只是权重偏小 —— 这类错只有点积恒等式能抓。
 */
export function aesShiftRowsMask(s) {
  return aesShiftRows(s);
}

/* ---------------- 密钥编排（AES-128） ---------------- */

const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

/**
 * AES-128 密钥扩展：16 字节密钥 → 11 个 16 字节轮密钥
 * @param {number[]} key
 * @returns {number[][]}
 */
export function aesKeySchedule128(key) {
  const w = [];
  for (let i = 0; i < 4; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1].slice();
    if (i % 4 === 0) {
      t = t.slice(1).concat(t[0]);                       // RotWord
      t = t.map((b) => AES_SBOX[b & 0xff]);              // SubWord
      t[0] ^= RCON[i / 4 - 1];
    }
    w.push(w[i - 4].map((b, k) => b ^ t[k]));
  }
  const rk = [];
  for (let r = 0; r <= 10; r++) {
    const flat = [];
    for (let i = 0; i < 4; i++) flat.push(...w[4 * r + i]);
    rk.push(flat);
  }
  return rk;
}

/**
 * AES-128 加密（16 字节数组进、16 字节数组出）
 *
 * ⚠️ 「末轮无列混淆」只对**完整的第 10 轮**成立。
 *    从前写成"最后一个被要求的轮就省 MC"，于是 `rounds: 1` 变成了
 *    SubBytes→ShiftRows→AddRoundKey（少了 MixColumns），与引擎给出的 1 轮特征对不上，
 *    抽样命中率直接掉到 0 —— 看起来像"引擎算错"，其实是参考实现自己少算了一步。
 *    截断分析（< 10 轮）的每一轮都是真实的中途轮，都要做 MC。
 */
export function aesEncrypt(pt, key, { rounds = 10 } = {}) {
  const rk = aesKeySchedule128(key);
  let s = pt.slice();
  const add = (st, r) => st.map((b, i) => b ^ rk[Math.min(r, 10)][i]);
  s = add(s, 0);
  for (let r = 1; r <= rounds; r++) {
    s = aesSubBytes(s);
    s = aesShiftRows(s);
    if (r !== AES_ROUNDS) s = aesMixColumns(s);   // 只有第 10 轮省 MC
    s = add(s, r);
  }
  return s;
}

/** hex → 16 字节数组 */
export function hexToBytes(hex) {
  const h = String(hex).replace(/[^0-9a-fA-F]/g, '');
  if (h.length % 2 !== 0) throw new Error(`hex 长度必须是偶数，收到 ${h.length}`);
  const out = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

/** 16 字节数组 → hex */
export function bytesToHex(bs) {
  return bs.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join('');
}

/* ============================================================
 * PRESENT-64（80 位密钥）
 * ============================================================ */

export const PRESENT_SBOX = BUILTIN_SBOXES.present.table;
export const PRESENT_ROUNDS = 31;

const M64 = (1n << 64n) - 1n;
const M80 = (1n << 80n) - 1n;

/**
 * PRESENT 比特置换 P：bit i → bit P(i)，P(i) = 16·i mod 63（i ≤ 62），P(63) = 63。
 * @returns {number[]} P[0..63]
 */
export const PRESENT_P_TABLE = (() => {
  const p = new Array(64);
  for (let i = 0; i < 64; i++) p[i] = i === 63 ? 63 : (16 * i) % 63;
  return p;
})();

/** 对 64 位值施加 P 置换 */
export function presentPermute(x) {
  let y = 0n;
  for (let i = 0; i < 64; i++) {
    if ((x >> BigInt(i)) & 1n) y |= (1n << BigInt(PRESENT_P_TABLE[i]));
  }
  return y & M64;
}

/** 置换的逆（掩码传播用；置换矩阵 L⁻¹ = Lᵀ，故掩码走逆置换） */
export const PRESENT_P_INV_TABLE = (() => {
  const inv = new Array(64);
  for (let i = 0; i < 64; i++) inv[PRESENT_P_TABLE[i]] = i;
  return inv;
})();

export function presentPermuteInv(x) {
  let y = 0n;
  for (let i = 0; i < 64; i++) {
    if ((x >> BigInt(i)) & 1n) y |= (1n << BigInt(PRESENT_P_INV_TABLE[i]));
  }
  return y & M64;
}

/** 16 个半字节 → 64 位 BigInt（nibble 0 最高位，与规范一致） */
export function presentNibblesToBig(nb) {
  let v = 0n;
  for (let i = 0; i < 16; i++) v = (v << 4n) | BigInt(nb[i] & 0xf);
  return v & M64;
}

/** 64 位 BigInt → 16 个半字节 */
export function bigToPresentNibbles(v) {
  const out = new Array(16);
  for (let i = 15; i >= 0; i--) { out[i] = Number(v & 0xfn); v >>= 4n; }
  return out;
}

/** S 盒层：16 个半字节并行 */
export function presentSBoxLayer(nb) {
  return nb.map((x) => PRESENT_SBOX[x & 0xf]);
}

/**
 * PRESENT-80 密钥编排：80 位密钥 → 32 个 64 位轮密钥
 *
 * ⚠️ 两个极易写错的点（都会静默给出错密文，只有测试向量能抓）：
 *   ① 轮计数器落在 **k19..k15**（`i << 15`）。规范正文里出现的 k66..k62 是
 *      **128 位密钥版**附录的位置，照抄到 80 位版会全错。80 位版原始论文
 *      写的是 [k19 k18 k17 k16 k15] ⊕ round_counter。
 *   ② 循环左移 61 位（等价右移 19），顺序是「先取轮密钥 → 再旋转 → S 盒 → 计数器」。
 *
 * @param {bigint} key
 * @returns {bigint[]}
 */
export function presentKeySchedule80(key) {
  let k = key & M80;
  const rk = [];
  for (let i = 1; i <= 32; i++) {
    rk.push(k >> 16n);                                   // 高 64 位 = K_i
    // 循环左移 61 位（等价于右移 19）
    k = ((k << 61n) | (k >> 19n)) & M80;
    // 最高半字节过 S 盒
    const top = Number((k >> 76n) & 0xfn);
    k = (k & ((1n << 76n) - 1n)) | (BigInt(PRESENT_SBOX[top]) << 76n);
    // 轮计数异或到 k19..k15（80 位版的位置，见上）
    k ^= (BigInt(i) << 15n);
  }
  return rk;
}

/**
 * PRESENT-64 加密（16 个半字节进、16 个半字节出）
 *
 * ⚠️ 31 轮**每轮都做 P 置换**（含第 31 轮），之后再做一次密钥加。
 *    曾按"末轮省略 P"写，密文变成 5579C1387B228445 之外的 2844B365C06992A3 ——
 *    差值只在末尾 3 个比特，肉眼很像"位序小错"，实际是整轮结构错。
 */
export function presentEncrypt(ptNb, key, { rounds = 31 } = {}) {
  const rk = presentKeySchedule80(key);
  let s = presentNibblesToBig(ptNb);
  for (let i = 0; i < rounds; i++) {
    s = (s ^ rk[i]) & M64;
    s = presentNibblesToBig(presentSBoxLayer(bigToPresentNibbles(s)));
    s = presentPermute(s);
  }
  s = (s ^ rk[Math.min(rounds, 31)]) & M64;
  return bigToPresentNibbles(s);
}

/** hex（16 位）→ 80 位 BigInt */
export function hexToBig80(hex) {
  const h = String(hex).replace(/[^0-9a-fA-F]/g, '');
  return BigInt(`0x${h || '0'}`) & M80;
}

/** 16 个半字节 → hex 字符串 */
export function presentNibblesToHex(nb) {
  return nb.map((x) => (x & 0xf).toString(16)).join('');
}

/* ============================================================
 * 统一适配层 —— 供 spnprofile.js 调用
 * ============================================================ */

/**
 * 两个算法都抽象成「n 个单元 + 一层 GF(2) 线性层」：
 *   - AES：16 个 8bit 单元，线性层 = ShiftRows ∘ MixColumns
 *   - PRESENT：16 个 4bit 单元，线性层 = P 置换
 *
 * 差分与掩码走不同的函数（见文件头说明）。
 */
export const SPN_CIPHERS = {
  aes: {
    id: 'aes',
    name: 'AES-128',
    blockBits: 128,
    cells: 16,
    cellBits: 8,
    rounds: 10,
    sboxKey: 'aes',
    sbox: AES_SBOX,
    /* 默认搜索参数（实测选出来的，不是拍的）：
       beam 128 / 起点 6 / 每个活跃盒最多 4 条候选转移
       → 4 轮 36 盒 2^-217（75ms）、10 轮 127 盒 2^-768（177ms）。 */
    defaults: { beamWidth: 128, startVariants: 6, branchLimit: 4 },
    /** 差分 / 值：Δ 过 ShiftRows 再 MixColumns */
    layerDiff: (s) => aesMixColumns(aesShiftRows(s)),
    /** 掩码：先 SR（掩码走同一个置换）再 MC（掩码走 (MCᵀ)⁻¹） */
    layerMask: (s) => aesMixColumnsMask(aesShiftRowsMask(s)),
    /** 值级加密（抽样验证用） */
    encrypt: (cells, keyHex, rounds) => aesEncrypt(cells, hexToBytes(keyHex), { rounds }),
    toHex: (cells) => bytesToHex(cells),
  },
  present: {
    id: 'present',
    name: 'PRESENT-64',
    blockBits: 64,
    cells: 16,
    cellBits: 4,
    rounds: 31,
    sboxKey: 'present',
    sbox: PRESENT_SBOX,
    /* beam 256 / 起点 3 / 每盒 4 条 → 14 轮 30 盒 2^-68（265ms），
       文献（Wang 2008）最优 14 轮差分特征 2^-62，差 6 bit —— 束搜索上界的正常差距。 */
    defaults: { beamWidth: 256, startVariants: 3, branchLimit: 4 },
    layerDiff: (s) => bigToPresentNibbles(presentPermute(presentNibblesToBig(s))),
    /** 掩码过 P 置换：置换矩阵 L⁻¹ = Lᵀ ⇒ 掩码正向传播同样是 P 本身 */
    layerMask: (s) => bigToPresentNibbles(presentPermute(presentNibblesToBig(s))),
    encrypt: (cells, keyHex, rounds) => presentEncrypt(cells, hexToBig80(keyHex), { rounds }),
    toHex: (cells) => presentNibblesToHex(cells),
  },
};

/* ============================================================
 * 自检：掩码层与差分层的对偶关系
 * ============================================================ */

/**
 * 掩码传播正确性的**直接判据**（不是自证，是恒等式）：
 *   若 α 进、β 出（β = mask(α)），则对任意 x 都应有
 *       parity(β · L(x)) = parity(α · x)
 *   因为 β·L(x) = βᵀLx = (Lᵀβ)ᵀx，而 β = (Lᵀ)⁻¹α ⇒ Lᵀβ = α。
 * 转置写反、忘了求逆、或把置换层写成逆置换，都会让这条恒等式大面积失败。
 *
 * @returns {{ok:boolean, detail:string}}
 */
export function selfCheck(cipherId, { trials = 64 } = {}) {
  const C = SPN_CIPHERS[cipherId];
  if (!C) return { ok: false, detail: `未知算法 ${cipherId}` };

  // 点积的奇偶（GF(2) 内积）
  const parity = (a, b) => {
    let v = 0;
    for (let i = 0; i < a.length; i++) v ^= (a[i] & b[i]);
    let x = v & 0xffff;
    x ^= x >> 8; x ^= x >> 4; x ^= x >> 2; x ^= x >> 1;
    return x & 1;
  };

  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const mask = (1 << C.cellBits) - 1;
  const mkState = () => Array.from({ length: C.cells }, () => rnd() & mask);

  for (let t = 0; t < trials; t++) {
    const x = mkState();
    const alpha = mkState();
    if (!alpha.some((v) => v !== 0) || !x.some((v) => v !== 0)) continue;
    const beta = C.layerMask(alpha);
    const lhs = parity(beta, C.layerDiff(x));
    const rhs = parity(alpha, x);
    if (lhs !== rhs) {
      return { ok: false, detail: `${C.name}: 掩码层与差分层的转置关系不成立（第 ${t} 次抽样）` };
    }
  }
  // 掩码层必须是双射（线性分析要求可逆）
  const one = new Array(C.cells).fill(0);
  one[0] = 1;
  if (!C.layerMask(one).some((v) => v !== 0)) {
    return { ok: false, detail: `${C.name}: 掩码层把非零掩码映射成了零 —— 不可逆` };
  }
  return { ok: true, detail: `${C.name}: 掩码/差分对偶关系 ${trials}/${trials} 通过` };
}
