/* 探针：选定默认束宽（耗时 vs 逼近程度） */
import { SBoxLibrary } from '../src/core/sboxlib.js';
import { spnProfile } from '../src/core/spnprofile.js';
import { MODE } from '../src/core/analysis.js';

new SBoxLibrary();

const t = (cipher, rounds, p) => {
  const t0 = performance.now();
  const r = spnProfile({ cipher, mode: MODE.DIFFERENTIAL, rounds, onLog: () => {}, ...p });
  const ms = performance.now() - t0;
  return { ms, boxes: r.perRound[r.perRound.length - 1].cumActive, w: r.perRound[r.perRound.length - 1].weight.toFixed(2) };
};

console.log('PRESENT 14 轮（快，尽量上束宽）');
for (const beam of [32, 64, 128, 256, 512]) {
  const r = t('present', 14, { beamWidth: beam, startVariants: 15, branchLimit: 6 });
  console.log(`   beam=${String(beam).padStart(3)}  ${r.boxes} 盒  ${r.w.padStart(7)}  ${r.ms.toFixed(0)}ms`);
}
console.log('\nPRESENT 31 轮');
for (const beam of [32, 128, 256]) {
  const r = t('present', 31, { beamWidth: beam, startVariants: 15, branchLimit: 6 });
  console.log(`   beam=${String(beam).padStart(3)}  ${r.boxes} 盒  ${r.w.padStart(7)}  ${r.ms.toFixed(0)}ms`);
}

console.log('\nAES 10 轮');
for (const beam of [16, 32, 64, 128]) {
  const r = t('aes', 10, { beamWidth: beam, startVariants: 3, branchLimit: 4 });
  console.log(`   beam=${String(beam).padStart(3)}  ${r.boxes} 盒  ${r.w.padStart(7)}  ${r.ms.toFixed(0)}ms`);
}
console.log('\nAES 4 轮');
for (const beam of [32, 64, 128, 256]) {
  const r = t('aes', 4, { beamWidth: beam, startVariants: 6, branchLimit: 6 });
  console.log(`   beam=${String(beam).padStart(3)}  ${r.boxes} 盒  ${r.w.padStart(7)}  ${r.ms.toFixed(0)}ms`);
}
