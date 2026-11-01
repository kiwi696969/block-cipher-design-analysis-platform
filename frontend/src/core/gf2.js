/* ============================================================
 * GF(2) 有限域与位运算基础库
 * 分组密码差分/线性分析平台 - 核心数学工具
 * ============================================================ */

export const MASK32 = 0xFFFFFFFF;

/** 位宽掩码 */
export function maskOf(bits) {
  if (bits >= 32) return MASK32;
  return (1 << bits) - 1;
}

/** 权重：汉明重量（二进制 1 的个数） */
export function hw(x) {
  x = x >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0F0F0F0F;
  return (x * 0x01010101) >>> 24;
}

/** 按位宽计算汉明重量 */
export function hwN(x, bits) {
  return hw(x & maskOf(bits));
}

/** 若干 4bit 半字节的活跃计数（S盒分析用） */
export function activeNibbles(x, bits) {
  let c = 0;
  for (let i = 0; i < bits; i += 4) if ((x >>> i) & 0xF) c++;
  return c;
}

/** 活跃比特位置列表 */
export function bitPositions(x, bits) {
  const out = [];
  for (let i = 0; i < bits; i++) if ((x >>> i) & 1) out.push(i);
  return out;
}

/** 取 x 的第 i 个 4bit 半字节 */
export function nibble(x, i) {
  return (x >>> (i * 4)) & 0xF;
}

/** 由半字节数组组装整数 */
export function fromNibbles(arr) {
  let v = 0;
  for (let i = 0; i < arr.length; i++) v |= (arr[i] & 0xF) << (i * 4);
  return v >>> 0;
}

/** 整数拆成半字节数组（长度 n） */
export function toNibbles(x, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = nibble(x, i);
  return out;
}

/** 循环左移 */
export function rotl(x, n, bits) {
  const m = maskOf(bits);
  x &= m;
  n %= bits;
  if (n === 0) return x >>> 0;
  return (((x << n) | (x >>> (bits - n))) & m) >>> 0;
}

/** 循环右移 */
export function rotr(x, n, bits) {
  return rotl(x, bits - (n % bits), bits);
}

/** 可逆线性变换的逆（针对 GF(2) 上矩阵） */
export function invertMatrixGF2(matrix, n) {
  // matrix: n x n 数组，matrix[i] 是第 i 行的 n 位整数
  const a = matrix.slice();
  const inv = [];
  for (let i = 0; i < n; i++) inv[i] = 1 << i;

  for (let col = 0; col < n; col++) {
    // 寻找主元
    let piv = -1;
    for (let r = col; r < n; r++) {
      if ((a[r] >>> col) & 1) { piv = r; break; }
    }
    if (piv < 0) return null; // 不可逆
    if (piv !== col) {
      [a[col], a[piv]] = [a[piv], a[col]];
      [inv[col], inv[piv]] = [inv[piv], inv[col]];
    }
    for (let r = 0; r < n; r++) {
      if (r !== col && ((a[r] >>> col) & 1)) {
        a[r] ^= a[col];
        inv[r] ^= inv[col];
      }
    }
  }
  return inv;
}

/** 矩阵转置（按 bit 表示） */
export function transposeMatrixGF2(matrix, n) {
  const out = new Array(n).fill(0);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if ((matrix[r] >>> c) & 1) out[c] |= (1 << r);
    }
  }
  return out;
}

/** 按矩阵作用：out_bit_i = parity(row_i & x) */
export function applyMatrixGF2(matrix, x) {
  let out = 0;
  for (let i = 0; i < matrix.length; i++) {
    out |= (hw(matrix[i] & x) & 1) << i;
  }
  return out >>> 0;
}

/** 生成随机的 GF(2) 可逆矩阵 */
export function randomInvertibleMatrix(n, rng) {
  const m = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    m[i] = (1 << i) | ((rng() & maskOf(n - 1)) & ~(1 << i));
  }
  return m;
}

/** 简易可复现随机数（xorshift32），便于分析结果复现 */
export function makeRng(seed) {
  let s = seed >>> 0 || 0x9E3779B9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
}

/** log2 向下取整 */
export function log2i(x) {
  if (x <= 0) return 0;
  let r = 0;
  while ((1 << r) < x) r++;
  return r;
}

/** 排列置换：按位映射 p（p[i] = 输入位 i 的输出位置） */
export function applyBitPermutation(x, p, bits) {
  let out = 0;
  for (let i = 0; i < bits; i++) {
    if ((x >>> i) & 1) out |= (1 << p[i]);
  }
  return out >>> 0;
}

/** 位旋转/字节置换等常用线性层 */
export function byteSub(x, bits, from, to) {
  // 以 8bit 为单位重排
  const bytes = bits / 8;
  let out = 0;
  for (let i = 0; i < bytes; i++) {
    const b = (x >>> (i * 8)) & 0xFF;
    out |= b << ((from[i % from.length] ?? i) * 8);
  }
  return out >>> 0;
}
