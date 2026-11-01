/**
 * SM4 参考实现（GB/T 32907-2016）—— 独立于分析引擎的干净实现。
 *
 * 为什么要单独维护一份"参考实现"：
 *   平台的差分/线性分析引擎必须能被一个**独立实现**交叉验证。
 *   如果验证方和被验证方共用同一段线性变换代码，验证就失去了意义。
 *   因此本模块自带 τ / L / L′，**不复用 analysis.js 的任何函数**。
 *
 * 使用者：引擎自检（app.js）、命令行工具（cipherlab.mjs）、测试套件（tests/*.mjs）。
 *
 * ⚠️ 实现 SM4 最常见的坑：密钥扩展用 T′ = L′(τ(·))，数据加密用 T = L(τ(·))。
 *    两者线性层不同（L′ 只有两个异或项，L 有四个），写反则轮密钥全错。
 */

import { BUILTIN_SBOXES } from './sbox.js';

const FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc];

/** 32 位循环左移 */
export function sm4Rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** τ：4 个并行 8bit S 盒（大端组装） */
export function sm4Tau(a, SMT = BUILTIN_SBOXES.sm4.table) {
  return (((SMT[(a >>> 24) & 0xff] << 24) |
    (SMT[(a >>> 16) & 0xff] << 16) |
    (SMT[(a >>> 8) & 0xff] << 8) |
    SMT[a & 0xff]) >>> 0);
}

/** L：加密轮函数的线性扩散层  L(B) = B ⊕ (B≪2) ⊕ (B≪10) ⊕ (B≪18) ⊕ (B≪24) */
export function sm4LinearL(B) {
  return (B ^ sm4Rotl(B, 2) ^ sm4Rotl(B, 10) ^ sm4Rotl(B, 18) ^ sm4Rotl(B, 24)) >>> 0;
}

/** L′：密钥扩展的线性扩散层  L′(B) = B ⊕ (B≪13) ⊕ (B≪23)  —— 注意与 L 不同 */
export function sm4LinearLp(B) {
  return (B ^ sm4Rotl(B, 13) ^ sm4Rotl(B, 23)) >>> 0;
}

/** T  = L ∘ τ（加密用） */
export function sm4T(a, SMT) {
  return sm4LinearL(sm4Tau(a >>> 0, SMT));
}

/** T′ = L′ ∘ τ（密钥扩展用） */
export function sm4Tp(a, SMT) {
  return sm4LinearLp(sm4Tau(a >>> 0, SMT));
}

/** 系统参数 CK_i */
export function sm4Ck(i) {
  return (((((4 * i + 0) * 7) % 256) << 24) |
    ((((4 * i + 1) * 7) % 256) << 16) |
    ((((4 * i + 2) * 7) % 256) << 8) |
    (((4 * i + 3) * 7) % 256)) >>> 0;
}

/**
 * 密钥扩展：MK(4×32bit) → 32 个轮密钥
 * K_i 递推：K_{i+4} = K_i ⊕ T′(K_{i+1} ⊕ K_{i+2} ⊕ K_{i+3} ⊕ CK_i)
 */
export function sm4KeySchedule(mk, SMT) {
  const K = [0, 1, 2, 3].map(i => ((mk[i] >>> 0) ^ FK[i]) >>> 0);
  const rk = [];
  for (let i = 0; i < 32; i++) {
    const k4 = ((K[i] ^ sm4Tp((K[i + 1] ^ K[i + 2] ^ K[i + 3] ^ sm4Ck(i)) >>> 0, SMT)) >>> 0);
    K.push(k4);
    rk.push(k4);
  }
  return rk;
}

/**
 * 加密：pt(4×32bit) → ct(4×32bit)
 * X_{i+4} = X_i ⊕ T(X_{i+1} ⊕ X_{i+2} ⊕ X_{i+3} ⊕ rk_i)
 * 输出反序：(X35, X34, X33, X32)
 */
export function sm4Encrypt(pt, rk, { rounds = 32, sbox } = {}) {
  const SMT = sbox ? sbox.table : undefined;
  const X = [(pt[0] >>> 0), (pt[1] >>> 0), (pt[2] >>> 0), (pt[3] >>> 0)];
  for (let i = 0; i < rounds; i++) {
    X.push((X[i] ^ sm4T((X[i + 1] ^ X[i + 2] ^ X[i + 3] ^ (rk[i] >>> 0)) >>> 0, SMT)) >>> 0);
  }
  return [X[rounds + 3], X[rounds + 2], X[rounds + 1], X[rounds]];
}

/**
 * 解密：白皮书定义的逆序使用轮密钥（rk 反序），结构同加密。
 * 因为 SM4 是 Feistel 变体（XTEA 型），解密变换与加密完全相同。
 */
export function sm4Decrypt(ct, rk, opts = {}) {
  return sm4Encrypt(ct, rk.slice().reverse(), opts);
}

/* ---------------- hex 便捷封装 ---------------- */

/** "0123456789abcdef..." → [w0,w1,w2,w3] */
export function hexToWords(hex) {
  const h = String(hex).replace(/[^0-9a-fA-F]/g, '');
  if (h.length % 8 !== 0) throw new Error(`hex 长度必须是 8 的倍数（32bit 字的整数倍），收到 ${h.length} 个字符`);
  const out = [];
  for (let i = 0; i < h.length; i += 8) out.push(parseInt(h.slice(i, i + 8), 16) >>> 0);
  return out;
}

/** [w0,w1,w2,w3] → 小写 hex（每字 8 位补零） */
export function wordsToHex(ws) {
  return ws.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * 高层封装：hex 明文 + hex 密钥 → hex 密文
 * 例：sm4EncryptHex('0123456789abcdeffedcba9876543210', '0123456789abcdeffedcba9876543210')
 *     → '681edf34d206965e86b3e94f536e4246'
 */
export function sm4EncryptHex(ptHex, keyHex, opts = {}) {
  const rk = sm4KeySchedule(hexToWords(keyHex));
  return wordsToHex(sm4Encrypt(hexToWords(ptHex), rk, opts));
}

/** 高层封装：hex 密文 + hex 密钥 → hex 明文 */
export function sm4DecryptHex(ctHex, keyHex, opts = {}) {
  const rk = sm4KeySchedule(hexToWords(keyHex));
  return wordsToHex(sm4Decrypt(hexToWords(ctHex), rk, opts));
}

/** 反复加密 count 次（用于验证国标"百万次迭代"向量） */
export function sm4IterateHex(ptHex, keyHex, count) {
  const rk = sm4KeySchedule(hexToWords(keyHex));
  let cur = hexToWords(ptHex);
  for (let i = 0; i < count; i++) cur = sm4Encrypt(cur, rk);
  return wordsToHex(cur);
}

/** 轮密钥 hex 数组 */
export function sm4RoundKeyHexs(keyHex) {
  return sm4KeySchedule(hexToWords(keyHex)).map(v => (v >>> 0).toString(16).padStart(8, '0'));
}

/** 全部中间状态字 X0..X35（X0..X3 为明文，X35 为密文首字） */
export function sm4StateTrace(ptHex, keyHex) {
  const rk = sm4KeySchedule(hexToWords(keyHex));
  const pt = hexToWords(ptHex);
  const X = [pt[0] >>> 0, pt[1] >>> 0, pt[2] >>> 0, pt[3] >>> 0];
  for (let i = 0; i < 32; i++) {
    X.push((X[i] ^ sm4T((X[i + 1] ^ X[i + 2] ^ X[i + 3] ^ rk[i]) >>> 0)) >>> 0);
  }
  return X;
}
