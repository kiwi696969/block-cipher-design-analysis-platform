import { SBoxLibrary } from '../src/core/sboxlib.js';
import { spnProfile } from '../src/core/spnprofile.js';
import { MODE } from '../src/core/analysis.js';

new SBoxLibrary();
for (const p of [
  { beamWidth: 256, startVariants: 3, branchLimit: 4 },
  { beamWidth: 512, startVariants: 3, branchLimit: 4 },
  { beamWidth: 1024, startVariants: 3, branchLimit: 4 },
  { beamWidth: 512, startVariants: 3, branchLimit: 6 },
]) {
  const t0 = performance.now();
  const r = spnProfile({ cipher: 'present', mode: MODE.DIFFERENTIAL, rounds: 14, onLog: () => {}, ...p });
  const last = r.perRound[13];
  const ms = (performance.now() - t0).toFixed(0);
  console.log('beam=' + p.beamWidth + ' start=' + p.startVariants + ' br=' + p.branchLimit
    + ' -> ' + last.cumActive + ' 盒 ' + last.weight.toFixed(2) + '  ' + ms + 'ms');
}
