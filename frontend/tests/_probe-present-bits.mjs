/* 临时：PRESENT 轮计数器移位位置验证（15 vs 62） */
import { BUILTIN_SBOXES } from '../src/core/sbox.js';

const S = BUILTIN_SBOXES.present.table;
const M64 = (1n << 64n) - 1n, M80 = (1n << 80n) - 1n;
const P1 = Array.from({ length: 64 }, (_, i) => (i === 63 ? 63 : (16 * i) % 63));

const perm = (x, P) => {
  let y = 0n;
  for (let i = 0; i < 64; i++) if ((x >> BigInt(i)) & 1n) y |= (1n << BigInt(P[i]));
  return y & M64;
};

function ks(key, sh) {
  let k = key & M80;
  const rk = [];
  for (let i = 1; i <= 32; i++) {
    rk.push(k >> 16n);
    k = ((k << 61n) | (k >> 19n)) & M80;
    const t = Number((k >> 76n) & 0xfn);
    k = (k & ((1n << 76n) - 1n)) | (BigInt(S[t]) << 76n);
    k ^= (BigInt(i) << sh);
  }
  return rk;
}

function enc(pt, key, sh, rounds = 31) {
  const rk = ks(key, sh);
  let s = pt;
  for (let i = 0; i < rounds; i++) {
    s = (s ^ rk[i]) & M64;
    let o = 0n;
    for (let j = 15; j >= 0; j--) o = (o << 4n) | BigInt(S[Number((s >> BigInt(4 * j)) & 0xfn)]);
    s = o & M64;
    s = perm(s, P1);
  }
  return (s ^ rk[rounds]) & M64;
}

const vectors = [
  [0n, 0n, '5579c1387b22b4c5'],
  [0n, (1n << 64n) - 1n, 'e72c46c0f5945049'],
  [(1n << 80n) - 1n, 0n, 'a112ffc72f68417b'],
  [(1n << 80n) - 1n, (1n << 64n) - 1n, '3333dcd3213210d2'],
];

for (const sh of [15n, 62n]) {
  console.log(`shift=${sh}`);
  let ok = 0;
  for (const [k, pt, want] of vectors) {
    const ct = enc(pt, k, sh).toString(16).padStart(16, '0');
    const hit = ct === want;
    if (hit) ok++;
    console.log(`   key=${k.toString(16).slice(0, 4)} pt=${pt.toString(16).slice(0, 4)} → ${ct}${hit ? '  MATCH' : '  期望 ' + want}`);
  }
  console.log(`   命中 ${ok}/4`);
}
