/* 探针：束宽/起点数/分支上限对逼近程度的影响 */
import { SBoxLibrary } from '../src/core/sboxlib.js';
import { spnProfile } from '../src/core/spnprofile.js';
import { MODE } from '../src/core/analysis.js';

new SBoxLibrary();

const sweep = (cipher, rounds, label, params) => {
  const t0 = performance.now();
  const res = spnProfile({ cipher, mode: MODE.DIFFERENTIAL, rounds, startRound: 1, endRound: rounds, onLog: () => {}, ...params });
  const ms = performance.now() - t0;
  const last = res.perRound[res.perRound.length - 1];
  console.log(`  ${label.padEnd(46)} ${String(last.round).padStart(2)} 轮 →
   活跃 ${String(last.cumActive).padStart(3)} 盒  权重 ${last.weight.toFixed(2).padStart(7)}  [${ms.toFixed(0)}ms]`);
  return res;
};

console.log('PRESENT-64 14 轮（文献最优 2^-62 = 31 盒，Wang 2008）');
for (const p of [
  { },
  { beamWidth: 64 },
  { beamWidth: 256 },
  { beamWidth: 256, startVariants: 15, branchLimit: 6 },
  { beamWidth: 1024, startVariants: 15, branchLimit: 8, perCellBeam: 32 },
]) sweep('present', 14, `beam=${p.beamWidth ?? 16} start=${p.startVariants ?? 3} br=${p.branchLimit ?? 4}`, p);

console.log('\nPRESENT-64 16 轮（攻击用到 14 轮特征 + 2 轮）');
for (const p of [{ beamWidth: 256, startVariants: 15, branchLimit: 6 }]) sweep('present', 16, 'beam=256 start=15 br=6', p);

console.log('\nAES-128 4 轮（wide-trail 下界 25 盒 = 2^-150）');
for (const p of [
  { },
  { beamWidth: 64, startVariants: 6 },
  { beamWidth: 256, startVariants: 10, branchLimit: 8, perCellBeam: 24 },
]) sweep('aes', 4, `beam=${p.beamWidth ?? 16} start=${p.startVariants ?? 3}`, p);

console.log('\nAES-128 6 轮（下界 30 盒 = 2^-180）');
for (const p of [
  { beamWidth: 64 },
  { beamWidth: 256, startVariants: 10, branchLimit: 8, perCellBeam: 24 },
]) sweep('aes', 6, `beam=${p.beamWidth ?? 16}`, p);

// 3 轮 AES 是否真能低于 21 盒：完全放开分支，穷举全部单字节起点
console.log('\nAES-128 3 轮：放开分支限制（branchLimit=0 全枚举，startVariants=255 全覆盖）');
sweep('aes', 3, 'br=0 start=255 perCell=64 beam=4', {
  branchLimit: 0, startVariants: 255, perCellBeam: 64, beamWidth: 4,
});
