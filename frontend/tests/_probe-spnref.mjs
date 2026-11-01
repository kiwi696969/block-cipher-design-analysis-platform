/* 参考实现冒烟：AES-128 / PRESENT-64 官方向量 + 掩码层对偶自检 */
import {
  aesEncrypt, aesKeySchedule128, bytesToHex, hexToBytes,
  presentEncrypt, presentKeySchedule80, presentNibblesToHex, bigToPresentNibbles,
  SPN_CIPHERS, selfCheck, PRESENT_SBOX, AES_SBOX,
} from '../src/core/spnref.js';

let pass = 0; const fails = [];
const eq = (name, got, want) => {
  if (String(got).toLowerCase() === String(want).toLowerCase()) { pass++; console.log(`  ok  ${name}`); }
  else { fails.push(`${name}: 期望 ${want} 实得 ${got}`); console.log(`  !!  ${name}: 期望 ${want} 实得 ${got}`); }
};

console.log('== AES-128 FIPS-197 向量 ==');
eq('C.1 加密',
  bytesToHex(aesEncrypt(hexToBytes('00112233445566778899aabbccddeeff'),
    hexToBytes('000102030405060708090a0b0c0d0e0f'))),
  '69c4e0d86a7b0430d8cdb78070b4c55a');

// 轮密钥首尾抽检（FIPS-197 附录 A.1）
const rk = aesKeySchedule128(hexToBytes('2b7e151628aed2a6abf7158809cf4f3c'));
eq('A.1 w[0..3]', bytesToHex(rk[0]), '2b7e151628aed2a6abf7158809cf4f3c');
eq('A.1 w[40..43] (rk10)', bytesToHex(rk[10]), 'd014f9a8c9ee2589e13f0cc8b6630ca6');

console.log('== PRESENT-80 官方向量 ==');
eq('key=0 pt=0', presentNibblesToHex(presentEncrypt(new Array(16).fill(0), 0n)), '5579c1387b228445');
eq('key=0 pt=ff', presentNibblesToHex(presentEncrypt(new Array(16).fill(0xf), 0n)), 'a112ffc72f68417b');
eq('key=ff pt=0',
  presentNibblesToHex(presentEncrypt(new Array(16).fill(0),
    (1n << 80n) - 1n)), 'e72c46c0f5945049');
eq('key=ff pt=ff',
  presentNibblesToHex(presentEncrypt(new Array(16).fill(0xf),
    (1n << 80n) - 1n)), '3333dcd3213210d2');

console.log('== 掩码层 / 差分层的对偶关系 ==');
for (const id of ['aes', 'present']) {
  const r = selfCheck(id, { trials: 96 });
  console.log(`  ${r.ok ? 'ok ' : '!! '} ${r.detail}`);
  if (r.ok) pass++; else fails.push(r.detail);
}

console.log('== S 盒基本量 ==');
for (const [id, tbl, bits] of [['aes', AES_SBOX, 8], ['present', PRESENT_SBOX, 4]]) {
  const n = 1 << bits;
  let maxDdt = 0;
  for (let a = 1; a < n; a++) {
    const cnt = new Array(n).fill(0);
    for (let x = 0; x < n; x++) cnt[tbl[x] ^ tbl[x ^ a]]++;
    maxDdt = Math.max(maxDdt, ...cnt);
  }
  console.log(`  ${id}: 差分均匀度 ${maxDdt}（单盒最大概率 2^-${Math.log2(n / maxDdt)}）`);
  eq(`${id} 差分均匀度`, maxDdt, id === 'aes' ? 4 : 4);
}

console.log(`\n通过 ${pass}，失败 ${fails.length}`);
if (fails.length) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
