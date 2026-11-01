/* 探针：AES-128 / PRESENT-64 束搜索逐轮结果（差分 + 线性） */
import { SBoxLibrary } from '../src/core/sboxlib.js';
import { spnProfile } from '../src/core/spnprofile.js';
import { MODE } from '../src/core/analysis.js';

new SBoxLibrary();

const run = (cipher, rounds, mode) => {
  const t0 = performance.now();
  const res = spnProfile({
    cipher, mode, rounds, startRound: 1, endRound: rounds,
    onLog: () => {},
  });
  const ms = performance.now() - t0;
  const rows = res.perRound.map((p) => `R${p.round}:${p.activeCells}盒/${p.weight.toFixed(2)}`);
  console.log(`${cipher.padEnd(8)} ${mode.padEnd(12)} ${rows.join('  ')}   [${ms.toFixed(0)}ms]`);
  return res;
};

console.log('=== AES-128 差分 ===');
for (const r of [1, 2, 3, 4, 5, 6, 8, 10]) run('aes', r, MODE.DIFFERENTIAL);

console.log('\n=== AES-128 线性 ===');
for (const r of [1, 2, 4, 6]) run('aes', r, MODE.LINEAR);

console.log('\n=== PRESENT-64 差分 ===');
for (const r of [1, 2, 3, 4, 6, 8, 10, 14, 16]) run('present', r, MODE.DIFFERENTIAL);

console.log('\n=== PRESENT-64 线性 ===');
for (const r of [1, 2, 4, 8]) run('present', r, MODE.LINEAR);

// 4 轮 AES 的具体特征
const a4 = spnProfile({ cipher: 'aes', mode: MODE.DIFFERENTIAL, rounds: 4, onLog: () => {} });
console.log('\nAES 4 轮：活跃盒', a4.best.activeSboxes, '权重', a4.best.weight.toFixed(2));
console.log('  输入差分', a4.best.inputState.join(' '));
console.log('  输出差分', a4.best.outputState.map((v) => v.toString(16).padStart(2, '0')).join(' '));
console.log('  逐轮活跃', a4.perRound.map((p) => p.activeCells).join('/'));
